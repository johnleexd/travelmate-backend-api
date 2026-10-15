import assert from 'node:assert/strict';
import { test, after, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { POST, POST_IMAGES } from '../src/controllers/itinerary-controller.ts';
import { verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { createTravelSelectionToken } from '../src/utils/travel-selection-token.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';

after(() => prisma.$disconnect());
function replace(t: TestContext, object: object, key: string, implementation: (...args: any[]) => unknown) {
  const previous = Reflect.get(object, key); Reflect.set(object, key, implementation);
  t.after(() => Reflect.set(object, key, previous));
}
test('authenticated generation validates inputs, unavailable sources, full response, photo refresh and insufficient budgets without a database', async t => {
  replace(t, prisma.user, 'findFirst', async () => ({ id: 'grounded-http', name: 'Test', email: 'test@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 }));
  replace(t, prisma, '$queryRaw', async () => [{ count: 1 }]);
  replace(t, prisma.listing, 'findMany', async () => []);
  replace(t, prisma.itineraryGeneration, 'findUnique', async () => null);
  replace(t, prisma.itineraryGeneration, 'create', async () => ({ id: 'generation', attemptId: 'attempt' }));
  replace(t, prisma.itineraryGeneration, 'updateMany', async () => ({ count: 1 }));
  t.mock.method(Math, 'random', () => 0.5);
  const prior = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-only', AI_MOCK_FALLBACK: 'false' }); delete process.env.GEMINI_API_KEY;
  t.after(() => { for (const key of ['AI_PROVIDER','OPENAI_API_KEY','GEMINI_API_KEY','AI_MOCK_FALLBACK']) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).includes('api.openai.com')) {
      const body = JSON.parse(String(init?.body));
      const [, count, first] = body.messages[1].content.match(/Plan (\d+) days, starting (\d{4}-\d{2}-\d{2})/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ days: Array.from({ length: Number(count) }, (_, i) => ({ day: i + 1, date: new Date(Date.parse(first) + i * 86400000).toISOString().slice(0, 10), theme: 'Flexible', visits: [] })) }) } }] });
    }
    return Response.json({}, { status: 503 });
  });
  const paris = searchDestinationIndex('Paris, France').find(place => place.name === 'Paris')!;
  const body = { destination: paris.label, destinationDetails: { city: paris.name, country: paris.country, countryCode: paris.countryCode, latitude: paris.latitude, longitude: paris.longitude }, latitude: paris.latitude, longitude: paris.longitude, startingLocation: 'Toronto, Canada', startDate: '2040-01-25', endDate: '2040-02-24', budget: 100000, currency: 'EUR', travelers: 3, partyType: 'friends' };
  const headers = { cookie: `travelmate_session=${createSessionToken('grounded-http', 'traveler')}`, 'content-type': 'application/json' };
  const generate = (value: unknown) => POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers, body: JSON.stringify(value) }));
  for (const missing of ['destinationDetails', 'latitude', 'longitude']) { const invalid = { ...body } as Record<string, unknown>; delete invalid[missing]; assert.equal((await generate(invalid)).status, 400); }
  const withoutOrigin = { ...body } as Record<string, unknown>; delete withoutOrigin.startingLocation;
  const noOriginResponse = await generate(withoutOrigin);
  assert.equal(noOriginResponse.status, 200, JSON.stringify(await noOriginResponse.clone().json()));
  const noOriginPlan = await noOriginResponse.json();
  assert.equal(noOriginPlan.grounding.startingLocation, '');
  assert.equal(verifyGroundedPlan(noOriginPlan), true);
  const response = await generate(body); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const itinerary = await response.json();
  assert.equal(itinerary.days.length, 31); assert.equal(itinerary.grounding.placeDataStatus, 'unavailable'); assert.equal(itinerary.grounding.verifiedAmount, 0); assert.equal(itinerary.grounding.budgetStatus, 'needs-confirmation');
  assert.ok(itinerary.days.every(day => day.planningStatus === 'incomplete' && /unavailable/.test(day.planningReason)));
  assert.equal(verifyGroundedPlan(itinerary), true); assert.ok(itinerary.days.every(day => day.imageUrl === '' && day.activities.every(activity => activity.priceEvidence.status === 'unavailable' && activity.estimatedCost === 0)));
  const photos = await POST_IMAGES(new Request('http://localhost/api/itinerary/images', { method: 'POST', headers, body: JSON.stringify({ destination: body.destination, day: itinerary.days[0], itinerary }) }));
  assert.equal(photos.status, 200); assert.equal((await photos.json()).day.imageUrl, '');
  const quote = { kind: 'activity' as const, id: 'amadeus:fixture', name: 'Provider activity', price: 20, currency: 'EUR', fetchedAt: new Date().toISOString(), isLive: true, destination: body.destination, tripContext: JSON.stringify([body.latitude, body.longitude, 'EUR']) };
  const quotedResponse = await generate({ ...body, selectedActivities: [{ ...quote, selectionToken: createTravelSelectionToken(quote) }] });
  assert.equal(quotedResponse.status, 200);
  const quotedPlan = await quotedResponse.json();
  assert.equal(quotedPlan.selectedTravelCosts.activities[0].source, 'amadeus');
  assert.equal(quotedPlan.selectedTravelCosts.activities[0].priceBasis, 'per-person-assumption');
  assert.equal(quotedPlan.selectedTravelCosts.activities[0].total, 60);
  assert.equal(quotedPlan.grounding.verifiedAmount, 0);
  const foreign = { ...quote, tripContext: JSON.stringify([35, 139, 'EUR']) };
  assert.equal((await generate({ ...body, selectedActivities: [{ ...foreign, selectionToken: createTravelSelectionToken(foreign) }] })).status, 400);
  const insufficient = await generate({ ...body, budget: 10, foodDailyPerPerson: 100 }); assert.equal(insufficient.status, 422); assert.match((await insufficient.json()).error, /exceed/);
});

