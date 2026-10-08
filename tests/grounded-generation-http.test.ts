import assert from 'node:assert/strict';
import { test, after, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { POST, POST_IMAGES } from '../src/controllers/itinerary-controller.ts';
import { verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { createTravelSelectionToken } from '../src/utils/travel-selection-token.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';

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
  assert.equal(verifyGroundedPlan(itinerary), true); assert.ok(itinerary.days.every(day => day.imageUrl === '' && day.activities.every(activity => activity.priceEvidence.status === 'estimate')));
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
