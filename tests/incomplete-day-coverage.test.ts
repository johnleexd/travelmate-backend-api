import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { retrieveGroundedPlaces, type GroundedPlace, type PlaceCoverage } from '../src/services/itinerary/grounded-places.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { retryIncompleteDays } from '../src/services/itinerary/incomplete-day-retry.ts';
import { itineraryContext } from '../src/services/itinerary/itinerary-provenance.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { clearProviderCache, withProviderCache } from '../src/services/cache/provider-cache.ts';
import type { DestinationAnchor } from '../src/services/itinerary/grounding-schema.ts';
import { POST_RETRY_DAYS } from '../src/controllers/incomplete-day-controller.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { prisma } from '../src/lib/prisma.ts';
import { refreshGroundedTotals } from '../src/services/itinerary/grounded-plan.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
after(() => prisma.$disconnect());

const anchor: DestinationAnchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
const entities: Record<string, unknown> = { Q1: { labels: { en: { value: 'Paris' } } }, Q2: { claims: { P297: claim('FR') } } };
for (let index = 100; index < 130; index++) entities[`Q${index}`] = { labels: { en: { value: `Reference museum ${index}` } }, descriptions: { en: { value: 'museum in Paris' } }, claims: { P131: claim({ id: 'Q1' }), P17: claim({ id: 'Q2' }) } };
const page = (index: number, coordinates = true) => ({ pageid: index, title: `Reference museum ${index}`, ...(coordinates ? { coordinates: [{ lat: anchor.latitude + index / 100000, lon: anchor.longitude }] } : {}), pageprops: { wikibase_item: `Q${index}` } });
const pages = (from: number, to: number) => Object.fromEntries(Array.from({ length: to - from }, (_, offset) => [from + offset, page(from + offset)]));

test('bounded discovery follows continuation and merges property pages before validation', async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url);
    if (url.searchParams.get('action') === 'wbgetentities') return Response.json({ entities });
    if (url.searchParams.get('ggscontinue') === 'next') return Response.json({ query: { pages: pages(100, 108) } });
    return Response.json({ continue: { continue: 'ggs||coordinates', ggscontinue: 'next' }, query: { pages: { 100: page(100, false) } } });
  };
  let coverage: PlaceCoverage | undefined;
  const result = await retrieveGroundedPlaces(anchor, fetcher, undefined, false, { tripDays: 2, diagnostics: value => { coverage = value; } });
  assert.equal(result.length, 8);
  assert.equal(new Set(result.map(place => place.placeId)).size, 8);
  assert.ok(requests.some(url => url.searchParams.get('ggscontinue') === 'next' && url.searchParams.get('continue') === 'ggs||coordinates'));
  assert.equal(coverage?.uniqueCandidates, 8);
  assert.equal(coverage?.articles, 9);
});

test('seven-day targets continue beyond the old six-place threshold and add category queries', async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url);
    if (url.searchParams.get('action') === 'wbgetentities') return Response.json({ entities });
    const search = url.searchParams.get('gsrsearch') ?? '';
    return Response.json({ query: { pages: search.includes('museum OR') ? pages(100, 121) : pages(100, 106) } });
  };
  const result = await retrieveGroundedPlaces(anchor, fetcher, undefined, false, { tripDays: 7 });
  assert.equal(result.length, 21);
  assert.ok(requests.some(url => /museum OR/.test(url.searchParams.get('gsrsearch') ?? '')));
  const schedule = completeGroundedSchedule(anchor, result, [], '2026-10-16', 7, 2, 'balanced');
  assert.deepEqual(schedule.map(day => day.visits.length), [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(new Set(schedule.flatMap(day => day.visits.map(visit => visit.placeId))).size, 21);
});

