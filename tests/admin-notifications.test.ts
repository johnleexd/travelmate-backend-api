import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { notifyAdmins } from '../src/services/platform/admin-notification-service.ts';
import { executePlatformAction } from '../src/services/platform/platform-service.ts';
import { submitReport } from '../src/services/platform/report-service.ts';
import { submitFeedback } from '../src/services/platform/feedback-service.ts';
import { failGeneration } from '../src/controllers/itinerary-controller.ts';
import { readNotificationSnapshot } from '../src/repositories/trip-workspace-repository.ts';
import type { PublicUser } from '../src/schemas/domain.ts';
const admin = { id: 'admin-test', role: 'admin', name: 'Admin' } as PublicUser;
const traveler = { id: 'traveler-test', role: 'traveler', name: 'Traveler' } as PublicUser;
function replace(t: TestContext, target: object, key: string, fn: unknown) { const original = Reflect.get(target, key); Reflect.set(target, key, fn); t.after(() => { Reflect.set(target, key, original); }); }
after(async () => prisma.$disconnect());

test('notification reads and mark-all are scoped to the signed-in account', async t => {
  replace(t, prisma.notification, 'findMany', async (query: { where: unknown }) => { assert.deepEqual(query.where, { userId: admin.id }); return []; });
  replace(t, prisma.notification, 'count', async (query: { where: unknown }) => { assert.deepEqual(query.where, { userId: admin.id, readAt: null }); return 61; });
  assert.deepEqual(await readNotificationSnapshot(admin), { notifications: [], unreadCount: 61 });
  replace(t, prisma.notification, 'updateMany', async (query: { where: unknown }) => { assert.deepEqual(query.where, { userId: admin.id, readAt: null }); return { count: 61 }; });
  assert.deepEqual(await executePlatformAction(admin, 'mark-all-notifications-read', {}), { all: true });
  replace(t, prisma.notification, 'updateMany', async (query: { where: unknown }) => { assert.deepEqual(query.where, { id: 'someone-elses-notification', userId: admin.id }); return { count: 0 }; });
  await assert.rejects(executePlatformAction(admin, 'mark-notification-read', { id: 'someone-elses-notification' }), /Notification not found/);
});

test('reports and feedback persist categorized admin notifications in their own transaction', async t => {
  const writes: Array<{ data: Array<{ userId: string; title: string; href: string }> }> = [];
  const date = new Date();
  const tx = {
    user: { findMany: async (query: { where: unknown }) => { assert.deepEqual(query.where, { role: 'admin', accountStatus: 'active' }); return [{ id: admin.id }]; } },
    notification: { createMany: async (query: typeof writes[number]) => { writes.push(query); return { count: 1 }; } },
    moderation: { create: async () => ({ id: 'report-test', createdAt: date }) },
    auditEvent: { create: async () => ({}) },
    $queryRaw: async () => [{ id: 'trip-test' }],
    feedback: { findUnique: async () => null, upsert: async () => ({ id: 'feedback-test', rating: 5, category: 'ai_cohesion', comment: 'A helpful travel itinerary.', sentiment: 'not_analyzed', createdAt: date, updatedAt: date }) },
  };
  replace(t, prisma, '$transaction', async (fn: (db: unknown) => unknown) => fn(tx));
  await submitReport(traveler, { title: 'Report title', details: 'My saved trip will not open.' });
  await submitFeedback(traveler, { itineraryId: 'trip-test', rating: 5, category: 'ai_cohesion', comment: 'A helpful travel itinerary.' });
  assert.equal(writes[0].data[0].userId, admin.id); assert.match(writes[0].data[0].href, /category=reports/);
  assert.match(writes[1].data[0].href, /category=feedback&feedbackId=feedback-test/); assert.equal(writes[1].data[0].title, 'New feedback received');
});

test('system alerts are generated only for a newly persisted failure, not a stale attempt', async t => {
  let changed = 1; let alerts = 0;
  replace(t, prisma.itineraryGeneration, 'updateMany', async () => ({ count: changed }));
  replace(t, prisma.itineraryGeneration, 'findUnique', async () => ({ destination: 'Tokyo' }));
  replace(t, prisma.user, 'findMany', async () => [{ id: admin.id }]);
  replace(t, prisma.notification, 'createMany', async (query: { data: Array<{ href: string; body: string }> }) => { alerts++; assert.match(query.data[0].href, /category=system/); assert.match(query.data[0].body, /Tokyo/); return { count: 1 }; });
  await failGeneration('generation', 'attempt', 'PROVIDER_UNAVAILABLE');
  changed = 0; await failGeneration('generation', 'old-attempt', 'PROVIDER_UNAVAILABLE');
  assert.equal(alerts, 1);
});

test('no notification fanout is attempted when there are no active admins', async t => {
  replace(t, prisma.user, 'findMany', async () => []);
  replace(t, prisma.notification, 'createMany', async () => { throw new Error('Must not write.'); });
  await notifyAdmins(prisma, 'reports', 'Report submitted', 'A report was submitted.');
});
