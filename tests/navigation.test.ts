import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { POST_ROUTE, POST_SEARCH } from '../src/controllers/navigation-controller.ts';
import { fetchNavigationRoute, maneuverInstruction, NavigationError, navigationRequestSchema, parseNavigationRoute, searchNavigationDestinations } from '../src/services/navigation/navigation-service.ts';

after(() => prisma.$disconnect());
const input = { origin: { latitude: 14.55, longitude: 121.05 }, destination: { latitude: 14.551, longitude: 121.051 }, mode: 'walking' as const };
const payload = { code: 'Ok', waypoints: [{ distance: 2 }, { distance: 3 }], routes: [{ distance: 218, duration: 180, geometry: { type: 'LineString', coordinates: [[121.05,14.55],[121.05,14.551],[121.051,14.551]] }, legs: [{ steps: [
  { name: 'Sample Road', distance: 111, duration: 90, maneuver: { type: 'depart', bearing_after: 0, location: [121.05,14.55] } },
  { name: 'Park Street', distance: 107, duration: 90, maneuver: { type: 'turn', modifier: 'right', location: [121.05,14.551] } },
  { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive', location: [121.051,14.551] } },
] }] }] };

test('navigation rejects invalid coordinates/modes before contacting a provider', async () => {
  assert.equal(navigationRequestSchema.safeParse({ ...input, origin: { latitude: 91, longitude: 0 } }).success, false);
  assert.equal(navigationRequestSchema.safeParse({ ...input, mode: 'flying' }).success, false);
  assert.equal(navigationRequestSchema.safeParse({ ...input, url: 'http://localhost/private' }).success, false);
  let calls = 0;
  await assert.rejects(fetchNavigationRoute({ ...input, origin: { latitude: NaN, longitude: 0 } }, { fetcher: async () => { calls++; return Response.json(payload); } }));
  assert.equal(calls, 0);
});

test('walking/cycling/driving select actual datasets, protect public quota, and convert GeoJSON order', async () => {
  for (const [mode, path] of [['walking','routed-foot'],['cycling','routed-bike'],['driving','routed-car']] as const) {
    let reserves = 0;
    const route = await fetchNavigationRoute({ ...input, mode }, { reservePublicRequest: async () => { reserves++; return true; }, fetcher: async (url, init) => {
      const parsed = new URL(String(url)); assert.ok(parsed.pathname.startsWith(`/${path}/route/v1/driving/`));
      assert.ok(parsed.pathname.includes('121.05,14.55;121.051,14.551'));
      assert.equal(parsed.searchParams.get('steps'), 'true'); assert.equal(parsed.searchParams.get('geometries'), 'geojson');
      assert.match(String((init?.headers as Record<string,string>)['User-Agent']), /TravelMate/);
      return Response.json(payload);
    } });
    assert.equal(reserves, 1); assert.equal(route.mode, mode); assert.deepEqual(route.geometry[0], input.origin);
    assert.equal(route.steps[1].instruction, 'Turn right onto Park Street'); assert.equal(route.steps[2].instruction, 'Arrive at your destination');
    assert.equal(route.originOffsetMeters, 2); assert.equal(route.destinationOffsetMeters, 3);
  }
});

test('busy, unreachable, unavailable and malformed routes never fall back to a made-up line', async () => {
  let calls = 0;
  await assert.rejects(fetchNavigationRoute(input, { reservePublicRequest: async () => false, fetcher: async () => { calls++; return Response.json(payload); } }), (error: unknown) => error instanceof NavigationError && error.status === 429);
  assert.equal(calls, 0);
  for (const response of [Response.json({ code: 'NoRoute' }, { status: 400 }), Response.json({ code: 'NoSegment' })]) await assert.rejects(fetchNavigationRoute(input, { reservePublicRequest: async () => true, fetcher: async () => response }), (error: unknown) => error instanceof NavigationError && error.status === 404);
  await assert.rejects(fetchNavigationRoute(input, { reservePublicRequest: async () => true, fetcher: async () => Response.json({}, { status: 503 }) }), /unavailable/);
  await assert.rejects(fetchNavigationRoute(input, { reservePublicRequest: async () => true, fetcher: async () => new Response('invalid') }), /unreadable/);
  assert.throws(() => parseNavigationRoute({ ...payload, routes: [] }, input), /incomplete/);
  assert.equal(maneuverInstruction('roundabout', 'right', 'Main Road', 2), 'At the roundabout, take exit 2 onto Main Road');
  assert.equal(maneuverInstruction('future-maneuver', 'left', 'Main Road'), 'Turn left onto Main Road');
});

test('explicit landmark/address search returns only validated places without fabricating coordinates', async () => {
  const matches = await searchNavigationDestinations('Museum & Park, Manila', async url => {
    const params = new URL(String(url)).searchParams;
    assert.equal(params.get('q'), 'Museum & Park, Manila'); assert.equal(params.get('limit'), '6');
    return Response.json([{ osm_type: 'node', osm_id: 1, name: 'Museum', display_name: 'Museum, Manila, Philippines', lat: '14.551', lon: '121.051' }, { display_name: 'Bad', lat: '', lon: '1' }, { display_name: 'Bad', lat: '91', lon: '0' }]);
  });
  assert.equal(matches.length, 1); assert.equal(matches[0].name, 'Museum'); assert.equal(matches[0].latitude, 14.551);
});

test('navigation endpoints enforce signed travelers, validate requests and supply Retry-After without storing GPS', async t => {
  const request = (path: string, body: unknown, cookie?: string) => new Request(`http://localhost/api/navigation/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await POST_ROUTE(request('route', input))).status, 401);
  assert.equal((await POST_SEARCH(request('search', { query: 'Museum' }))).status, 401);
  const priorUser = prisma.user.findFirst, priorQuery = prisma.$queryRaw;
  let writes = 0;
  Reflect.set(prisma.user, 'findFirst', async () => ({ id: 'gps-test', name: 'Test', email: 'gps@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 }));
  Reflect.set(prisma, '$queryRaw', async (...args: unknown[]) => {
    const key = args[1]; assert.equal(typeof key, 'string'); assert.ok(!String(key).includes('14.55')); assert.ok(!String(key).includes('121.05'));
    writes++; return [{ count: key === 'navigation-routing:public-provider' ? 2 : 1 }];
  });
  t.after(() => { Reflect.set(prisma.user, 'findFirst', priorUser); Reflect.set(prisma, '$queryRaw', priorQuery); });
  t.mock.method(Math, 'random', () => 0.5);
  const cookie = `travelmate_session=${createSessionToken('gps-test', 'traveler')}`;
  assert.equal((await POST_ROUTE(request('route', { ...input, mode: 'spaceship' }, cookie))).status, 400);
  assert.equal((await POST_SEARCH(request('search', { query: '' }, cookie))).status, 400);
  const limited = await POST_ROUTE(request('route', input, cookie));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '2');
  assert.equal(writes, 4); // only coordinate-free limiter buckets; no trip/visit writes.
});