test('partial provider failures retain verified records without prices, photos or opening hours', async () => {
  let coverage: PlaceCoverage | undefined;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.get('action') === 'wbgetentities') return Response.json({ entities });
    if (url.searchParams.get('generator') === 'geosearch') return Response.json({ query: { pages: pages(100, 103) } });
    return Response.json({}, { status: 503 });
  };
  const result = await retrieveGroundedPlaces(anchor, fetcher, undefined, false, { tripDays: 7, diagnostics: value => { coverage = value; } });
  assert.equal(result.length, 3);
  assert.equal(coverage?.outcome, 'partial');
  assert.ok(coverage!.providerFailures > 0);
  assert.ok(result.every(place => !place.imageUrl && !place.admission && !place.openingWindows));
});

const places = (count: number): GroundedPlace[] => Array.from({ length: count }, (_, index) => ({ provider: 'wikidata', placeId: `Q${100 + index}`, name: `Museum ${index}`, description: 'museum', ...anchor,
  latitude: anchor.latitude + index / 100000, sourceUrl: `https://www.wikidata.org/wiki/Q${100 + index}`, fetchedAt: '2026-10-16T00:00:00Z', openingHours: 'Opening hours need confirmation', address: 'Not available' }));
function plan(count = 3) {
  const catalog = places(count);
  return buildGroundedPlan({ destination: 'Paris, France', anchor, startingLocation: '', startDate: '2026-10-16', endDate: '2026-10-22', budget: 40000, currency: 'EUR', travelers: 2, partyType: 'couple', rooms: 1, places: catalog, placeDataStatus: 'live', source: 'catalog', transportation: '', schedule: completeGroundedSchedule(anchor, catalog, [], '2026-10-16', 7, 2, 'balanced') });
}

test('retry adds only unused places to selected days, preserves every previous activity and stays savable', () => {
  const original = plan(3), snapshot = structuredClone(original);
  const result = retryIncompleteDays(original, [3, 4, 5, 6], { places: places(14), status: 'live' });
  assert.ok(result.added > 0);
  assert.deepEqual(original, snapshot);
  for (let index = 0; index < 3; index++) assert.deepEqual(result.itinerary.days[index], original.days[index]);
  for (const [index, day] of original.days.entries()) for (const activity of day.activities) assert.deepEqual(result.itinerary.days[index].activities.find(item => item.id === activity.id), activity);
  assert.match(result.itinerary.days[3].theme, /^Paris: Museum/);
  const visits = result.itinerary.days.flatMap(day => day.activities.filter(item => item.place));
  assert.equal(new Set(visits.map(item => item.place!.placeId)).size, visits.length);
  assert.ok(visits.every(item => item.time === 'Flexible'));
  assert.ok(verifyGroundedPlan(result.itinerary));
  assert.doesNotThrow(() => parseSavedItinerary(result.itinerary, itineraryContext(result.itinerary)));
});

test('empty, failed and scheduling-conflict outcomes remain distinct and nearby retry is opt-in', () => {
  const original = plan(1);
  const empty = retryIncompleteDays(original, [1], { places: [], status: 'live' });
  assert.equal(empty.added, 0); assert.equal(empty.itinerary.days[1].planningIssue, 'no-results');
  const failed = retryIncompleteDays(original, [1], { places: [], status: 'unavailable' });
  assert.equal(failed.itinerary.days[1].planningIssue, 'provider-failure');
  const closed = places(2)[1]; closed.openingWindows = [{ weekdays: [6], startMinutes: 600, endMinutes: 610 }];
  const conflict = retryIncompleteDays(original, [1], { places: [closed], status: 'live' });
  assert.equal(conflict.added, 0); assert.equal(conflict.itinerary.days[1].planningIssue, 'scheduling-conflict');
});

test('forced retries bypass fresh negative caches and structured provider failures expire quickly', async () => {
  clearProviderCache(); let calls = 0;
  const policy = { source: 'activities' as const, freshForMs: 10000, staleForMs: 20000, emptyForMs: 100, isEmpty: (value: unknown) => !(value as { places: unknown[] }).places.length };
  const load = async () => { calls++; return { places: [] }; };
  await withProviderCache('retry', policy, load, 1000);
  await withProviderCache('retry', policy, load, 1050); assert.equal(calls, 1);
  await withProviderCache('retry', policy, load, 1050, true); assert.equal(calls, 2);
  await withProviderCache('retry', policy, load, 1200); assert.equal(calls, 3);
});

