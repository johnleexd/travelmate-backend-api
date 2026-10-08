import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import type { Trip } from '../src/generated/prisma/client.ts';
import type { PublicUser } from '../src/schemas/domain.ts';
import { executePlatformAction } from '../src/services/platform/platform-service.ts';
import { serializeWorkspaceTrip } from '../src/repositories/trip-workspace-repository.ts';

const user: PublicUser = { id: 'completion-owner', role: 'traveler', name: 'Test', email: 'test@example.test', emailVerified: true, profileStatus: 'unverified', accountStatus: 'active', trustScore: 50 };
function trip(): Trip {
  return { id: 'completed-trip', userId: user.id, destination: 'Paris', destinationCity: 'Paris', destinationRegion: null,
    destinationCountry: 'France', destinationCountryCode: 'FR', latitude: 48.8566, longitude: 2.3522,
    budget: 1000, currency: 'EUR', startDate: new Date('2040-01-01'), endDate: new Date('2040-01-03'),
    travelers: 1, partyType: 'solo', interests: ['culture'], itinerary: { plannedAccommodation: { name: 'Saved Hotel' } }, weather: null,
    status: 'active', archivedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() } as unknown as Trip;
}
function mockTransaction(t: TestContext, current: Trip, accessible = true) {
  const changes: Record<string, unknown>[] = [];
  const actions: string[] = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => { assert.match(query.join('?'), /user_id.*FOR UPDATE/); assert.deepEqual(values, [current.id, user.id]); return []; },
    trip: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => { assert.deepEqual(where, { id: current.id, userId: user.id }); return accessible ? current : null; },
      update: async ({ data }: { data: Record<string, unknown> }) => { changes.push(data); Object.assign(current, data); return current; },
    },
    auditEvent: { create: async ({ data }: { data: { action: string } }) => { actions.push(data.action); return {}; } },
  };
  const previous = prisma.$transaction;
  Reflect.set(prisma, '$transaction', async (callback: (client: unknown) => unknown) => callback(tx));
  t.after(() => Reflect.set(prisma, '$transaction', previous));
  return { changes, actions };
}
after(() => prisma.$disconnect());

test('completion is persisted and idempotent, preserves the plan, and survives archive/restore', async t => {
  const current = trip(); const itinerary = current.itinerary;
  const { changes, actions } = mockTransaction(t, current);
  const completed = await executePlatformAction(user, 'complete-trip', { id: current.id }) as { status: string; completedAt: string };
  assert.equal(completed.status, 'completed'); assert.ok(completed.completedAt);
  const timestamp = current.completedAt;
  await executePlatformAction(user, 'complete-trip', { id: current.id });
  assert.equal(current.completedAt, timestamp);
  assert.equal(serializeWorkspaceTrip(current).completedAt, completed.completedAt);
  await executePlatformAction(user, 'archive-trip', { id: current.id });
  assert.equal(current.status, 'archived'); assert.equal(current.completedAt, timestamp);
  await executePlatformAction(user, 'restore-trip', { id: current.id });
  assert.equal(current.status, 'completed'); assert.equal(current.archivedAt, null);
  await executePlatformAction(user, 'reopen-trip', { id: current.id });
  assert.equal(current.status, 'active'); assert.equal(current.completedAt, null);
  assert.equal(current.itinerary, itinerary);
  assert.deepEqual(actions, ['complete-trip', 'complete-trip', 'archive-trip', 'restore-trip', 'reopen-trip']);
  assert.ok(changes.every(change => Object.keys(change).sort().join(',') === 'archivedAt,completedAt,status'));
});

test('restoring an unfinished archived plan keeps it active', async t => {
  const current = trip(); current.status = 'archived'; current.archivedAt = new Date(); mockTransaction(t, current);
  await executePlatformAction(user, 'restore-trip', { id: current.id });
  assert.equal(current.status, 'active'); assert.equal(current.completedAt, null); assert.equal(current.archivedAt, null);
});

test('completion and reopening require an owned, unarchived traveler trip', async t => {
  const current = trip(); const { changes } = mockTransaction(t, current, false);
  for (const action of ['complete-trip', 'reopen-trip']) {
    await assert.rejects(executePlatformAction(user, action, { id: current.id }), /Saved trip not found/);
    await assert.rejects(executePlatformAction({ ...user, role: 'admin' }, action, { id: current.id }), /not allowed/);
    await assert.rejects(executePlatformAction(user, action, { id: '' }), /valid record identifier/);
  }
  assert.equal(changes.length, 0);
  for (const role of ['traveler', 'admin'] as const) {
    await assert.rejects(executePlatformAction({ ...user, role }, 'duplicate-trip', { id: current.id }), /no longer available/);
  }
  assert.equal(changes.length, 0);
});

test('archived and completed records cannot have their saved itinerary version overwritten', async t => {
  const current = trip(); current.status = 'archived'; const { changes } = mockTransaction(t, current);
  await assert.rejects(executePlatformAction(user, 'complete-trip', { id: current.id }), /Restore this archived trip first/);
  await assert.rejects(executePlatformAction(user, 'reopen-trip', { id: current.id }), /Restore this archived trip first/);
  current.status = 'completed'; current.completedAt = new Date();
  await assert.rejects(executePlatformAction(user, 'restore-itinerary-version', { id: current.id, versionId: 'old-version' }), /Reopen this trip/);
  assert.equal(changes.length, 0);
});
