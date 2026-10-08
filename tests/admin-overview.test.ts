import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { overviewDates, readAdminOverview } from '../src/repositories/admin-overview-repository.ts';
function replace(t: TestContext, target: object, key: string, fn: unknown) {
  const original = Reflect.get(target, key); Reflect.set(target, key, fn);
  t.after(() => { Reflect.set(target, key, original); });
}
after(async () => prisma.$disconnect());
test('overview calendar uses Philippine dates across UTC midnight', () => {
  const period = overviewDates(new Date('2026-10-07T17:00:00Z'));
  assert.equal(period.dates[0], '2026-10-02');
  assert.equal(period.dates[6], '2026-10-08');
  assert.equal(period.start.toISOString(), '2026-10-01T16:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-10-08T16:00:00.000Z');
});
test('overview includes all-time totals, seven full days and real rating averages', async t => {
  replace(t, prisma.itineraryGeneration, 'count', async (query: unknown) => { assert.deepEqual(query, { where: { status: 'completed' } }); return 120; });
  replace(t, prisma.feedback, 'aggregate', async () => ({ _avg: { rating: 4.25 }, _count: { rating: 4 } }));
  replace(t, prisma, '$queryRaw', async (_strings: unknown, start: Date, end: Date) => {
    assert.equal(start.toISOString(), '2026-09-30T16:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-07T16:00:00.000Z');
    return [{ date: '2026-10-02', status: 'completed', count: 3 }, { date: '2026-10-07', status: 'completed', count: 2 }, { date: '2026-10-07', status: 'failed', count: 1 }, { date: '2026-10-07', status: 'pending', count: 4 }];
  });
  const summary = await readAdminOverview(new Date('2026-10-07T12:00:00Z'));
  assert.equal(summary.generatedPlans, 120); assert.equal(summary.averageRating, 4.25);
  assert.equal(summary.feedbackCount, 4); assert.equal(summary.recentCompleted, 5);
  assert.equal(summary.recentFailed, 1);
  assert.deepEqual(summary.generationDays.map(day => day.completed), [0, 3, 0, 0, 0, 0, 2]);
});
test('empty overview keeps zero counts and an absent rating instead of invented data', async t => {
  replace(t, prisma.itineraryGeneration, 'count', async () => 0);
  replace(t, prisma.feedback, 'aggregate', async () => ({ _avg: { rating: null }, _count: { rating: 0 } }));
  replace(t, prisma, '$queryRaw', async () => []);
  const summary = await readAdminOverview();
  assert.equal(summary.averageRating, null); assert.equal(summary.feedbackCount, 0);
  assert.equal(summary.generationDays.length, 7); assert.ok(summary.generationDays.every(day => day.completed === 0));
});