test('nearby candidates require opt-in, retain their locality label and obey travel feasibility', () => {
  const original = plan(1), nearby = { ...places(2)[1], city: 'Neighboring municipality', locationScope: 'nearby' as const, selectedCity: anchor.city, distanceFromDestinationKm: 0, membershipSourceUrl: 'https://www.openstreetmap.org/relation/123' };
  assert.equal(retryIncompleteDays(original, [1], { places: [nearby], status: 'live' }).added, 0);
  const result = retryIncompleteDays(original, [1], { places: [nearby], status: 'live' }, true);
  assert.equal(result.added, 1);
  assert.match(result.itinerary.days[1].activities.find(item => item.place)!.description, /Nearby attraction: Neighboring municipality.*outside Paris/);
});

test('optional oversized AI durations do not discard otherwise feasible verified visits', () => {
  const catalog = places(1);
  const days = completeGroundedSchedule(anchor, catalog, [{ day: 1, date: '2026-10-16', theme: 'AI suggestion', visits: [{ placeId: catalog[0].placeId, startMinutes: 540, durationMinutes: 720, participants: 2 }] }], '2026-10-16', 1, 2, 'balanced');
  assert.equal(days[0].visits.length, 1);
  assert.equal(days[0].visits[0].durationMinutes, 90);
});

test('bounded continuation stops repeated tokens and throttled hydration is not repeatedly requested', async () => {
  let entityRequests = 0, discoveryRequests = 0;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.wikidata.org') { entityRequests++; return Response.json({}, { status: 429 }); }
    discoveryRequests++;
    return Response.json({ continue: { continue: 'same', ggscontinue: 'same' }, query: { pages: pages(100, 108) } });
  };
  await assert.rejects(() => retrieveGroundedPlaces(anchor, fetcher, undefined, false, { tripDays: 31 }), /provider request failed/);
  assert.equal(entityRequests, 1);
  assert.ok(discoveryRequests <= 16);
});

test('cached administrative ancestors are traversed and a nested district does not relabel a verified city place', async () => {
  clearProviderCache();
  const localEntities = { ...entities, Q3: { labels: { en: { value: 'Central district' } }, descriptions: { en: { value: 'district' } }, claims: { P131: claim({ id: 'Q1' }), P625: claim({ latitude: anchor.latitude, longitude: anchor.longitude }) } },
    Q100: { labels: { en: { value: 'Local museum' } }, descriptions: { en: { value: 'museum' } }, claims: { P131: claim({ id: 'Q3' }), P17: claim({ id: 'Q2' }) } },
    Q101: { labels: { en: { value: 'Unassigned museum' } }, descriptions: { en: { value: 'museum' } }, claims: {} } };
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: Object.fromEntries(url.searchParams.get('ids')!.split('|').map(id => [id, localEntities[id as keyof typeof localEntities] ?? {}])) });
    if (url.hostname === 'nominatim.openstreetmap.org') return Response.json(url.searchParams.get('q')?.startsWith('Central district,') ? [{ osm_type: 'relation', osm_id: 123, type: 'administrative', addresstype: 'district', name: 'Central district', extratags: { wikidata: 'Q3' }, address: { country_code: 'fr' }, geojson: { type: 'Polygon', coordinates: [[[2,48],[3,48],[3,49],[2,49],[2,48]]] } }] : []);
    return Response.json({ query: { pages: { 100: page(100), 101: page(101), 1: { pageid: 1, title: 'Paris', pageprops: { wikibase_item: 'Q1' } } } } });
  };
  const result = await retrieveGroundedPlaces(anchor, fetcher, undefined, false);
  const museum = result.find(place => place.placeId === 'Q100');
  assert.equal(museum?.city, 'Paris'); assert.equal(museum?.locationScope, 'city');
});

