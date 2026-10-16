import { prisma } from '../../lib/prisma.ts';
import type { PlanCheckoutOrder } from '../../generated/prisma/client.ts';
import type { PlanCheckout } from '../../contracts/plan.ts';
import { PlanError } from './plan-error.ts';
import { assertTestCheckout, paymongoTestRequest, PaymongoTestError, safeTestCheckoutUrl } from './paymongo-test-provider.ts';

const conflict = () => new PlanError('PayMongo payment details did not match this test order. Plus was not activated.', 409, 'CONFLICT');
export const checkoutView = (order: PlanCheckoutOrder): PlanCheckout => ({ id: order.id, status: order.status, amount: order.amount, currency: order.currency, durationDays: order.durationDays,
  checkoutUrl: order.status === 'pending' ? order.checkoutUrl : null, lastError: order.lastError, fulfilledAt: order.fulfilledAt?.toISOString() ?? null, mode: 'test' });

async function ownOrder(userId: string, id: string) {
  const order = await prisma.planCheckoutOrder.findFirst({ where: { id, userId } });
  if (!order) throw new PlanError('Test checkout not found.', 404, 'NOT_FOUND');
  return order;
}
export async function latestTestCheckout(userId: string) {
  const order = await prisma.planCheckoutOrder.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return order ? checkoutView(order) : null;
}

export async function createTestCheckout(userId: string, key: string) {
  const config = assertTestCheckout();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new PlanError('A persistent checkout request key is required.', 400, 'BAD_REQUEST');
  const reserved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    const existing = await tx.planCheckoutOrder.findFirst({ where: { userId, OR: [{ idempotencyKey: key }, { status: { in: ['creating', 'pending'] } }] }, orderBy: { createdAt: 'desc' } });
    if (existing) return { order: existing, start: false };
    const subscription = await tx.planSubscription.findUnique({ where: { userId } });
    if (subscription && subscription.startsAt <= new Date() && subscription.expiresAt > new Date()) throw new PlanError('Plus is already active. Your current allowance and expiry are unchanged.', 409, 'CONFLICT');
    const order = await tx.planCheckoutOrder.create({ data: { userId, idempotencyKey: key, amount: config.amount, currency: config.currency, durationDays: config.durationDays } });
    return { order, start: true };
  });
  if (!reserved.start) return checkoutView(reserved.order);
  const order = reserved.order;
  try {
    // v1 creates a stable Payment Intent with the session, allowing the existing
    // payment.paid/payment.failed webhooks to find their exact server-side order.
    const session = await paymongoTestRequest('checkout_sessions', 'POST', { data: { attributes: {
      line_items: [{ name: 'TravelMate Demo Plus — TEST ONLY', amount: order.amount, currency: order.currency, quantity: 1 }],
      payment_method_types: ['card'], send_email_receipt: false, show_description: true, show_line_items: true,
      description: `Test payment — no real money charged. ${order.durationDays} days of demo Plus. Demo values only, not final live pricing.`, reference_number: order.id,
      metadata: { order_id: order.id, user_id: userId, plan: 'demo-plus', duration_days: String(order.durationDays) },
      success_url: `${config.origin}/dashboard?tab=plan&checkout=success&order=${order.id}`,
      cancel_url: `${config.origin}/dashboard?tab=plan&checkout=cancelled&order=${order.id}`,
    } } });
    validateSession(order, session, true);
    const saved = await prisma.planCheckoutOrder.update({ where: { id: order.id }, data: { status: 'pending', sessionId: session.id, paymentIntentId: session.attributes.payment_intent.id, checkoutUrl: safeTestCheckoutUrl(session.attributes.checkout_url), lastError: null } });
    return checkoutView(saved);
  } catch (error) {
    const confirmedRejected = error instanceof PaymongoTestError && [400, 401, 403, 422, 429].includes(error.status);
    // Ambiguous provider/database failures never start another checkout blindly.
    await prisma.planCheckoutOrder.updateMany({ where: { id: order.id, status: 'creating' }, data: { ...(confirmedRejected ? { status: 'failed' } : {}), lastError: confirmedRejected ? 'PROVIDER_REJECTED' : 'CHECKOUT_UNCERTAIN' } }).catch(() => undefined);
    throw error;
  }
}

function validateSession(order: PlanCheckoutOrder, session: any, creating = false) {
  const a = session?.attributes, pi = a?.payment_intent;
  if (session?.type !== 'checkout_session' || !/^cs_[A-Za-z0-9]+$/.test(session.id || '') || a?.livemode !== false
    || (!creating && session.id !== order.sessionId) || a.reference_number !== order.id
    || a.metadata?.order_id !== order.id || a.metadata?.user_id !== order.userId || a.metadata?.plan !== 'demo-plus' || a.metadata?.duration_days !== String(order.durationDays)
    || !Array.isArray(a.line_items) || a.line_items.length !== 1 || a.line_items[0].amount !== order.amount || a.line_items[0].currency !== order.currency || a.line_items[0].quantity !== 1
    || pi?.type !== 'payment_intent' || !/^pi_[A-Za-z0-9]+$/.test(pi.id || '') || (!creating && pi.id !== order.paymentIntentId)
    || pi.attributes?.livemode !== false || pi.attributes.amount !== order.amount || pi.attributes.currency !== order.currency) throw conflict();
}

