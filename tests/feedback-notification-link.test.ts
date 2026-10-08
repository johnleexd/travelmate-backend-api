import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { notifyAdmins } from '../src/services/platform/admin-notification-service.ts';
import { submitFeedback, feedbackDetails } from '../src/services/platform/feedback-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';
function replace(t: TestContext, target: object, key: string, fn: unknown) { const original = Reflect.get(target, key); Reflect.set(target, key, fn); t.after(() => { Reflect.set(target, key, original); }); }
after(() => prisma.$disconnect());

test('feedback fanout uses stable unique database keys across retries, edits and read state', async t => {
  const records = new Map<string, { id: string; userId: string; href: string; readAt?: Date }>();
  replace(t, prisma.user, 'findMany', async (query: { where: unknown }) => {
    assert.deepEqual(query.where, { role: 'admin', accountStatus: 'active' }); return [{ id: 'admin-1' }, { id: 'admin-2' }];
  });
  replace(t, prisma.notification, 'createMany', async (query: { skipDuplicates: boolean; data: Array<{ id: string; userId: string; href: string }> }) => {
    assert.equal(query.skipDuplicates, true);
    for (const row of query.data) if (!records.has(row.id)) records.set(row.id, row);
    return { count: 2 };
  });
  await Promise.all([1,2,3].map(() => notifyAdmins(prisma, 'feedback', 'New feedback received', 'A rating', 'feedback-1')));
  assert.equal(records.size, 2);
  const first = [...records.values()][0]; first.readAt = new Date();
  await notifyAdmins(prisma, 'feedback', 'New feedback received', 'Edited rating', 'feedback-1');
  assert.equal(records.size, 2); assert.ok(records.get(first.id)?.readAt);
  assert.ok([...records.values()].every(row => new URL(row.href, 'http://localhost').searchParams.get('feedbackId') === 'feedback-1'));
  await notifyAdmins(prisma, 'feedback', 'New feedback received', 'Another trip', 'feedback-2');
  assert.equal(records.size, 4);
});

test('non-owned itinerary is rejected before feedback or notification writes', async t => {
  let writes = 0;
  replace(t, prisma, '$transaction', async (fn: (db: unknown) => unknown) => fn({
    $queryRaw: async () => [], feedback: { upsert: async () => { writes++; } },
    notification: { createMany: async () => { writes++; } },
  }));
  await assert.rejects(submitFeedback({ id: 'traveler', role: 'traveler' } as PublicUser, { itineraryId: 'another-users-trip', rating: 4, category: 'weather_info', comment: 'Useful weather explanation.' }), /not found for this account/);
  assert.equal(writes, 0);
});

test('exact feedback detail lookup ignores history filters and selects only public traveler fields', async t => {
  const now = new Date();
  replace(t, prisma.feedback, 'findUnique', async (query: { where: unknown; include: { user: { select: unknown } } }) => {
    assert.deepEqual(query.where, { id: 'old-feedback' });
    assert.deepEqual(query.include.user.select, { id: true, name: true, email: true, avatarUrl: true });
    return { id: 'old-feedback', rating: 4, category: 'weather_info', comment: 'Useful weather explanation.', sentiment: 'not_analyzed', createdAt: now, updatedAt: now, user: { id: 'traveler', name: 'Traveler', email: 'test@example.test', avatarUrl: null }, itinerary: { id: 'trip', destination: 'Tokyo' } };
  });
  const entry = await feedbackDetails('old-feedback');
  assert.equal(entry?.id, 'old-feedback'); assert.equal(entry?.user?.name, 'Traveler');
  assert.equal(entry?.itinerary?.id, 'trip'); assert.equal(entry?.createdAt, now.toISOString());
  await assert.rejects(feedbackDetails(''), /valid feedback ID/);
  replace(t, prisma.feedback, 'findUnique', async () => null);
  assert.equal(await feedbackDetails('old-feedback'), null);
});