test('retry preserves departure constraints, exact user reservations and removed or renamed place exclusions across refreshes', () => {
  const original = plan(1);
  original.grounding!.scheduleConstraints = { departureTime: '12:00', restDates: [] };
  refreshGroundedTotals(original);
  const edited = structuredClone(original); edited.days[0].activities[0].title = 'My renamed visit';
  const manual = applyManualItineraryChanges(original, edited, 7, 40000, 2, 'EUR') as unknown as typeof original;
  assert.equal(manual.days[0].activities[0].place, undefined);
  const first = retryIncompleteDays(manual, [1], { places: places(6), status: 'live' }, false, original);
  assert.ok(first.itinerary.grounding!.previousPlaceIds!.includes('Q100'));
  assert.ok(!first.itinerary.days[1].activities.some(item => item.place?.placeId === 'Q100'));
  const refreshed = JSON.parse(JSON.stringify(first.itinerary));
  const next = retryIncompleteDays(refreshed, [6], { places: places(8), status: 'live' });
  assert.ok(next.itinerary.days[6].activities.filter(item => item.place).reduce((sum, item) => sum + item.durationMinutes!, 0) <= 60);
  assert.ok(!next.itinerary.days[6].activities.some(item => item.place?.placeId === 'Q100'));
  const reserved = plan(1); reserved.days[1].activities.unshift({ ...reserved.days[0].activities[0], id: 'reservation', time: '17:30', durationMinutes: 30 });
  refreshGroundedTotals(reserved);
  assert.equal(retryIncompleteDays(reserved, [1], { places: places(8), status: 'live' }).added, 0);
});

test('authenticated retry endpoint validates provenance, preserves an edited browser draft and never writes or invokes AI', async t => {
  clearProviderCache();
  const replace = (object: object, key: string, value: unknown) => { const old = Reflect.get(object, key); Reflect.set(object, key, value); t.after(() => Reflect.set(object, key, old)); };
  replace(prisma.user, 'findFirst', async () => ({ id: 'retry-owner', role: 'traveler', name: 'Test', email: 'retry@example.test', emailVerified: true, accountStatus: 'active', profileStatus: 'unverified', trustScore: 50 }));
  replace(prisma, '$queryRaw', async () => [{ count: 1 }]);
  replace(prisma.trip, 'create', async () => { throw new Error('Retry must not save a trip'); });
  const original = plan(1), edited = structuredClone(original); edited.days[0].activities[0].description = 'Preserve my edited notes';
  replace(prisma.trip, 'findFirst', async ({ where }: any) => { assert.equal(where.userId, 'retry-owner'); return null; });
  replace(prisma.itineraryGeneration, 'findFirst', async ({ where }: any) => { assert.equal(where.userId, 'retry-owner'); return { response: original }; });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.ok(['en.wikipedia.org', 'fr.wikipedia.org', 'www.wikidata.org'].includes(url.hostname), 'Only place reference requests are allowed');
    return Response.json(url.hostname === 'www.wikidata.org' ? { entities } : { query: { pages: pages(100, 121) } });
  });
  const request = (body: unknown, auth = true) => new Request('http://localhost/api/itinerary/retry-days', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: `travelmate_session=${createSessionToken('retry-owner', 'traveler')}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await POST_RETRY_DAYS(request({ itinerary: edited, days: [1] }, false))).status, 401);
  const response = await POST_RETRY_DAYS(request({ itinerary: edited, days: [1] }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.added > 0); assert.equal(result.itinerary.days[0].activities[0].description, 'Preserve my edited notes');
  assert.ok(verifyGroundedPlan(result.itinerary));
  const forged = structuredClone(edited); forged.grounding!.destination.latitude = 0;
  replace(prisma.itineraryGeneration, 'findFirst', async () => null);
  assert.equal((await POST_RETRY_DAYS(request({ itinerary: forged, days: [1] }))).status, 422);
});
