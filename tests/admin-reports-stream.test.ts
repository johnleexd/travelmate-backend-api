import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import app from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { publishReportChange, subscribeReportChanges } from '../src/services/platform/report-events.ts';
import { submitReport, resolveReport } from '../src/services/platform/report-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

const admin = { id: 'admin-live-test', role: 'admin', name: 'Live Admin', email: 'admin@example.test', accountStatus: 'active', emailVerified: true, profileStatus: 'verified', trustScore: 50 } as PublicUser;
const traveler = { ...admin, id: 'traveler-live-test', role: 'traveler' } as PublicUser;
const server = app.listen(0);
let url = '';
before(async () => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/platform/reports/stream';
});
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });
function replace(t: TestContext, target: object, key: string, fn: unknown) {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, fn);
  t.after(() => { Reflect.set(target, key, original); });
}
const headers = (user: PublicUser) => ({ cookie: 'travelmate_session=' + createSessionToken(user.id, user.role) });

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, type: string) {
  let data = '';
  while (true) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'Stream ended before ' + type);
    data += new TextDecoder().decode(chunk.value);
    for (const frame of data.split('\n\n').slice(0, -1)) {
      if (frame.startsWith('event: ' + type + '\n') && frame.includes('data: ')) return JSON.parse(frame.split('data: ')[1]);
    }
  }
}

test('report streams reject anonymous and traveler sessions before reading reports', async t => {
  let reads = 0;
  replace(t, prisma.moderation, 'findMany', async () => { reads++; return []; });
  for (const auth of [undefined, headers(traveler)]) {
    const response = await fetch(url, { headers: auth });
    assert.equal(response.status, 401);
  }
  assert.equal(reads, 0);
});

test('admin stream sends committed reports, resolutions and reconnect snapshots without a page reload', { timeout: 10000 }, async t => {
  let rows: Array<Record<string, unknown>> = [];
  let authorized = true;
  replace(t, prisma.user, 'findFirst', async () => authorized ? admin : null);
  replace(t, prisma.user, 'findMany', async () => [traveler]);
  replace(t, prisma.moderation, 'findMany', async () => rows);
  replace(t, prisma.notification, 'findMany', async (query: { where: unknown }) => { assert.deepEqual(query.where, { userId: admin.id }); return [{ id: 'notification-live', userId: admin.id, title: 'Report submitted', body: 'Report details', href: '/admin/dashboard?tab=reports&category=reports', readAt: null, createdAt: new Date('2026-10-07T00:00:00Z') }]; });
  replace(t, prisma.notification, 'count', async () => 1);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url, { headers: headers(admin), signal: abort.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  const initial = await nextEvent(reader, 'reports');
  assert.deepEqual(initial.moderation, []);
  assert.equal(initial.notifications[0].id, 'notification-live');
  assert.equal(initial.unreadCount, 1);
  rows = [{ id: 'live-report', kind: 'report', subjectId: traveler.id, title: 'Live report issue', details: 'This report arrived from another browser.', status: 'pending', createdAt: new Date() }];
  publishReportChange();
  const added = await nextEvent(reader, 'reports');
  assert.equal(added.moderation[0].id, 'live-report');
  assert.equal(added.reporters[0].name, traveler.name);
  rows = [{ ...rows[0], status: 'resolved' }];
  publishReportChange();
  assert.equal((await nextEvent(reader, 'reports')).moderation[0].status, 'resolved');
  abort.abort();
  const reconnect = new AbortController();
  t.after(() => reconnect.abort());
  const resumed = await fetch(url, { headers: headers(admin), signal: reconnect.signal });
  const resumedReader = resumed.body!.getReader();
  assert.equal((await nextEvent(resumedReader, 'reports')).moderation[0].status, 'resolved');
  authorized = false;
  publishReportChange();
  assert.deepEqual(await nextEvent(resumedReader, 'session-expired'), {});
});

test('report change notifications happen after commit and never after rollback', async t => {
  let committed = false;
  let notifications = 0;
  const unsubscribe = subscribeReportChanges(() => { assert.equal(committed, true); notifications++; });
  t.after(unsubscribe);
  const report = { id: 'commit-report', subjectId: traveler.id, title: 'Report title', createdAt: new Date() };
  const tx = { moderation: { create: async () => report, updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => report }, auditEvent: { create: async () => ({}) }, user: { findUnique: async () => null, findMany: async () => [] }, notification: { createMany: async () => ({ count: 0 }) } };
  replace(t, prisma, '$transaction', async (callback: (value: unknown) => unknown) => { const result = await callback(tx); committed = true; return result; });
  await submitReport(traveler, { title: 'Report title', details: 'Detailed problem report.' });
  committed = false;
  await resolveReport(admin, { id: report.id });
  assert.equal(notifications, 2);
  replace(t, prisma, '$transaction', async () => { throw new Error('rollback'); });
  await assert.rejects(submitReport(traveler, { title: 'Report title', details: 'Detailed problem report.' }), /rollback/);
  assert.equal(notifications, 2);
});
