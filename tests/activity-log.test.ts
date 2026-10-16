import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { readActivityLog } from '../src/repositories/activity-log-repository.ts';
import { GET_ACTIVITY_LOG } from '../src/controllers/activity-log-controller.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { describeActivity, safeActivityCode } from '../src/services/platform/activity-presentation.ts';

after(() => prisma.$disconnect());
function replace(t: TestContext, target: object, key: string, value: unknown) {
  const previous = Reflect.get(target, key); Reflect.set(target, key, value);
  t.after(() => Reflect.set(target, key, previous));
}

test('activity labels preserve stored values and hide embedded keys, reasons and unknown payloads', () => {
  assert.equal(describeActivity('appeal-approved').label, 'Appeal approved');
  assert.equal(describeActivity('save-trip').label, 'Trip saved');
  assert.equal(describeActivity('google-login').label, 'Google login');
  assert.equal(describeActivity('admin-user-status').label, 'Account status changed');
  const raw = 'plan:demo-plus:private-activation-key:confidential reason:expires:2040-01-01';
  assert.equal(describeActivity(raw).label, 'Demo Plus granted');
  assert.equal(safeActivityCode(raw), 'plan:demo-plus');
  assert.equal(describeActivity('unrecognized:private-value').label, 'Other activity');
  assert.equal(safeActivityCode('unrecognized:private-value'), 'other-activity');
  assert.equal(raw.includes('private-activation-key'), true);
});

test('actor presentation uses only the joined actor, with honest fallbacks and no raw action payloads', async t => {
  const base = { targetId: 'affected-user', createdAt: new Date('2026-10-16T12:00:00Z'), action: 'admin-user-status' };
  let reads = 0;
  replace(t, prisma, '$transaction', async (work: (tx: unknown) => unknown) => work({ $queryRaw: async () => ++reads === 1 ? [{ total: 3n }] : [
    { ...base, id: 'one', actorId: 'admin-actor', userId: 'admin-actor', actorName: 'Actual Admin', actorRole: 'admin' },
    { ...base, id: 'two', action: 'plan:demo-plus:secret-key:secret-reason', actorId: 'deleted-account', userId: null, actorName: null, actorRole: null },
    { ...base, id: 'three', actorId: null, userId: null, actorName: null, actorRole: null },
  ] }));
  const result = await readActivityLog(new URLSearchParams());
  assert.equal(result.entries[0].actor?.id, 'admin-actor');
  assert.equal(result.entries[0].targetId, 'affected-user');
  assert.equal(result.entries[1].actor, null);
  assert.equal(result.entries[1].actorUnavailableReason, 'account-unavailable');
  assert.equal(result.entries[2].actorUnavailableReason, 'not-recorded');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('activity endpoint rejects anonymous, traveler and inactive accounts before reading activity', async t => {
  let queried = false;
  replace(t, prisma, '$transaction', async () => { queried = true; throw new Error('Activity must not be queried.'); });
  replace(t, prisma.user, 'findFirst', async () => null);
  const request = (cookie?: string) => new Request('http://localhost/api/platform/activity', { headers: cookie ? { cookie } : {} });
  assert.equal((await GET_ACTIVITY_LOG(request())).status, 401);
  assert.equal((await GET_ACTIVITY_LOG(request(`travelmate_session=${createSessionToken('traveler', 'traveler')}`))).status, 401);
  assert.equal((await GET_ACTIVITY_LOG(request(`travelmate_session=${createSessionToken('inactive-admin', 'admin')}`))).status, 401);
  assert.equal(queried, false);
});

test('invalid activity queries are rejected before touching the database', async t => {
  replace(t, prisma, '$transaction', async () => { throw new Error('Unexpected database request.'); });
  for (const query of ['page=0', 'page=-1', 'page=1000001', 'page=abc', 'q=' + 'a'.repeat(201)]) {
    await assert.rejects(() => readActivityLog(new URLSearchParams(query)), /valid page number/);
  }
});
