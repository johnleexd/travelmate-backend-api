import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { isolatedPlanDatabase } from '../helpers/isolated-plan-db.ts';

test('PayMongo demo checkout uses isolated PostgreSQL and mocked provider HTTP responses', async t => {
  const db = await isolatedPlanDatabase(), prisma = db.client;
  const { default: app } = await import('../../src/app.ts');
  const plans = await import('../../src/services/plans/plan-service.ts');
  const checkout = await import('../../src/services/plans/test-checkout-service.ts');
  const { createSessionToken } = await import('../../src/middlewares/auth-middleware.ts');
  const { testCheckoutConfiguration } = await import('../../src/services/plans/paymongo-test-provider.ts');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const base = `http://127.0.0.1:${address.port}`, nativeFetch = globalThis.fetch;
  const keys = ['PAYMONGO_TEST_CHECKOUT_ENABLED', 'PAYMONGO_TEST_AMOUNT_CENTAVOS', 'PAYMONGO_TEST_PLUS_DAYS', 'PAYMONGO_TEST_RETURN_ORIGIN', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET', 'NODE_ENV'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { PAYMONGO_TEST_CHECKOUT_ENABLED: 'true', PAYMONGO_TEST_AMOUNT_CENTAVOS: '10000', PAYMONGO_TEST_PLUS_DAYS: '30', PAYMONGO_TEST_RETURN_ORIGIN: 'http://localhost:3000', PAYMONGO_SECRET_KEY: 'sk_test_isolated_fixture', PAYMONGO_WEBHOOK_SECRET: 'whsk_isolated_fixture', NODE_ENV: 'test' });
  const sessions = new Map<string, any>(), payments = new Map<string, any>();
  let creations = 0, rejectCreation = false, dropCreationResponse = false, unavailable = false, payDuringCancel = false;
  const user = () => prisma.user.create({ data: { name: 'Isolated checkout test', email: randomUUID() + '@example.test', role: 'traveler', emailVerified: true } });
  const http = (userId: string | null, path: string, body?: unknown, key = randomUUID()) => nativeFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(userId ? { cookie: 'travelmate_session=' + createSessionToken(userId, 'traveler') } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const start = async (userId: string) => {
    const response = await http(userId, '/api/plan/checkout', {}), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value.order;
  };
  const pay = (id: string, overrides = {}) => {
    const session = sessions.get(id), paymentId = 'pay_' + randomUUID().replaceAll('-', '');
    const payment = { id: paymentId, type: 'payment', attributes: { status: 'paid', livemode: false, amount: session.attributes.line_items[0].amount, currency: 'PHP', payment_intent_id: session.attributes.payment_intent.id, ...overrides } };
    payments.set(paymentId, payment); session.attributes.payments = [structuredClone(payment)]; session.attributes.payment_intent.attributes.status = 'succeeded';
    return payment;
  };
  const webhook = async (type: string, resource: unknown, live = false) => {
    const body = JSON.stringify({ data: { id: 'evt_' + randomUUID().replaceAll('-', ''), type: 'event', attributes: { type, livemode: live, data: resource } } });
    const time = Math.floor(Date.now() / 1000), digest = createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(time + '.' + body).digest('hex');
    return nativeFetch(base + '/api/webhooks/paymongo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': `t=${time},te=${digest},li=` }, body });
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); if (url.hostname !== 'api.paymongo.com') throw new Error('Unexpected external request');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from('sk_test_isolated_fixture:').toString('base64'));
    if (unavailable) return Response.json({ errors: [{ code: 'temporary_failure' }] }, { status: 503 });
    const path = url.pathname.split('/'), id = path[3];
    if (path[2] === 'checkout_sessions' && init?.method === 'POST' && !id) {
      creations++; if (rejectCreation) return Response.json({ errors: [{ code: 'parameter_invalid' }] }, { status: 400 });
      const data = JSON.parse(String(init.body)).data.attributes;
      assert.equal(data.payment_method_types[0], 'card'); assert.equal(data.send_email_receipt, false);
      const sessionId = 'cs_' + randomUUID().replaceAll('-', ''), pi = 'pi_' + randomUUID().replaceAll('-', '');
      const session = { id: sessionId, type: 'checkout_session', attributes: { ...data, checkout_url: 'https://checkout.paymongo.com/' + sessionId, livemode: false, status: 'active', payments: [], payment_intent: { id: pi, type: 'payment_intent', attributes: { livemode: false, amount: data.line_items[0].amount, currency: 'PHP', status: 'awaiting_payment_method', last_payment_error: null } } } };
      sessions.set(sessionId, session);
      if (dropCreationResponse) throw new Error('Simulated connection loss after provider creation');
      return Response.json({ data: session });
    }
    if (path[2] === 'checkout_sessions') {
      const session = sessions.get(id); if (!session) return Response.json({}, { status: 404 });
      if (path[4] === 'expire') {
        if (payDuringCancel) { payDuringCancel = false; pay(id); return Response.json({ errors: [{ code: 'already_paid' }] }, { status: 400 }); }
        session.attributes.status = 'expired';
      }
      return Response.json({ data: session });
    }
    if (path[2] === 'payments') return payments.has(id) ? Response.json({ data: payments.get(id) }) : Response.json({}, { status: 404 });
    throw new Error('Unexpected provider path');
  });
  try {
    await t.test('only test credentials, explicit enablement and local returns are permitted', () => {
      assert.equal(testCheckoutConfiguration().enabled, true);
      for (const patch of [{ NODE_ENV: 'production' }, { PAYMONGO_SECRET_KEY: 'sk_live_rejected' }, { PAYMONGO_TEST_CHECKOUT_ENABLED: 'false' }, { PAYMONGO_TEST_RETURN_ORIGIN: 'https://attacker.example' }, { PAYMONGO_TEST_AMOUNT_CENTAVOS: '1' }]) assert.equal(testCheckoutConfiguration({ ...process.env, ...patch }).enabled, false);
    });
    await t.test('unauthenticated, cross-user and client price/user overrides are rejected', async () => {
      assert.equal((await http(null, '/api/plan/checkout', {})).status, 401);
      const owner = await user(), other = await user();
      assert.equal((await http(owner.id, '/api/plan/checkout', { amount: 1, userId: other.id })).status, 400);
      const order = await start(owner.id);
      assert.equal((await http(other.id, `/api/plan/checkouts/${order.id}/verify`, {})).status, 404);
      assert.equal((await http(other.id, `/api/plan/checkouts/${order.id}/cancel`, {})).status, 404);
      const returned = await checkout.latestTestCheckout(owner.id); assert.equal(returned?.amount, 10000); assert.equal(returned?.currency, 'PHP');
    });
    await t.test('concurrent tabs and repeated clicks create only one provider session', async () => {
      const owner = await user(), before = creations;
      const results = await Promise.all(Array.from({ length: 6 }, () => start(owner.id)));
      assert.equal(creations - before, 1); assert.equal(new Set(results.map(value => value.id)).size, 1);
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
    });
    await t.test('success redirect alone and synthetic connectivity events cannot activate Plus', async () => {
      const owner = await user(), order = await start(owner.id);
      assert.equal((await http(owner.id, `/api/plan/checkouts/${order.id}/verify?checkout=success`, {})).status, 200);
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
      assert.equal((await webhook('payment.paid', { id: 'synthetic_connectivity_check' })).status, 200);
      assert.equal((await webhook('payment.paid', { id: 'pay_unknown' })).status, 200);
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
    });
    await t.test('real provider-confirmed test payment grants demo Plus once and preserves quota usage', async () => {
      const owner = await user();
      const operation = await plans.reserveGeneration(owner.id, 'Tokyo', { destination: 'Tokyo' }, randomUUID());
      assert.ok('recordId' in operation); await plans.persistGeneration(operation.recordId, operation.attemptId, { result: 'existing generation' });
      const before = await plans.getPlan(owner.id), order = await start(owner.id), stored = await prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
      const payment = pay(stored.sessionId!);
      assert.equal((await webhook('payment.paid', payment)).status, 200);
      const first = await prisma.planSubscription.findUniqueOrThrow({ where: { userId: owner.id } });
      assert.equal(first.source, 'paymongo_test'); assert.ok(first.expiresAt.getTime() >= Date.now() + 29 * 86400000);
      await Promise.all([webhook('payment.paid', payment), webhook('payment.failed', payment), http(owner.id, `/api/plan/checkouts/${order.id}/verify`, {})]);
      const after = await plans.getPlan(owner.id), duplicate = await prisma.planSubscription.findUniqueOrThrow({ where: { userId: owner.id } });
      assert.equal(after.plan, 'Plus'); assert.equal(after.allowance, 30); assert.equal(after.used, before.used); assert.equal(after.remaining, 29); assert.equal(after.resetsAt, before.resetsAt);
      assert.equal(duplicate.expiresAt.getTime(), first.expiresAt.getTime());
      assert.equal(await prisma.auditEvent.count({ where: { targetId: order.id } }), 1);
    });
    await t.test('wrong amount, currency, owner, plan, order, status, session, intent or live mode never activates Plus', async () => {
      const owner = await user(), order = await start(owner.id), stored = await prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
      const session = sessions.get(stored.sessionId!), payment = pay(session.id), good = structuredClone(session), goodPayment = structuredClone(payment);
      const edits = [
        () => { session.attributes.line_items[0].amount = 1; }, () => { session.attributes.line_items[0].currency = 'USD'; },
        () => { session.attributes.metadata.user_id = 'another-user'; }, () => { session.attributes.metadata.order_id = randomUUID(); },
        () => { session.attributes.metadata.plan = 'another-plan'; }, () => { session.attributes.reference_number = randomUUID(); },
        () => { session.attributes.livemode = true; }, () => { session.id = 'cs_wrong'; },
        () => { session.attributes.payment_intent.id = 'pi_wrong'; }, () => { session.attributes.payment_intent.attributes.status = 'processing'; },
        () => { payment.attributes.amount = 1; }, () => { payment.attributes.currency = 'USD'; },
        () => { payment.attributes.payment_intent_id = 'pi_wrong'; }, () => { payment.attributes.livemode = true; }, () => { payment.attributes.status = 'pending'; },
      ];
      for (const edit of edits) {
        Object.assign(session, structuredClone(good)); Object.assign(payment, structuredClone(goodPayment)); edit();
        await assert.rejects(() => checkout.verifyTestCheckout(owner.id, order.id), { code: 'CONFLICT' });
        assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
      }
      Object.assign(session, good); Object.assign(payment, goodPayment);
      assert.equal((await webhook('payment.paid', payment, true)).status, 400);
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
    });
    await t.test('failed attempts remain unpaid and retry the original checkout; cancellation expires it first', async () => {
      const owner = await user(), order = await start(owner.id), stored = await prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
      const session = sessions.get(stored.sessionId!); session.attributes.payment_intent.attributes.last_payment_error = { code: 'card_declined' };
      const checked = await checkout.verifyTestCheckout(owner.id, order.id); assert.equal(checked.status, 'pending'); assert.equal(checked.lastError, 'PAYMENT_FAILED');
      const before = creations; assert.equal((await start(owner.id)).id, order.id); assert.equal(creations, before);
      const cancelled = await checkout.cancelTestCheckout(owner.id, order.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(session.attributes.status, 'expired');
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free'); assert.notEqual((await start(owner.id)).id, order.id);
    });
    await t.test('payment winning a cancellation race is verified and granted exactly once', async () => {
      const owner = await user(), order = await start(owner.id); payDuringCancel = true;
      assert.equal((await checkout.cancelTestCheckout(owner.id, order.id)).status, 'paid'); assert.equal((await plans.getPlan(owner.id)).source, 'paymongo_test');
    });
    await t.test('provider failures do not grant Plus or create duplicate ambiguous checkouts', async () => {
      const owner = await user(); rejectCreation = true;
      assert.equal((await http(owner.id, '/api/plan/checkout', {})).status, 503); rejectCreation = false;
      assert.equal((await prisma.planCheckoutOrder.findFirstOrThrow({ where: { userId: owner.id } })).status, 'failed');
      const order = await start(owner.id); unavailable = true;
      assert.equal((await http(owner.id, `/api/plan/checkouts/${order.id}/verify`, {})).status, 503); unavailable = false;
      assert.equal((await plans.getPlan(owner.id)).plan, 'Free');
      const uncertainOwner = await user(); dropCreationResponse = true; const before = creations;
      assert.equal((await http(uncertainOwner.id, '/api/plan/checkout', {})).status, 503); dropCreationResponse = false;
      const retry = await start(uncertainOwner.id); assert.equal(retry.status, 'creating'); assert.equal(creations, before + 1);
    });
    await t.test('an existing verified paid entitlement cannot be replaced by a delayed test payment', async () => {
      const owner = await user(), order = await start(owner.id), stored = await prisma.planCheckoutOrder.findUniqueOrThrow({ where: { id: order.id } });
      const expiry = new Date(Date.now() + 90 * 86400000);
      await prisma.planSubscription.create({ data: { userId: owner.id, source: 'verified_payment', activationKey: randomUUID(), expiresAt: expiry } });
      pay(stored.sessionId!); assert.equal((await checkout.verifyTestCheckout(owner.id, order.id)).status, 'paid');
      const subscription = await prisma.planSubscription.findUniqueOrThrow({ where: { userId: owner.id } });
      assert.equal(subscription.source, 'verified_payment'); assert.equal(subscription.expiresAt.getTime(), expiry.getTime());
    });
  } finally {
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
  }
});
