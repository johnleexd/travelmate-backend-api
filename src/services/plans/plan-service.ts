import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.ts';
import { Prisma } from '../../generated/prisma/client.ts';
import { allowancePeriod, PLAN_TIMEZONE, planConfiguration, RESERVATION_LEASE_MS } from './plan-policy.ts';
import type { PlanUsage } from '../../contracts/plan.ts';
import { PlanError } from './plan-error.ts';
import { testCheckoutConfiguration } from './paymongo-test-provider.ts';
export { PlanError } from './plan-error.ts';

type Transaction = Prisma.TransactionClient;
const active = ['reserved', 'processing'] as const;
async function lockUser(tx: Transaction, userId: string) {
  // Every quota/subscription mutation takes the same row lock, across all instances.
  const users = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
  if (!users.length) throw new PlanError('Authentication required.', 401, 'AUTHENTICATION_REQUIRED');
}
async function reconcile(tx: Transaction, userId: string, now: Date) {
  // Never resubmit a provider request after a lost response. A fenced worker cannot
  // persist after its lease. The lease exceeds the bounded provider deadline.
  await tx.itineraryGeneration.updateMany({
    where: { userId, allowanceState: { in: [...active] }, reservedUntil: { lte: now } },
    data: { status: 'failed', allowanceState: 'reconciled', charged: false, errorCode: 'INTERRUPTED' },
  });
}
async function usage(tx: Transaction, userId: string, now: Date): Promise<PlanUsage> {
  const period = allowancePeriod(now), config = planConfiguration();
  const [subscription, tracking, used, reserved, inProgress, recentOperations] = await Promise.all([
    tx.planSubscription.findUnique({ where: { userId } }),
    tx.generationTracking.findUniqueOrThrow({ where: { id: 'monthly-v1' } }),
    tx.itineraryGeneration.count({ where: { userId, allowancePeriod: period.start, charged: true } }),
    tx.itineraryGeneration.count({ where: { userId, allowancePeriod: period.start, allowanceState: { in: [...active] } } }),
    tx.itineraryGeneration.findFirst({ where: { userId, allowanceState: { in: [...active] } }, select: { id: true, idempotencyKey: true, allowancePeriod: true, reservedUntil: true } }),
    tx.itineraryGeneration.findMany({ where: { userId, allowancePeriod: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, idempotencyKey: true, destination: true, allowanceState: true, charged: true, createdAt: true, operationKind: true, relatedTripId: true } }),
  ]);
  const plus = !!subscription && subscription.startsAt <= now && subscription.expiresAt > now;
  const allowance = plus ? config.plus : config.free;
  const checkout = testCheckoutConfiguration();
  return {
    plan: plus ? 'Plus' : 'Free', status: plus ? 'active' : subscription && subscription.expiresAt <= now ? 'expired' : 'free',
    source: plus ? subscription!.source : null, expiresAt: plus ? subscription!.expiresAt.toISOString() : null,
    used, reserved, remaining: Math.max(0, allowance - used - reserved), allowance,
    periodStart: period.start.toISOString(), resetsAt: period.end.toISOString(), timezone: PLAN_TIMEZONE,
    trackingStartedAt: tracking.startedAt.toISOString(),
    plans: { free: config.free, plus: config.plus }, provisional: config.provisional,
    checkoutAvailable: checkout.enabled && !plus, pricing: checkout.enabled ? `PHP ${(checkout.amount / 100).toFixed(2)} · test only` : 'Pricing not configured',
    ...(checkout.enabled ? { testCheckout: { amount: checkout.amount, currency: checkout.currency, durationDays: checkout.durationDays } } : {}),
    inProgress: inProgress ? { ...inProgress, allowancePeriod: inProgress.allowancePeriod?.toISOString() ?? null, reservedUntil: inProgress.reservedUntil?.toISOString() ?? null } : null,
    recentOperations: recentOperations.map(operation => ({ ...operation, createdAt: operation.createdAt.toISOString() })),
  };
}
export async function getPlan(userId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await lockUser(tx, userId); await reconcile(tx, userId, now);
    return usage(tx, userId, now);
  });
}
export function stableGenerationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableGenerationJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'idempotencyKey').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableGenerationJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function reserveGeneration(userId: string, destination: string, body: Record<string, unknown>, headerKey: string | null) {
  const idempotencyKey = (headerKey || String(body.idempotencyKey || '')).trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) throw new PlanError('A persistent Idempotency-Key of 8–100 letters, numbers, dots, colons, underscores or hyphens is required.', 400, 'BAD_REQUEST');
  const requestHash = createHash('sha256').update(stableGenerationJson(body)).digest('hex');
  return prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const now = new Date();
    await reconcile(tx, userId, now);
    const previous = await tx.itineraryGeneration.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PlanError('This generation key was already used for different trip details.', 409, 'GENERATION_CONFLICT');
      if (previous.status === 'completed' && previous.response) return { replay: previous.response } as const;
      throw new PlanError(previous.status === 'failed' ? 'This operation ended without an AI result. Start a new generation to retry.' : 'This generation is still in progress. Reconnect to the existing operation.', 409,
        previous.status === 'failed' ? 'GENERATION_ENDED' : 'GENERATION_IN_PROGRESS', { operationId: previous.id, idempotencyKey });
    }
    const current = await usage(tx, userId, now);
    if (current.inProgress) throw new PlanError('Your account already has a generation in progress.', 409, 'GENERATION_IN_PROGRESS', { operationId: current.inProgress.id, idempotencyKey: current.inProgress.idempotencyKey });
    if (current.remaining <= 0) throw new PlanError('Monthly AI limit reached', 429, 'MONTHLY_AI_LIMIT', { ...current });
    const config = planConfiguration();
    const recent = await tx.itineraryGeneration.count({ where: { userId, allowancePeriod: { not: null }, createdAt: { gt: new Date(now.getTime() - config.rateWindowMs) } } });
    if (recent >= config.rateLimit) throw new PlanError('Too many generation requests. Try again shortly.', 429, 'RATE_LIMITED');
    const record = await tx.itineraryGeneration.create({ data: { userId, destination: destination.slice(0, 120), idempotencyKey, requestHash,
      allowancePeriod: allowancePeriod(now).start, allowanceState: 'reserved', reservedUntil: new Date(now.getTime() + RESERVATION_LEASE_MS), operationKind: body.kind === 'day-replan' ? 'day-replan' : 'itinerary', relatedTripId: body.kind === 'day-replan' ? String(body.tripId) : null } });
    return { recordId: record.id, attemptId: record.attemptId } as const;
  });
}
export async function processGeneration(recordId: string, attemptId: string) {
  const result = await prisma.itineraryGeneration.updateMany({ where: { id: recordId, attemptId, allowanceState: 'reserved', reservedUntil: { gt: new Date() } }, data: { allowanceState: 'processing' } });
  if (result.count !== 1) throw new PlanError('This operation is no longer active.', 409, 'GENERATION_ENDED');
}
export async function persistGeneration(recordId: string, attemptId: string, response: Record<string, unknown>, charge = true): Promise<boolean> {
  // Usable validated output and deduction commit in a single durable write. The
  // generation result is recoverable even if the browser never receives it.
  return prisma.$transaction(async tx => {
    // Serialize the reserved -> used transition with quota reads/reservations.
    // Otherwise separate count queries could observe neither side of a commit.
    await tx.$queryRaw`SELECT u."id" FROM "users" u JOIN "itinerary_generations" g ON g."user_id" = u."id" WHERE g."id" = ${recordId} FOR UPDATE OF u`;
    const result = await tx.itineraryGeneration.updateMany({
      where: { id: recordId, attemptId, status: 'pending', allowanceState: { in: [...active] }, reservedUntil: { gt: new Date() } },
      data: { status: 'completed', allowanceState: 'succeeded', charged: charge, response: response as Prisma.InputJsonValue, errorCode: null },
    });
    return result.count === 1;
  });
}
export async function releaseGeneration(recordId: string, attemptId: string, errorCode: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT u."id" FROM "users" u JOIN "itinerary_generations" g ON g."user_id" = u."id" WHERE g."id" = ${recordId} FOR UPDATE OF u`;
    return tx.itineraryGeneration.updateMany({ where: { id: recordId, attemptId, status: 'pending', allowanceState: { in: [...active] } },
      data: { status: 'failed', allowanceState: 'failed', charged: false, errorCode, response: Prisma.DbNull } });
  });
}
export async function readGeneration(userId: string, key: string) {
  await getPlan(userId); // Reconcile expired leases before returning status.
  const record = await prisma.itineraryGeneration.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
  if (!record) throw new PlanError('Generation not found.', 404, 'NOT_FOUND');
  return { id: record.id, key: record.idempotencyKey, state: record.allowanceState ?? record.status, status: record.status,
    kind: record.operationKind, tripId: record.relatedTripId, charged: record.charged, result: record.status === 'completed' ? record.response : null, errorCode: record.status === 'failed' ? record.errorCode : null };
}

// Live payment activation remains disabled. The separate test-checkout service
// verifies PayMongo test resources before granting the paymongo_test source.
// Admin demo grants remain distinct, permission-checked and audited.
export async function grantDemoPlus(actorId: string, userId: string, activationKey: string, reason: string, expiresAt: Date) {
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(activationKey) || !reason.trim() || reason.length > 500 || !Number.isFinite(expiresAt.getTime())) throw new PlanError('Provide a grant key, reason and future expiry.', 400, 'BAD_REQUEST');
  return prisma.$transaction(async tx => {
    const actor = await tx.user.findFirst({ where: { id: actorId, role: 'admin', accountStatus: 'active' } });
    if (!actor) throw new PlanError('Admin permission required.', 403, 'FORBIDDEN');
    await lockUser(tx, userId);
    const previous = await tx.planActivation.findUnique({ where: { key: activationKey } });
    if (previous) {
      if (previous.userId !== userId || previous.actorId !== actorId || previous.reason !== reason.trim() || previous.expiresAt.getTime() !== expiresAt.getTime()) throw new PlanError('Grant key already used for different terms.', 409, 'CONFLICT');
      return previous;
    }
    if (expiresAt <= new Date()) throw new PlanError('Provide a future expiry for a new grant.', 400, 'BAD_REQUEST');
    const existing = await tx.planSubscription.findUnique({ where: { userId } });
    if (existing?.source === 'verified_payment') throw new PlanError('A demo grant cannot replace a verified paid entitlement.', 409, 'CONFLICT');
    if (existing && existing.expiresAt > expiresAt) throw new PlanError('A demo grant cannot shorten an existing entitlement.', 409, 'CONFLICT');
    const data = { source: 'admin_demo' as const, activationKey, actorId, reason: reason.trim(), expiresAt };
    const subscription = await tx.planSubscription.upsert({ where: { userId }, create: { userId, ...data }, update: { ...data, startsAt: new Date() } });
    await tx.planActivation.create({ data: { key: activationKey, userId, actorId, reason: reason.trim(), expiresAt } });
    await tx.auditEvent.create({ data: { actorId, action: `plan:demo-plus:${activationKey}:${reason.trim()}:expires:${expiresAt.toISOString()}`, targetId: userId } });
    return subscription;
  });
}
