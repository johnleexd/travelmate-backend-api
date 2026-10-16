import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildTripMapManifest, isDailyBudgetEntry, loadTripMapManifest, resolveTripMapActivity, searchTripActivityPlaces, vaguePlace } from '../src/services/navigation/trip-map-service.ts';
import { signGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { GET_TRIP_MAP, POST_TRIP_ACTIVITY, POST_TRIP_ACTIVITY_WEATHER, POST_TRIP_DAY_ROUTE } from '../src/controllers/trip-navigation-controller.ts';
import { fetchNavigationRoute, parseNavigationRoute } from '../src/services/navigation/navigation-service.ts';
after(() => prisma.$disconnect());
const place = { provider: 'wikidata' as const, placeId: 'Q112', name: 'Manila Cathedral', city: 'Manila', country: 'Philippines', countryCode: 'PH',
  latitude: 14.591, longitude: 120.973, sourceUrl: 'https://www.wikidata.org/wiki/Q112', fetchedAt: '2026-10-09T00:00:00Z', openingHours: 'Confirm', address: 'Intramuros, Manila' };
const trip = { id: 'map-trip', destination: 'Manila, Philippines', destinationCity: 'Manila', destinationCountry: 'Philippines', destinationCountryCode: 'PH', latitude: 14.6042, longitude: 120.9822,
  itinerary: { days: [{ day: 1, date: '2026-10-10', theme: 'Historic day', activities: [
    { title: place.name, time: '9:00 AM - 10:00 AM', description: 'Explore the landmark', place },
    { title: 'Local ramen shop', time: '12:00 PM', description: 'Find a lunch venue' },
  ] }, { day: 2, date: '2026-10-11', theme: 'Second day', activities: [{ title: 'Another exact place', time: '09:00', place: { ...place, placeId: 'Q113', name: 'Another exact place', sourceUrl: 'https://www.wikidata.org/wiki/Q113' } }] }] } };
const catalogPhoto = { ...place, description: 'Historic landmark', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/ea/The_Manila_Cathedral.jpg',
  imageAttribution: { creator: 'Kuranges', license: 'CC BY-SA 3.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:The_Manila_Cathedral.jpg' } };
test('real dates/order/place IDs stay trip-specific and vague activities remain unpinned', () => {
  const manifest = buildTripMapManifest(trip);
  assert.equal(manifest.tripId, 'map-trip'); assert.deepEqual(manifest.days.map(day => day.date), ['2026-10-10', '2026-10-11']);
  assert.equal(manifest.origin?.kind, 'destination'); assert.equal(manifest.origin?.name, 'Manila destination centre');
  const hotelOrigin = buildTripMapManifest({ ...trip, itinerary: { ...trip.itinerary, plannedAccommodation: { name: 'Intramuros Hotel', latitude: 14.59, longitude: 120.975 } } });
  assert.deepEqual(hotelOrigin.origin, { name: 'Intramuros Hotel', kind: 'accommodation', latitude: 14.59, longitude: 120.975 });
  assert.equal(manifest.days[0].activities[0].place?.id, 'Q112');
  assert.equal(manifest.days[0].activities[1].place, null); assert.equal(manifest.days[0].activities[1].locationStatus, 'Choose an exact place');
  assert.equal(vaguePlace('Hotel New Otani'), false);
  for (const name of ['Local ramen shop', 'Nearby cafe', 'Lunch', 'Restaurant']) assert.equal(vaguePlace(name), true);
});
test('saved coordinates need matching verified city/country/source and valid bounds', () => {
  for (const changed of [{ countryCode: 'JP' }, { city: 'Makati' }, { latitude: 50 }, { latitude: 100 }, { sourceUrl: 'https://example.test/Q112' }, { provider: 'manual' }]) {
    const modified = structuredClone(trip); Object.assign(modified.itinerary.days[0].activities[0].place!, changed);
    assert.equal(buildTripMapManifest(modified).days[0].activities[0].place, null);
  }
  assert.equal(buildTripMapManifest({ ...trip, destinationCountry: 'Japan' }).anchor, null);
});
test('place photos are bound to the exact ID, location and licensed raster source; destination covers are rejected', async () => {
  const selected = { dayIndex: 0, activityIndex: 0 };
  const load = async (photos: typeof catalogPhoto[]) => resolveTripMapActivity(trip, selected, { photos: true, catalog: async () => ({ places: photos, status: 'live' }) });
  assert.equal((await load([catalogPhoto])).activity.place?.photo?.src, catalogPhoto.imageUrl);
  for (const invalid of [{ ...catalogPhoto, placeId: 'Q999' }, { ...catalogPhoto, longitude: 121.03 }, { ...catalogPhoto, imageUrl: 'https://images.unsplash.com/photo-city-cover' },
    { ...catalogPhoto, imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Flag_of_Philippines.png' }, { ...catalogPhoto, imageAttribution: undefined }]) {
    const result = await resolveTripMapActivity(trip, selected, { photos: true, catalog: async () => ({ places: [invalid], status: 'live' }) });
    assert.equal(result.activity.place?.photo, null);
  }
});
test('legacy places resolve only one exact catalog name; ambiguity leaves a chooser', async () => {
  const legacy = structuredClone(trip); delete (legacy.itinerary.days[0].activities[0] as { place?: unknown }).place;
  let calls = 0;
  const result = await loadTripMapManifest(legacy, async () => { calls++; return { places: [catalogPhoto], status: 'live' }; });
  assert.equal(calls, 1); assert.equal(result.days[0].activities[0].place?.id, 'Q112');
  assert.equal((await loadTripMapManifest(legacy, async () => ({ places: [catalogPhoto, { ...catalogPhoto, placeId: 'Q999' }], status: 'live' }))).days[0].activities[0].place, null);
});
test('explicit venue resolution includes full city/country, rejects foreign/nearby cities and caches requests', async () => {
  clearProviderCache(); let calls = 0;
  const anchor = buildTripMapManifest(trip).anchor!;
  const valid = { name: 'Named Venue', osm_type: 'node', osm_id: 100, lat: '14.6', lon: '120.98', display_name: 'Named Venue, Manila, Philippines',
    address: { city: 'Manila', country_code: 'ph' } };
  const fetcher = (async (url: string | URL | Request) => {
    calls++; const params = new URL(String(url)).searchParams; assert.equal(params.get('q'), 'Named Venue, Manila, Philippines'); assert.equal(params.get('countrycodes'), 'ph');
    return Response.json([valid, { ...valid, address: { city: 'Makati', country_code: 'ph' } }, { ...valid, address: { city: 'Manila', country_code: 'jp' } }, { ...valid, lat: '' }]);
  }) as typeof fetch;
  const result = await searchTripActivityPlaces('Named Venue', anchor, fetcher);
  assert.equal(result.length, 1); assert.equal(result[0].id, 'node:100');
  await searchTripActivityPlaces('Named Venue', anchor, fetcher); assert.equal(calls, 1);
  assert.deepEqual(await searchTripActivityPlaces('Local ramen shop', anchor, fetcher), []); assert.equal(calls, 1);
});
test('search never silently chooses a candidate; exact selection is session-only and invalid IDs fail', async () => {
  const candidate = { id: 'node:100', name: 'Named Venue', address: 'Manila', latitude: 14.6, longitude: 120.98, sourceUrl: 'https://www.openstreetmap.org/node/100', photo: null };
  const before = JSON.stringify(trip), search = async () => [candidate, { ...candidate, id: 'node:101' }];
  const input = { dayIndex: 0, activityIndex: 1, query: 'Named Venue' };
  assert.equal((await resolveTripMapActivity(trip, input, { search })).activity.place, null);
  assert.equal((await resolveTripMapActivity(trip, { ...input, placeId: 'node:101' }, { search })).activity.place?.id, 'node:101');
  await assert.rejects(resolveTripMapActivity(trip, { ...input, placeId: 'node:999' }, { search }), /no longer/);
  assert.equal(JSON.stringify(trip), before);
});
const routingPayload = { code: 'Ok', waypoints: [{ distance: 2 }, { distance: 3 }, { distance: 1 }], routes: [{
  distance: 1000, duration: 600, geometry: { type: 'LineString', coordinates: [[120.973,14.591],[120.975,14.592],[120.977,14.593]] },
  legs: [0,1].map(index => ({ steps: [{ name: 'Street', distance: 500, duration: 300, maneuver: { type: 'depart', location: [120.973 + index * .002,14.591 + index * .001] } }] })),
}] };
test('multi-stop routing preserves order and uses genuine mode datasets; distant road snapping is rejected', async () => {
  const points = [{ latitude: 14.591, longitude: 120.973 }, { latitude: 14.592, longitude: 120.975 }, { latitude: 14.593, longitude: 120.977 }];
  for (const [mode, profile] of [['walking','routed-foot'],['cycling','routed-bike'],['driving','routed-car']] as const) {
    const input = { origin: points[0], destination: points[2], mode };
    const result = await fetchNavigationRoute(input, { stops: points, reservePublicRequest: async () => true, fetcher: async url => {
      const parsed = new URL(String(url)); assert.ok(parsed.pathname.includes('/' + profile + '/')); assert.ok(parsed.pathname.endsWith('/120.973,14.591;120.975,14.592;120.977,14.593'));
      return Response.json(routingPayload);
    } });
    assert.equal(result.steps.length, 2); assert.equal(result.geometry.length, 3); assert.equal(result.destinationOffsetMeters, 1);
  }
  await assert.rejects(fetchNavigationRoute({ origin: points[0], destination: points[2], mode: 'walking' }, { stops: points, reservePublicRequest: async () => true,
    fetcher: async () => Response.json({ ...routingPayload, waypoints: [{ distance: 2 }, { distance: 200 }, { distance: 1 }] }) }), /too far/);
  assert.throws(() => parseNavigationRoute(routingPayload, { origin: points[0], destination: points[2], mode: 'walking' }), /incomplete/);
});
test('every new endpoint enforces signed ownership before provider calls and never writes trip state', async t => {
  t.mock.method(Math, 'random', () => .5);
  const user = { id: 'map-owner', name: 'Map owner', email: 'map@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 };
  const priorUser = prisma.user.findFirst, priorTrip = prisma.trip.findFirst, priorQuery = prisma.$queryRaw;
  Reflect.set(prisma.user, 'findFirst', async () => user);
  let reads = 0, providers = 0;
  Reflect.set(prisma.trip, 'findFirst', async (query: { where: { userId: string; id: string } }) => { reads++; assert.equal(query.where.userId, user.id); assert.equal(query.where.id, 'foreign'); return null; });
  Reflect.set(prisma, '$queryRaw', async () => [{ count: 1 }]);
  t.mock.method(globalThis, 'fetch', async () => { providers++; throw Error('Must not contact a provider for a foreign trip'); });
  t.after(() => { Reflect.set(prisma.user, 'findFirst', priorUser); Reflect.set(prisma.trip, 'findFirst', priorTrip); Reflect.set(prisma, '$queryRaw', priorQuery); });
  const cookie = 'travelmate_session=' + createSessionToken(user.id, 'traveler');
  for (const [handler, path, body] of [[GET_TRIP_MAP,'map',undefined],[POST_TRIP_ACTIVITY,'activity',{ dayIndex:0,activityIndex:0 }],[POST_TRIP_ACTIVITY_WEATHER,'weather',{ selection:{dayIndex:0,activityIndex:0} }],[POST_TRIP_DAY_ROUTE,'day-route',{dayIndex:0,mode:'walking'}]] as const) {
    const request = (authenticated: boolean) => new Request('http://localhost/api/navigation/trips/foreign/' + path, { method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { cookie } : {}), 'content-type':'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await handler(request(false))).status, 401);
    const result = await handler(request(true)); assert.equal(result.status, 404); assert.equal((await result.json()).error, 'Saved trip not found.');
  }
  assert.equal(reads, 4); assert.equal(providers, 0);
});

test('signed saved place photos are reused without a provider call; unsigned and tampered photos are ignored', async () => {
  const stored = structuredClone(trip);
  Object.assign(stored.itinerary.days[0].activities[0], { imageUrl: catalogPhoto.imageUrl, imageAttribution: catalogPhoto.imageAttribution });
  const plan = stored.itinerary as unknown as Parameters<typeof signGroundedPlan>[0] & { groundingProof?: string };
  plan.groundingProof = signGroundedPlan(plan);
  let calls = 0;
  const catalog = async () => { calls++; return { places: [], status: 'unavailable' as const }; };
  assert.equal((await resolveTripMapActivity(stored, { dayIndex: 0, activityIndex: 0 }, { photos: true, catalog })).activity.place?.photo?.src, catalogPhoto.imageUrl);
  assert.equal(calls, 0);
  delete plan.groundingProof;
  assert.equal((await resolveTripMapActivity(stored, { dayIndex: 0, activityIndex: 0 }, { photos: true, catalog })).activity.place?.photo, null);
  plan.groundingProof = signGroundedPlan(plan);
  Object.assign(stored.itinerary.days[0].activities[0], { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/City_cover.jpg' });
  assert.equal((await resolveTripMapActivity(stored, { dayIndex: 0, activityIndex: 0 }, { photos: true, catalog })).activity.place?.photo, null);
});

test('owned map reads saved data and rejects injected locations, modes and invalid selections before providers', async t => {
  t.mock.method(Math, 'random', () => .5);
  const user = { id: 'map-owner', name: 'Map owner', email: 'map@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 };
  const priorUser = prisma.user.findFirst, priorTrip = prisma.trip.findFirst, priorQuery = prisma.$queryRaw;
  const date = new Date('2026-10-09T00:00:00Z');
  Reflect.set(prisma.user, 'findFirst', async () => user);
  Reflect.set(prisma.trip, 'findFirst', async (query: { where: { userId: string; id: string } }) => { assert.equal(query.where.userId, user.id); assert.equal(query.where.id, trip.id); return { ...trip, userId: user.id, currency: 'PHP', budget: 20000, interests: [], startDate: date, endDate: date, createdAt: date, updatedAt: date }; });
  Reflect.set(prisma, '$queryRaw', async () => [{ count: 1 }]);
  t.after(() => { Reflect.set(prisma.user, 'findFirst', priorUser); Reflect.set(prisma.trip, 'findFirst', priorTrip); Reflect.set(prisma, '$queryRaw', priorQuery); });
  let providers = 0; t.mock.method(globalThis, 'fetch', async () => { providers++; throw Error('No provider request for invalid input'); });
  const cookie = 'travelmate_session=' + createSessionToken(user.id, 'traveler');
  const request = (path: string, body?: unknown) => new Request('http://localhost/api/navigation/trips/' + trip.id + '/' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const loaded = await GET_TRIP_MAP(request('map')); assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).map.days[1].date, trip.itinerary.days[1].date);
  assert.equal((await POST_TRIP_ACTIVITY(request('activity', { dayIndex: 0, activityIndex: 0, latitude: 50, longitude: 50 }))).status, 400);
  assert.equal((await POST_TRIP_DAY_ROUTE(request('day-route', { dayIndex: 0, mode: 'flying' }))).status, 400);
  assert.equal((await POST_TRIP_DAY_ROUTE(request('day-route', { dayIndex: 1, mode: 'walking', selections: [{ activityIndex: 49, query: 'Named venue', placeId: 'node:1' }] }))).status, 400);
  assert.equal((await POST_TRIP_ACTIVITY_WEATHER(request('weather', { selection: { dayIndex: 0, activityIndex: 0 }, date: '2040-01-01' }))).status, 400);
  const vague = await POST_TRIP_ACTIVITY_WEATHER(request('weather', { selection: { dayIndex: 0, activityIndex: 1 } }));
  assert.equal(vague.status, 200); assert.equal((await vague.json()).weather.status, 'unavailable'); assert.equal(providers, 0);
});

test('timeline mapping preserves saved durations, zero prices and currency; budgets never resolve to map stops', async () => {
  const saved = structuredClone(trip);
  Object.assign(saved.itinerary.days[0].activities[0], { durationMinutes: 60, estimatedCost: 0 });
  saved.itinerary.days[0].activities.push({ title: 'Daily meals in Manila', time: 'Daily allowance', description: 'Meals allowance', category: 'food', estimatedCost: 375 } as never);
  saved.itinerary.days[0].activities.push({ title: 'Daily transport allowance', time: 'Daily allowance', description: '', category: 'transport', estimatedCost: 125 } as never);
  for (const index of [0,2,3]) { const item = saved.itinerary.days[0].activities[index] as unknown as Record<string,unknown>; item.priceEvidence = {status:'estimate',source:'user-entered',basis:'Explicit party total',unit:'group',unitAmount:item.estimatedCost,quantity:1,participants:1,currency:'PHP',needsConfirmation:true,fetchedAt:'2026-10-16T00:00:00Z'}; }
  let calls = 0; const before = JSON.stringify(saved);
  const manifest = await loadTripMapManifest({ ...saved, currency: 'PHP' }, async () => { calls++; return { places: [], status: 'unavailable' }; });
  assert.equal(manifest.currency, 'PHP'); assert.equal(manifest.days[0].activities[0].durationMinutes, 60); assert.equal(manifest.days[0].activities[0].estimatedCost, 0);
  assert.equal(manifest.days[0].activities[2].budgetOnly, true); assert.equal(manifest.days[0].activities[2].estimatedCost, 375); assert.equal(manifest.days[0].activities[3].place, null); assert.equal(calls, 0);
  const budget = await resolveTripMapActivity(saved, { dayIndex: 0, activityIndex: 2, query: 'Venue', placeId: 'node:1' }, { search: async () => { throw Error('Budget must not search'); } });
  assert.equal(budget.activity.place, null); assert.equal(JSON.stringify(saved), before);
  assert.equal(isDailyBudgetEntry({ title: 'Lunch at Exact Restaurant', time: 'Daily allowance', category: 'food' }), false);
  assert.equal(isDailyBudgetEntry({ title: 'Daily meals', time: '12:00', category: 'food', place }), false);
  assert.equal(isDailyBudgetEntry({ title: 'Ippudo', time: 'Daily allowance', category: 'food' }), false);
  assert.equal(isDailyBudgetEntry({ title: 'Daily Food Market', time: '12:00', category: 'food' }), false);
  assert.equal(isDailyBudgetEntry({ title: 'Meal', time: '12:00', category: 'food' }), false);
  assert.equal(isDailyBudgetEntry({ title: 'Lunch', time: 'Flexible', category: 'food', location: 'Exact Restaurant' }), false);
});
test('route leg durations remain exact provider values and missing durations are not guessed from steps', () => {
  const input = { origin: { latitude: 14.591, longitude: 120.973 }, destination: { latitude: 14.593, longitude: 120.977 }, mode: 'walking' as const };
  assert.equal(parseNavigationRoute(routingPayload, input, 3).legDurationsSeconds, undefined);
  const payload = { ...routingPayload, routes: [{ ...routingPayload.routes[0], legs: routingPayload.routes[0].legs.map((leg, index) => ({ ...leg, duration: index ? 420.5 : 180 })) }] };
  assert.deepEqual(parseNavigationRoute(payload, input, 3).legDurationsSeconds, [180, 420.5]);
  payload.routes[0].legs[0].duration = -1; assert.throws(() => parseNavigationRoute(payload, input, 3), /incomplete/);
});

test('owned day routes exclude allowances, map provider legs to saved indices and reuse cached routing', async t => {
  clearProviderCache(); t.mock.method(Math, 'random', () => .5);
  const user = { id: 'timeline-owner', name: 'Timeline owner', email: 'timeline@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 };
  const saved = structuredClone(trip), date = new Date('2026-10-09T00:00:00Z');
  saved.itinerary.days[0].activities = [
    { title: 'Daily meals allowance', time: 'Daily allowance', category: 'food', estimatedCost: 375 },
    saved.itinerary.days[0].activities[0],
    { title: 'Second verified stop', time: '11:00', place: { ...place, placeId: 'Q113', name: 'Second verified stop', sourceUrl: 'https://www.wikidata.org/wiki/Q113', latitude: 14.592, longitude: 120.975 } },
    { title: 'Daily transport allowance', time: 'Daily allowance', category: 'transport', estimatedCost: 125 },
    { title: 'Third verified stop', time: '14:00', place: { ...place, placeId: 'Q114', name: 'Third verified stop', sourceUrl: 'https://www.wikidata.org/wiki/Q114', latitude: 14.593, longitude: 120.977 } },
  ] as never;
  const priorUser = prisma.user.findFirst, priorTrip = prisma.trip.findFirst, priorQuery = prisma.$queryRaw, before = JSON.stringify(saved);
  Reflect.set(prisma.user, 'findFirst', async () => user);
  Reflect.set(prisma.trip, 'findFirst', async (query: { where: { userId: string; id: string } }) => { assert.equal(query.where.userId, user.id); assert.equal(query.where.id, saved.id); return { ...saved, userId: user.id, currency: 'PHP', budget: 20000, interests: [], startDate: date, endDate: date, createdAt: date, updatedAt: date }; });
  Reflect.set(prisma, '$queryRaw', async () => [{ count: 1 }]);
  t.after(() => { Reflect.set(prisma.user, 'findFirst', priorUser); Reflect.set(prisma.trip, 'findFirst', priorTrip); Reflect.set(prisma, '$queryRaw', priorQuery); clearProviderCache(); });
  let requests = 0; t.mock.method(globalThis, 'fetch', async url => {
    requests++; assert.ok(new URL(String(url)).pathname.endsWith('/120.973,14.591;120.975,14.592;120.977,14.593'));
    return Response.json({ ...routingPayload, routes: [{ ...routingPayload.routes[0], legs: routingPayload.routes[0].legs.map((leg, index) => ({ ...leg, duration: index ? 420.5 : 180 })) }] });
  });
  const request = () => new Request('http://localhost/api/navigation/trips/' + saved.id + '/day-route', { method: 'POST', headers: { cookie: 'travelmate_session=' + createSessionToken(user.id, 'traveler'), 'content-type': 'application/json' }, body: JSON.stringify({ dayIndex: 0, mode: 'walking' }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await POST_TRIP_DAY_ROUTE(request()); assert.equal(result.status, 200); const data = await result.json();
    assert.deepEqual(data.stopIndices, [1, 2, 4]); assert.equal(data.totalActivities, 3);
    assert.deepEqual(data.travelLegs, [{ fromActivityIndex: 1, toActivityIndex: 2, durationSeconds: 180 }, { fromActivityIndex: 2, toActivityIndex: 4, durationSeconds: 420.5 }]);
  }
  assert.equal(requests, 1); assert.equal(JSON.stringify(saved), before);
  Object.assign(saved.itinerary.days[0].activities[2],{status:'skipped'});
  clearProviderCache();
  t.mock.method(globalThis,'fetch',async url=>{assert.ok(new URL(String(url)).pathname.endsWith('/120.973,14.591;120.977,14.593'));return Response.json({...routingPayload,waypoints:[routingPayload.waypoints[0],routingPayload.waypoints[2]],routes:[{...routingPayload.routes[0],legs:[{...routingPayload.routes[0].legs[0],duration:600}]}]});});
  const skippedRoute=await POST_TRIP_DAY_ROUTE(request());assert.equal(skippedRoute.status,200);
  const skippedData=await skippedRoute.json();assert.deepEqual(skippedData.stopIndices,[1,4]);assert.equal(skippedData.totalActivities,2);assert.match(skippedData.message,/skipped activities are excluded/);
});
