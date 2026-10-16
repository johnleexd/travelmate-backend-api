import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { nextStopOptions } from '../src/services/navigation/next-stop-service.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { POST_NEXT_STOP } from '../src/controllers/navigation-controller.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';

const origin = { latitude: 14.55, longitude: 121.05 }, destination = { latitude: 14.551, longitude: 121.051 };
const baseUrl = 'https://configured-router.example/';
function payload(distance = 600, duration = 480, offset = 2) {
  return { code: 'Ok', waypoints: [{ distance: offset }, { distance: 2 }], routes: [{ distance, duration,
    geometry: { type: 'LineString', coordinates: [[121.05, 14.55], [121.051, 14.551]] },
    legs: [{ steps: [{ name: 'Recorded path', distance, duration, maneuver: { type: 'depart', location: [121.05, 14.55] } }] }],
  }] };
}
beforeEach(clearProviderCache);
after(() => prisma.$disconnect());

test('unconfigured routing provides no invented mode, fare or metrics and makes no public demo calls', async () => {
  let calls = 0;
  const result = await nextStopOptions(origin, destination, { baseUrl: '', fetcher: async () => { calls++; return Response.json({}); } });
  assert.deepEqual(result, []); assert.equal(calls, 0);
});

test('a returned short walking route is reused, cached and coalesced with exact endpoint ordering', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    calls++; const url = new URL(String(input));
    assert.match(url.pathname, /routed-foot\/route\/v1\/driving\/121.05,14.55;121.051,14.551/);
    return Response.json(payload());
  };
  const [first, second] = await Promise.all([nextStopOptions(origin, destination, { baseUrl, fetcher }), nextStopOptions(origin, destination, { baseUrl, fetcher })]);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  assert.equal(first[0].mode, 'walking'); assert.equal(first[0].distanceMeters, 600); assert.equal(first[0].durationSeconds, 480);
  assert.equal('fare' in first[0], false);
  assert.deepEqual(await nextStopOptions(origin, destination, { baseUrl, fetcher }), first);
  assert.equal(calls, 1);
});

test('walking suitability needs both returned route distance and duration; driving does not establish taxi availability', async () => {
  for (const [distance, duration] of [[5000, 400], [600, 4000]]) {
    clearProviderCache(); const calls: string[] = [];
    const result = await nextStopOptions(origin, destination, { baseUrl, fetcher: async input => {
      const path = new URL(String(input)).pathname; calls.push(path);
      return Response.json(path.includes('routed-foot') ? payload(distance, duration) : payload(1200, 240));
    } });
    assert.equal(calls.length, 2); assert.deepEqual(result.map(route => route.mode), ['walking', 'driving']);
    assert.equal(result[1].durationSeconds, 240);
    for (const route of result) for (const field of ['taxiAvailable', 'fare', 'transit', 'stops']) assert.equal(field in route, false);
  }
});

test('provider failure, unsupported routes, malformed data and remote snapping remain unavailable and are negatively cached', async () => {
  for (const body of [{ code: 'NoRoute' }, {}, payload(600, 480, 800)]) {
    clearProviderCache(); let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(body); };
    assert.deepEqual(await nextStopOptions(origin, destination, { baseUrl, fetcher }), []);
    assert.deepEqual(await nextStopOptions(origin, destination, { baseUrl, fetcher }), []);
    assert.equal(calls, 2);
  }
  clearProviderCache();
  assert.deepEqual(await nextStopOptions(origin, destination, { baseUrl, fetcher: async () => { throw Error('Provider unavailable'); } }), []);
});

test('one failing profile does not discard a supported driving route; public routing quota is respected', async () => {
  const routes = await nextStopOptions(origin, destination, { baseUrl, fetcher: async input => String(input).includes('routed-foot') ? Response.json({ code: 'NoRoute' }) : Response.json(payload(900, 200)) });
  assert.deepEqual(routes.map(route => route.mode), ['driving']);
  clearProviderCache(); let calls = 0;
  assert.deepEqual(await nextStopOptions(origin, destination, { baseUrl: 'https://routing.openstreetmap.de/', reservePublicRequest: async () => false, fetcher: async () => { calls++; return Response.json(payload()); } }), []);
  assert.equal(calls, 0);
});

test('next-stop endpoint enforces authenticated travelers and coordinates, without requiring a saved trip or transportation input', async t => {
  const request = (body: unknown, cookie?: string) => new Request('http://localhost/api/navigation/next-stop', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await POST_NEXT_STOP(request({ origin, destination }))).status, 401);
  const replace = (object: any, key: string, value: any) => { const previous = object[key]; object[key] = value; t.after(() => { object[key] = previous; }); };
  replace(prisma.user, 'findFirst', async () => ({ id: 'next-stop-test', role: 'traveler', name: 'Test', email: 'test@example.test', emailVerified: true, accountStatus: 'active' }));
  replace(prisma, '$queryRaw', async () => [{ count: 1 }]);
  const prior = process.env.NAVIGATION_ROUTING_BASE_URL;
  delete process.env.NAVIGATION_ROUTING_BASE_URL;
  t.after(() => { if (prior === undefined) delete process.env.NAVIGATION_ROUTING_BASE_URL; else process.env.NAVIGATION_ROUTING_BASE_URL = prior; });
  const cookie = 'travelmate_session=' + createSessionToken('next-stop-test', 'traveler');
  const response = await POST_NEXT_STOP(request({ origin, destination }, cookie));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { origin, destination, options: [] });
  for (const body of [{ origin }, { origin: { latitude: 91, longitude: 0 }, destination }, { origin: 'Museum', destination: 'Park' }, { origin, destination, mode: 'transit' }]) assert.equal((await POST_NEXT_STOP(request(body, cookie))).status, 400);
});
