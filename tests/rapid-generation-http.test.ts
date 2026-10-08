import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { POST } from '../src/controllers/itinerary-controller.ts';
import { sealQuote, type QuoteTicket } from '../src/services/travel/hotel-quote.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
after(() => prisma.$disconnect());
function replace(t: TestContext, object: object, key: string, implementation: unknown) {
  const previous = Reflect.get(object, key); Reflect.set(object, key, implementation);
  t.after(() => Reflect.set(object, key, previous));
}
test('authenticated generation rechecks the exact offer and retains its group total, occupancy and photo reference', async t => {
  replace(t, prisma.user, 'findFirst', async () => ({ id: 'room-http', name: 'Test', email: 'guest@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true, profileStatus: 'unverified', trustScore: 50 }));
  replace(t, prisma, '$queryRaw', async () => [{ count: 1 }]);
  replace(t, prisma.listing, 'findMany', async () => []);
  replace(t, prisma.itineraryGeneration, 'findUnique', async () => null);
  replace(t, prisma.itineraryGeneration, 'create', async () => ({ id: 'generation', attemptId: 'attempt' }));
  replace(t, prisma.itineraryGeneration, 'updateMany', async () => ({ count: 1 }));
  replace(t, Math, 'random', () => 0.5);
  const prior = { ...process.env };
  const settings = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-only', AI_MOCK_FALLBACK: 'false', SESSION_SECRET: 'rapid-generation-test-secret-at-least-32-characters', RAPID_API_KEY: 'fixture', RAPID_API_SECRET: 'fixture', RAPID_ENV: 'production' };
  Object.assign(process.env, settings); delete process.env.GEMINI_API_KEY;
  t.after(() => { for (const key of [...Object.keys(settings),'GEMINI_API_KEY']) { if(prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  const tokyo = searchDestinationIndex('Tokyo, Japan').find(place => place.name === 'Tokyo')!;
  const quote = { provider: 'expedia-rapid' as const, propertyId: '123', roomId: 'family', offerId: 'rate', roomType: 'Family room', checkInDate: '2040-01-01', checkOutDate: '2040-01-03', occupancy: [{ adults: 2, childAges: [5] }], currency: 'JPY' as const, total: 12345, nightlyAverage: 6173, taxesAndFeesIncluded: true, payableAtProperty: [{ amount: 300, currency: 'JPY' }], priceBreakdown: [], photoReferences: ['123:exterior'], checkedAt: new Date().toISOString(), isLive: true };
  const ticket: QuoteTicket = { userId: 'room-http', expiresAt: Date.now()+60000, destination: tokyo.label, latitude: tokyo.latitude, longitude: tokyo.longitude, priceCheckPath: '/v3/properties/123/rooms/family/rates/rate?token=private', property: { id: 'rapid:123:family:rate', propertyId: '123', name: 'Official Tokyo Hotel', nameSource: 'provider-english', address: 'Tokyo, Japan', type: 'Hotel', latitude: tokyo.latitude, longitude: tokyo.longitude, distanceKm: 0, amenities: [], photos: [], availability: 'available', quote } };
  let priceStatus = 'matched', checks = 0;
  replace(t, globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith('https://api.ean.com/')) { checks++; assert.equal(new URL(String(url)).pathname, '/v3/properties/123/rooms/family/rates/rate'); return Response.json({ status: priceStatus }); }
    if (String(url).includes('api.openai.com')) {
      const payload = JSON.parse(String(init?.body));
      const [, count, first] = payload.messages[1].content.match(/Plan (\d+) days, starting (\d{4}-\d{2}-\d{2})/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ days: Array.from({ length: Number(count) }, (_,i) => ({ day: i+1, date: new Date(Date.parse(first)+i*86400000).toISOString().slice(0,10), theme: 'Explore', visits: [] })) }) } }] });
    }
    return Response.json({}, { status: 503 });
  });
  const body = { destination: tokyo.label, destinationDetails: { city: tokyo.name, country: tokyo.country, countryCode: tokyo.countryCode, latitude: tokyo.latitude, longitude: tokyo.longitude }, latitude: tokyo.latitude, longitude: tokyo.longitude, startDate: quote.checkInDate, endDate: quote.checkOutDate, budget: 100000, currency: 'JPY', travelers: 3, partyType: 'family', rooms: 1, selectedAccommodationQuote: sealQuote(ticket) };
  const generate = (value: unknown) => POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'travelmate_session='+createSessionToken('room-http','traveler') }, body: JSON.stringify(value) }));
  const response = await generate(body); const itinerary = await response.json();
  assert.equal(response.status, 200, JSON.stringify(itinerary));
  assert.equal(itinerary.accommodation.total, 12345);
  assert.equal(itinerary.accommodation.rooms, 1);
  assert.deepEqual(itinerary.accommodation.providerQuote.occupancy, quote.occupancy);
  assert.deepEqual(itinerary.accommodation.providerQuote.photoReferences, ['123:exterior']);
  assert.ok(itinerary.accommodation.providerQuote.revalidatedAt);
  assert.equal(itinerary.grounding.categories.accommodation, 12345);
  assert.equal(verifyGroundedPlan(itinerary), true);
  assert.equal(checks, 1);
  const mismatch = await generate({ ...body, endDate: '2040-01-04' }); assert.equal(mismatch.status, 409);
  assert.equal(checks, 1);
  priceStatus = 'price_changed';
  const changed = await generate(body); assert.equal(changed.status, 409);
  assert.match((await changed.json()).error, /price changed/);
});
