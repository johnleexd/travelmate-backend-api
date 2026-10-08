import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken, SESSION_COOKIE } from '../src/middlewares/auth-middleware.ts';
import { POST } from '../src/controllers/accommodation-check-controller.ts';
import { sealQuote, type QuoteTicket } from '../src/services/travel/hotel-quote.ts';
function replace(t: TestContext, target: object, key: string, value: unknown) {
  const prior = Reflect.get(target, key); Reflect.set(target, key, value);
  t.after(() => { Reflect.set(target, key, prior); });
}
after(() => prisma.$disconnect());
function setup(t: TestContext) {
  const previous = { ...process.env };
  Object.assign(process.env, { SESSION_SECRET: 'quote-controller-tests-secret-longer-than-32-chars', RAPID_API_KEY: 'fixture', RAPID_API_SECRET: 'fixture', RAPID_ENV: 'production' });
  t.after(() => { for (const key of ['SESSION_SECRET','RAPID_API_KEY','RAPID_API_SECRET','RAPID_ENV']) { if(previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  replace(t, prisma.user, 'findFirst', async () => ({ id: 'traveler', role: 'traveler', accountStatus: 'active', email: 'guest@example.test', name: 'Test' }));
  replace(t, prisma, '$queryRaw', async () => [{ count: 1, reset_at: new Date() }]);
  replace(t, Math, 'random', () => 0.5);
  const quote = { provider: 'expedia-rapid' as const, propertyId: '123', roomId: 'room', offerId: 'rate', roomType: 'Family room', checkInDate: '2040-01-01', checkOutDate: '2040-01-03', occupancy: [{ adults: 2, childAges: [5] }], currency: 'JPY' as const, total: 12345, nightlyAverage: 6173, taxesAndFeesIncluded: true, payableAtProperty: [], priceBreakdown: [], photoReferences: ['123:exterior'], checkedAt: new Date().toISOString(), isLive: true };
  const ticket: QuoteTicket = { userId: 'traveler', expiresAt: Date.now() + 60000, destination: 'Tokyo', latitude: 35, longitude: 139, priceCheckPath: '/v3/properties/123/rooms/room/rates/rate?token=private', property: { id: 'rapid:123:room:rate', propertyId: '123', name: 'Official hotel', nameSource: 'provider-english', type: 'Hotel', address: 'Tokyo, Japan', latitude: 35, longitude: 139, distanceKm: 0, amenities: [], photos: [], availability: 'available', quote } };
  const body = { quoteToken: sealQuote(ticket), checkInDate: quote.checkInDate, checkOutDate: quote.checkOutDate, occupancy: quote.occupancy };
  const request = (data: unknown, auth = true) => new Request('http://localhost/api/accommodations/revalidate', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { cookie: SESSION_COOKIE + '=' + createSessionToken('traveler','traveler') } : {}) }, body: JSON.stringify(data) });
  return { body, request, ticket };
}
test('quote confirmation requires authentication and rejects changed dates, guests, foreign or tampered tickets before contacting provider', async t => {
  const { body, request, ticket } = setup(t); let calls = 0;
  replace(t, globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'matched' }); });
  assert.equal((await POST(request(body, false))).status, 401);
  for (const bad of [{ ...body, checkOutDate: '2040-01-04' }, { ...body, occupancy: [{ adults: 3, childAges: [] }] }, { ...body, quoteToken: sealQuote({ ...ticket, userId: 'other' }) }, { ...body, quoteToken: 'tampered' }]) assert.equal((await POST(request(bad))).status, 409);
  assert.equal(calls, 0);
  const result = await POST(request(body)); assert.equal(result.status, 200);
  const value = await result.json();
  assert.equal(value.accommodation.quote.total, 12345);
  assert.ok(value.accommodation.quote.revalidatedAt);
  assert.notEqual(value.accommodation.quoteToken, body.quoteToken);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 1);
});
test('price-check API preserves separate changed, sold-out and provider-error responses', async t => {
  const { body, request } = setup(t);
  let status = 'price_changed', http = 200;
  replace(t, globalThis, 'fetch', async () => Response.json({ status }, { status: http }));
  for (const [providerStatus, expected] of [['price_changed','changed'],['sold_out','sold-out']]) {
    status = providerStatus; const result = await POST(request(body));
    assert.equal(result.status, 409); assert.equal((await result.json()).status, expected);
  }
  http = 502; const result = await POST(request(body));
  assert.equal(result.status, 502); assert.equal((await result.json()).status, 'provider-error');
});