test('new generation preserves populated schedules and honestly falls back during missing AI credentials or provider outages', async t => {
  clearProviderCache(); t.after(clearProviderCache);
  replace(t, prisma.user, 'findFirst', async () => ({ id: 'catalog-http', name: 'Test', email: 'test@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 }));
  replace(t, prisma, '$queryRaw', async () => [{ count: 1 }]);
  replace(t, prisma.listing, 'findMany', async () => []);
  replace(t, prisma.itineraryGeneration, 'findUnique', async () => null);
  replace(t, prisma.itineraryGeneration, 'create', async () => ({ id: 'generation', attemptId: 'attempt' }));
  let persisted: unknown;
  replace(t, prisma.itineraryGeneration, 'updateMany', async args => { if (args.data.response) persisted = JSON.parse(JSON.stringify(args.data.response)); return { count: 1 }; });
  const keys = ['AI_PROVIDER', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_MOCK_FALLBACK'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-only', AI_MOCK_FALLBACK: 'false' }); delete process.env.GEMINI_API_KEY;
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const paris = searchDestinationIndex('Paris, France').find(place => place.name === 'Paris')!;
  const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
  let failAI = false, failPlaces = false, failPhotos = false, photoRequests = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    if (url.hostname === 'api.unsplash.com') return Response.json({}, { status: 503 });
    if (url.hostname === 'api.openai.com') return failAI ? Response.json({}, { status: 503 }) : Response.json({ choices: [{ message: { content: JSON.stringify({ days: [0,1,2].map(i => ({ day: i + 1, date: `2040-01-${25 + i}`, theme: 'Sparse output', visits: i ? [] : [{ placeId: 'Q200', startMinutes: 600, durationMinutes: 60, participants: 1 }] })) }) } }] });
    if (url.hostname === 'en.wikipedia.org' && !failPlaces) {
      if (url.searchParams.get('prop')?.includes('pageimages')) {
        const title = url.searchParams.get('titles') || '', index = Number(title.match(/\d+$/)?.[0]);
        return Response.json({ query: { pages: { 1: { pageid: 1, title, pageimage: `${title}.jpg`, coordinates: [{ lat: paris.latitude + index * 0.0001, lon: paris.longitude }], pageprops: { wikibase_item: `Q${200 + index}` } } } } });
      }
      assert.equal(url.searchParams.get('colimit'), 'max'); assert.equal(url.searchParams.get('ggsradius'), '10000');
      return Response.json({ query: { pages: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, { pageid: i + 1, title: `Synthetic museum ${i}`, coordinates: [{ lat: paris.latitude + i * 0.0001, lon: paris.longitude }], pageprops: { wikibase_item: `Q${200 + i}` } }])) } });
    }
    if (url.hostname === 'www.wikidata.org' && !failPlaces) return Response.json({ entities: { Q1: { labels: { en: { value: 'Paris' } } }, Q2: { claims: { P297: claim('FR') } }, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Q${200 + i}`, { labels: { en: { value: `Synthetic museum ${i}` } }, descriptions: { en: { value: 'museum in Paris, France' } }, claims: { P18: claim(`Synthetic museum ${i}.jpg`), P131: claim({ id: 'Q1' }), P17: claim({ id: 'Q2' }), ...(i === 11 ? { P576: claim({ time: '+1945-01-01T00:00:00Z' }) } : {}) } }])) } });
    if (url.hostname === 'commons.wikimedia.org' && !failPlaces) {
      photoRequests++;
      if (failPhotos) return Response.json({}, { status: 503 });
      const titles = (url.searchParams.get('titles') || '').split('|');
      return Response.json({ query: { pages: Object.fromEntries(titles.map((title, index) => [100 + index, { pageid: 100 + index, title, imageinfo: [{ mime: 'image/jpeg', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/' + encodeURIComponent(title.slice(5)), extmetadata: { Artist: { value: 'Fixture photographer' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, ImageDescription: { value: title } } }] }])) } });
    }
    return Response.json({}, { status: 503 });
  });
  const body = { destination: paris.label, destinationDetails: { city: paris.name, country: paris.country, countryCode: paris.countryCode, latitude: paris.latitude, longitude: paris.longitude }, latitude: paris.latitude, longitude: paris.longitude, startDate: '2040-01-25', endDate: '2040-01-27', budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo' };
  const generate = (extra = {}) => POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers: { cookie: `travelmate_session=${createSessionToken('catalog-http', 'traveler')}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) }));
  const result = await generate(); assert.equal(result.status, 200); const populated = await result.json();
  assert.deepEqual(populated.days.map(day => day.activities.filter(a => a.category === 'activity').length), [3,3,3]);
  assert.ok(populated.days.every(day => day.planningStatus === 'suggested'));
  assert.ok(populated.days.flatMap(day => day.activities).every(a => a.place?.placeId !== 'Q211'));
  assert.deepEqual(persisted, populated); assert.equal(verifyGroundedPlan(populated), true);
  assert.ok(populated.days.flatMap(day => day.activities).filter(activity => activity.place).every(activity => activity.imageUrl && activity.imageAttribution?.photoType === 'place'));
  assert.ok(photoRequests > 0);
  const original = JSON.stringify(populated);
  clearProviderCache(); failPhotos = true;
  const photoOutageStarted = Date.now();
  const photoOutageResponse = await generate(); assert.equal(photoOutageResponse.status, 200);
  const photoOutage = await photoOutageResponse.json();
  assert.deepEqual(photoOutage.days.map(day => day.activities.filter(activity => activity.place).map(activity => activity.title)), populated.days.map(day => day.activities.filter(activity => activity.place).map(activity => activity.title)));
  assert.ok(photoOutage.days.flatMap(day => day.activities).filter(activity => activity.place).every(activity => !activity.imageUrl));
  // The bounded photo phase now allows 25 seconds so paced metadata requests
  // can finish; an outage must still return rather than stall generation.
  assert.ok(Date.now() - photoOutageStarted < 33000);
  assert.equal(verifyGroundedPlan(photoOutage), true);
  failPhotos = false; clearProviderCache();
  failAI = true;
  const failed = await generate(); assert.equal(failed.status, 200); const fallback = await failed.json();
  assert.equal(fallback.source, 'catalog'); assert.ok(fallback.grounding.limitations.some(note => note.includes('AI scheduling was unavailable')));
  delete process.env.OPENAI_API_KEY;
  const missing = await generate(); assert.equal(missing.status, 200); assert.equal((await missing.json()).source, 'catalog');
  clearProviderCache(); failPlaces = true;
  const partialResult = await generate(); assert.equal(partialResult.status, 200); const partial = await partialResult.json();
  assert.equal(partial.grounding.placeDataStatus, 'unavailable');
  assert.ok(partial.days.every(day => day.planningStatus === 'incomplete' && day.activities.every(a => ['food','transport'].includes(a.category))));
  assert.equal(JSON.stringify(populated), original);
  assert.equal((await generate({ scheduleConstraints: { restDates: ['2040-99-01'] } })).status, 400);
});