async function fulfill(order: PlanCheckoutOrder, paymentId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${order.userId} FOR UPDATE`;
    const fresh = await tx.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (fresh.status === 'paid') return fresh;
    if (fresh.sessionId !== order.sessionId || fresh.paymentIntentId !== order.paymentIntentId) throw conflict();
    const now = new Date(), existing = await tx.planSubscription.findUnique({ where: { userId: order.userId } });
    const expiresAt = new Date(Math.max(now.getTime() + order.durationDays * 86400000, existing?.expiresAt.getTime() ?? 0));
    // Test payments can never replace an existing verified paid entitlement.
    if (existing?.source !== 'verified_payment') {
      const data = { source: 'paymongo_test' as const, activationKey: 'paymongo-test:' + order.id, actorId: null, reason: 'Verified PayMongo TEST payment; demo entitlement only.', startsAt: now, expiresAt };
      await tx.planSubscription.upsert({ where: { userId: order.userId }, create: { userId: order.userId, ...data }, update: data });
    }
    const paid = await tx.planCheckoutOrder.update({ where: { id: order.id }, data: { status: 'paid', paymentId, fulfilledAt: now, lastError: null } });
    await tx.auditEvent.create({ data: { actorId: order.userId, targetId: order.id, action: 'plan:paymongo-test-verified:' + paymentId } });
    return paid;
  });
}

async function inspectSession(order: PlanCheckoutOrder, session: any) {
  validateSession(order, session);
  const a = session.attributes, paid = Array.isArray(a.payments) ? a.payments.filter((payment: any) => payment.attributes?.status === 'paid') : [];
  if (paid.length > 1) throw conflict();
  if (paid.length === 1) {
    const id = paid[0].id;
    if (!/^pay_[A-Za-z0-9]+$/.test(id) || a.payment_intent.attributes.status !== 'succeeded') throw conflict();
    const payment = await paymongoTestRequest('payments/' + encodeURIComponent(id));
    const p = payment.attributes;
    if (payment.id !== id || payment.type !== 'payment' || p?.status !== 'paid' || p.livemode !== false || p.amount !== order.amount || p.currency !== order.currency || p.payment_intent_id !== order.paymentIntentId) throw conflict();
    return fulfill(order, id);
  }
  if (order.status === 'paid') return order; // Late failed/cancelled notifications never undo verified payment.
  if (a.status === 'expired') return prisma.planCheckoutOrder.updateMany({ where: { id: order.id, status: { in: ['pending', 'creating'] } }, data: { status: 'expired', lastError: null } }).then(() => prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } }));
  const failed = !!a.payment_intent.attributes.last_payment_error || (Array.isArray(a.payments) && a.payments.some((payment: any) => payment.attributes?.status === 'failed'));
  if (failed) await prisma.planCheckoutOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { lastError: 'PAYMENT_FAILED' } });
  return prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
}

export async function verifyTestCheckout(userId: string, id: string) {
  assertTestCheckout();
  const order = await ownOrder(userId, id);
  if (!order.sessionId || order.status === 'paid') return checkoutView(order);
  const session = await paymongoTestRequest('checkout_sessions/' + encodeURIComponent(order.sessionId));
  return checkoutView(await inspectSession(order, session));
}

export async function cancelTestCheckout(userId: string, id: string) {
  assertTestCheckout();
  const order = await ownOrder(userId, id);
  if (['paid', 'cancelled', 'expired', 'failed'].includes(order.status)) return checkoutView(order);
  if (!order.sessionId) throw new PlanError('Checkout creation is still being reconciled. A replacement cannot start yet.', 409, 'CONFLICT');
  const current = await inspectSession(order, await paymongoTestRequest('checkout_sessions/' + encodeURIComponent(order.sessionId)));
  if (current.status === 'paid') return checkoutView(current);
  if (current.status !== 'expired') {
    try {
      const expired = await paymongoTestRequest('checkout_sessions/' + encodeURIComponent(order.sessionId) + '/expire', 'POST');
      validateSession(order, expired);
      if (expired.attributes.status !== 'expired') throw conflict();
      const result = await inspectSession(order, expired);
      if (result.status === 'paid') return checkoutView(result);
    } catch (error) {
      const checked = await verifyTestCheckout(userId, id);
      if (checked.status === 'paid') return checked;
      if (checked.status !== 'expired') throw error;
    }
  }
  await prisma.planCheckoutOrder.updateMany({ where: { id, status: 'expired' }, data: { status: 'cancelled' } });
  return checkoutView(await ownOrder(userId, id));
}

export async function processTestPaymentEvent(type: string, resource: any) {
  assertTestCheckout();
  if (type === 'checkout_session.payment.paid' && /^cs_[A-Za-z0-9]+$/.test(resource?.id ?? '')) {
    const order = await prisma.planCheckoutOrder.findUnique({ where: { sessionId: resource.id } });
    if (!order) return 'ignored';
    await verifyTestCheckout(order.userId, order.id); return 'verified';
  }
  if (!['payment.paid', 'payment.failed'].includes(type) || !/^pay_[A-Za-z0-9]+$/.test(resource?.id ?? '')) return 'ignored';
  let payment;
  try { payment = await paymongoTestRequest('payments/' + encodeURIComponent(resource.id)); }
  catch (error) { if (error instanceof PaymongoTestError && error.status === 404) return 'ignored'; throw error; }
  if (payment.id !== resource.id || payment.type !== 'payment' || payment.attributes?.livemode !== false || !/^pi_[A-Za-z0-9]+$/.test(payment.attributes.payment_intent_id ?? '')) return 'ignored';
  const order = await prisma.planCheckoutOrder.findUnique({ where: { paymentIntentId: payment.attributes.payment_intent_id } });
  if (!order) return 'ignored';
  await verifyTestCheckout(order.userId, order.id); return 'verified';
}
