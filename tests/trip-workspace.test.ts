import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import app from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { readTripPage, readTripVersions } from '../src/repositories/trip-workspace-repository.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

const user: PublicUser = { id: 'workspace-owner', role: 'traveler', name: 'Test', email: 'test@example.test', emailVerified: true, profileStatus: 'unverified', accountStatus: 'active', trustScore: 50 };
const server = app.listen(0, '127.0.0.1');
let base = '';
before(async () => { if (!server.listening) await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await prisma.$disconnect(); });
function mock(t: TestContext, target: object, key: string, implementation: (...args: any[]) => any) {
  const previous = Reflect.get(target, key); Reflect.set(target, key, implementation);
  t.after(() => Reflect.set(target, key, previous));
}
const row = { id: 'trip', userId: user.id, destination: 'Tokyo', destinationCity: null, destinationRegion: null, destinationCountry: null,
  destinationCountryCode: null, latitude: null, longitude: null, budget: 1000, currency: 'PHP',
  startDate: new Date('2040-01-01'), endDate: new Date('2040-01-01'), travelers: 1, partyType: 'solo', interests: [],
  status: 'active', archivedAt: null, createdAt: new Date(), updatedAt: new Date() };

test('trip pages are bounded, owned, and exclude itinerary and weather JSON at query time', async t => {
  mock(t, prisma.trip, 'findMany', async query => {
    assert.deepEqual(query.where, { userId: user.id }); assert.equal(query.take, 21);
    assert.equal(query.select.itinerary, undefined); assert.equal(query.select.weather, undefined);
    return Array.from({ length: 21 }, (_, index) => ({ ...row, id: `trip-${index}` }));
  });
  mock(t, prisma.trip, 'count', async query => { assert.equal(query.where.userId, user.id); return 42; });
  mock(t, prisma, '$queryRaw', async query => {
    assert.deepEqual(query.values, [user.id, ...Array.from({ length: 20 }, (_, index) => `trip-${index}`)]);
    assert.match(query.sql, /FROM trips WHERE user_id = \? AND id IN/);
    assert.match(query.sql, /plannedAccommodation,name/);
    assert.match(query.sql, /accommodation,name/);
    assert.doesNotMatch(query.sql, /SELECT\s+\*|\bweather\b/);
    return [{ id: 'trip-0', name: 'Selected Tokyo Hotel', address: 'Tokyo, Japan', selectionKind: 'planned' }, { id: 'trip-1', name: 'Quoted Hotel', address: 'Tokyo, Japan', selectionKind: 'quoted' }, { id: 'trip-2', name: null, address: null, selectionKind: 'quoted' }];
  });
  const page = await readTripPage(user);
  assert.equal(page.trips.length, 20); assert.equal(page.page.nextCursor, 'trip-19'); assert.equal(page.page.total, 42);
  assert.equal(page.trips[0].itinerary, null); assert.equal(page.trips[0].weather, null);
  assert.deepEqual(page.trips[0].selectedAccommodation, { name: 'Selected Tokyo Hotel', address: 'Tokyo, Japan', selectionKind: 'planned' });
  assert.equal(page.trips[1].selectedAccommodation?.selectionKind, 'quoted');
  assert.equal(page.trips[2].selectedAccommodation, undefined);
});

test('empty trip pages do not query accommodation summaries', async t => {
  mock(t, prisma.trip, 'findMany', async () => []);
  mock(t, prisma.trip, 'count', async () => 0);
  mock(t, prisma, '$queryRaw', async () => { throw new Error('An empty page must not query stays'); });
  assert.deepEqual(await readTripPage(user), { trips: [], page: { total: 0, nextCursor: null } });
});

test('a cursor from another owner is rejected before fetching a page', async t => {
  mock(t, prisma.trip, 'findFirst', async query => { assert.deepEqual(query.where, { id: 'foreign', userId: user.id }); return null; });
  mock(t, prisma.trip, 'findMany', async () => { throw new Error('Must not fetch a foreign cursor page'); });
  await assert.rejects(readTripPage(user, 'foreign'), /cursor is invalid/);
});

test('version history is owned, paginated and excludes snapshot content', async t => {
  mock(t, prisma.trip, 'findFirst', async query => { assert.deepEqual(query.where, { id: 'trip', userId: user.id }); return { id: 'trip' }; });
  mock(t, prisma.itineraryVersion, 'findMany', async query => {
    assert.equal(query.take, 51); assert.deepEqual(query.where, { tripId: 'trip' });
    assert.equal(query.select.itinerary, undefined); assert.equal(query.select.weather, undefined);
    return Array.from({ length: 51 }, (_, index) => ({ id: `version-${index}`, tripId: 'trip', version: 100 - index, kind: 'saved', createdAt: new Date() }));
  });
  mock(t, prisma.itineraryVersion, 'count', async () => 100);
  const result = await readTripVersions(user, 'trip');
  assert.equal(result.versions.length, 50); assert.equal(result.page.nextCursor, 'version-49');
  assert.equal(result.versions[0].itinerary, null);
});

test('notification polling reads only authenticated-user notifications', async t => {
  mock(t, prisma.user, 'findFirst', async () => ({ ...user, sessionVersion: 0 }));
  mock(t, prisma.notification, 'findMany', async query => { assert.equal(query.where.userId, user.id); assert.equal(query.take, 50); return []; });
  mock(t, prisma.trip, 'findMany', async () => { throw new Error('Notification polling must not load trips'); });
  mock(t, prisma.itineraryVersion, 'findMany', async () => { throw new Error('Notification polling must not load versions'); });
  assert.equal((await fetch(`${base}/api/platform/notifications`)).status, 401);
  const result = await fetch(`${base}/api/platform/notifications`, { headers: { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` } });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { notifications: [] });
});

test('trip detail endpoints reject another user’s trip without returning content', async t => {
  mock(t, prisma.user, 'findFirst', async () => ({ ...user, sessionVersion: 0 }));
  mock(t, prisma.trip, 'findFirst', async query => { assert.equal(query.where.userId, user.id); return null; });
  const headers = { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` };
  for (const path of ['/api/platform/trips/foreign', '/api/platform/trips/foreign/versions']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'Saved trip not found.');
  }
});
