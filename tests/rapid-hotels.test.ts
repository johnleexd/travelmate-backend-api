import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RapidHotelProvider, rapidQuote, rapidPhotos, rapidConfigured, type HotelSearchInput } from '../src/services/travel/rapid-hotel-provider.ts';
import { openQuote, sealQuote, type QuoteTicket } from '../src/services/travel/hotel-quote.ts';
import { localizePropertyNames } from '../src/services/destination/accommodation-localization.ts';
import { normalizeAccommodationPlaces } from '../src/services/destination/accommodation-places.ts';
import { normalizeItinerary, type ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { splitBudget } from '../src/schemas/domain.ts';
const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'hotel-tests-only-secret-with-more-than-32-characters';
after(() => { if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret; });
const env = { RAPID_API_KEY: 'fixture', RAPID_API_SECRET: 'fixture-secret', RAPID_ENV: 'production', RAPID_CONTENT_RIGHTS_CONFIRMED: 'true', RAPID_PHOTO_ATTRIBUTION_TEXT: 'Authorized property photographer' };
const input: HotelSearchInput = { destination: 'Tokyo', countryCode: 'JP', latitude: 35, longitude: 139, checkInDate: '2040-01-01', checkOutDate: '2040-01-03', currency: 'JPY', occupancy: [{ adults: 2, childAges: [5] }, { adults: 1, childAges: [] }] };
const money = (value: number, currency = 'JPY') => ({ value: String(value), currency });
function pricing(total: number, fees = 100) { return { nightly: [[{ type: 'base_rate', ...money(400) }], [{ type: 'base_rate', ...money(500) }]], totals: { property_inclusive: { billable_currency: money(total), request_currency: money(total) }, property_fees: { billable_currency: money(fees) } } }; }
function content(id = '123') { return { property_id: id, name: 'Official Tokyo Hotel', address: { line_1: '1 Central Street', city: 'Tokyo', country_code: 'JP' }, location: { coordinates: { latitude: 35, longitude: 139 } }, category: { name: 'Hotel' }, images: [{ caption: 'Exterior', links: { '1000px': { href: 'https://images.trvl-media.com/hotels/exact-property.jpg' } } }], amenities: { wifi: { name: 'WiFi' } } }; }
function rate() { return { id: 'rate1', status: 'available', occupancy_pricing: { '2-5': pricing(1234), '1': pricing(999) }, bed_groups: { king: { links: { price_check: { href: '/v3/properties/123/rooms/room1/rates/rate1?token=private' } } } } }; }
// The canonical API path contains /rates/{id}?token, not an assumed trailing slash.
const room = () => ({ id: 'room1', room_name: 'Family room', rates: [rate()] });

test('English catalog, exact provider identity, permitted photos and occupancy-specific totals are connected', async () => {
  const requests: URL[] = [];
  const provider = new RapidHotelProvider(env, async (url, init) => {
    const parsed = new URL(String(url)); requests.push(parsed);
    assert.match(String((init?.headers as Record<string, string>).Authorization), /^EAN APIKey=fixture,Signature=[a-f0-9]{128},timestamp=\d+$/);
    assert.equal(init?.cache, 'no-store');
    if (parsed.pathname === '/v3/regions') { assert.equal(parsed.searchParams.get('language'), 'en-US'); return Response.json([{ property_ids: ['123', '456'] }]); }
    if (parsed.pathname === '/v3/properties/content') { assert.equal(parsed.searchParams.get('language'), 'en-US'); return Response.json({ '123': content(), '456': content('different-id') }); }
    assert.equal(parsed.searchParams.get('checkin'), input.checkInDate);
    assert.deepEqual(parsed.searchParams.getAll('occupancy'), ['2-5','1']);
    assert.deepEqual(parsed.searchParams.getAll('property_id'), ['123']);
    return Response.json([{ property_id: '123', rooms: [room()] }]);
  });
  const rows = await provider.search(input, 'traveler');
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Official Tokyo Hotel');
  assert.equal(rows[0].propertyId, '123'); assert.equal(rows[0].photos[0].attribution.creator, env.RAPID_PHOTO_ATTRIBUTION_TEXT);
  assert.equal(rows[0].quote!.total, 2233); // exact room totals, not nightly rates times guests
  assert.equal(rows[0].quote!.payableAtProperty[0].amount, 200);
  assert.deepEqual(rows[0].quote!.occupancy, input.occupancy);
  const ticket = openQuote(rows[0].quoteToken, 'traveler');
  assert.equal(ticket.priceCheckPath.includes('private'), true);
  assert.equal(rows[0].quoteToken!.includes('private'), false);
  assert.throws(() => openQuote(rows[0].quoteToken, 'someone-else'), /invalid/);
  assert.equal(requests.length, 3);
});
test('missing full totals, mixed currencies or unverified image hosts are not fabricated', () => {
  const r = rate(); delete r.occupancy_pricing['1'];
  assert.equal(rapidQuote(r, room(), '123', input, [], new Date().toISOString(), true), undefined);
  assert.deepEqual(rapidPhotos(content(), { ...env, RAPID_CONTENT_RIGHTS_CONFIRMED: 'false' }), []);
  const c = content(); c.images[0].links['1000px'].href = 'https://unverified.test/photo.jpg';
  assert.deepEqual(rapidPhotos(c, env), []);
  assert.equal(rapidConfigured({}), false);
});
test('original quoted currency stays intact and requested-currency conversion is approximate', () => {
  const r = rate();
  for (const p of Object.values(r.occupancy_pricing)) p.totals.property_inclusive.request_currency = money(10, 'USD');
  const quote = rapidQuote(r, room(), '123', input, [], new Date().toISOString(), true)!;
  assert.equal(quote.currency, 'JPY'); assert.equal(quote.total, 2233);
  assert.deepEqual(quote.approximateTotal, { currency: 'USD', amount: 20 });
});
test('date-specific unavailable rooms distinguish sold out, no quote, and provider errors', async () => {
  for (const [answer, expected] of [[[{ property_id: '123', unavailable_reason: { code: 'no_inventory_available' } }], 'sold-out'], [[], 'price-unavailable'], ['error', 'provider-error']] as const) {
    const provider = new RapidHotelProvider(env, async url => {
      const p = new URL(String(url)).pathname;
      if (p === '/v3/regions') return Response.json([{ property_ids: ['123'] }]);
      if (p === '/v3/properties/content') return Response.json({ '123': content() });
      return answer === 'error' ? Response.json({}, { status: 502 }) : Response.json(answer);
    });
    const rows = await provider.search({ ...input, checkInDate: '2041-02-01', checkOutDate: '2041-02-03' }, 'traveler');
    assert.equal(rows[0].availability, expected); assert.equal(rows[0].quote, undefined);
  }
});
test('revalidation rejects changed, sold-out, expired and wrong-property links', async () => {
  const quote = rapidQuote(rate(), room(), '123', input, [], new Date().toISOString(), true)!;
  const ticket: QuoteTicket = { userId: 'traveler', destination: 'Tokyo', latitude: 35, longitude: 139, expiresAt: Date.now() + 60000, priceCheckPath: '/v3/properties/123/rooms/room1/rates/rate1?token=private', property: { id: 'rapid:123', propertyId: '123', name: 'Official Tokyo Hotel', nameSource: 'provider-english', address: 'Tokyo', type: 'Hotel', latitude: 35, longitude: 139, distanceKm: 0, amenities: [], photos: [], availability: 'available', quote } };
  for (const status of ['price_changed','sold_out','unknown']) {
    const provider = new RapidHotelProvider(env, async () => Response.json({ status }));
    await assert.rejects(provider.revalidate(ticket), /price changed|sold out|no longer/);
  }
  const matched = await new RapidHotelProvider(env, async () => Response.json({ status: 'matched' })).revalidate(ticket);
  assert.equal(matched.quote!.total, 2233); assert.ok(matched.quote!.revalidatedAt);
  assert.throws(() => openQuote(sealQuote({ ...ticket, expiresAt: 0 }), 'traveler'), /expired/);
  await assert.rejects(new RapidHotelProvider(env).revalidate({ ...ticket, priceCheckPath: 'https://foreign.test/leak' }), /Refresh/);
});
test('official English names win, romanization is labeled and no brand translation is invented', async () => {
  const rows = normalizeAccommodationPlaces({ elements: [{ type: 'node', id: 1, lat: 35, lon: 139, tags: { tourism: 'hotel', name: 'ホテル', 'official_name:en': 'Official Hotel', 'name:en': 'Other Hotel', 'addr:city:en': 'Tokyo' } }] }, input);
  assert.equal(rows[0].name, 'Official Hotel'); assert.equal(rows[0].nameSource, 'official-english');
  const missing = await localizePropertyNames([{ name: 'ホテル', address: '東京都' }], {});
  assert.equal(missing[0].name, 'ホテル'); assert.equal(missing[0].nameSource, 'unavailable');
  const romanized = await localizePropertyNames([{ name: 'ホテル', address: '東京都' }], { HOTEL_ROMANIZATION_PROJECT: 'project' }, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { contents: ['ホテル'] });
    return Response.json({ romanizations: [{ romanizedText: 'Hoteru' }] });
  }, async () => 'fixture-token');
  assert.equal(romanized[0].name, 'Hoteru'); assert.equal(romanized[0].nameSource, 'transliterated');
});
test('the selected provider total and stable quote references survive itinerary normalization and save validation', () => {
  const quote = rapidQuote(rate(), room(), '123', input, [], new Date().toISOString(), true)!;
  const plan = { destination: 'Tokyo', currency: 'JPY', totalBudget: 10000, source: 'mock', days: Array.from({ length: 3 }, (_, i) => ({ day: i+1, date: '2040-01-0' + (i+1), theme: 'Explore', imageUrl: '', totalCost: 0, activities: [] })), budgetSummary: splitBudget(10000, 4, 3) } as ItineraryResponse;
  const normalized = normalizeItinerary(plan, splitBudget(10000,4,3), 'family', 4, 3, input.checkInDate, { listingId: 'rapid:123', offerId: 'rate1', name: 'Official Tokyo Hotel', address: 'Tokyo', nightlyRate: quote.nightlyAverage, quotedTotal: quote.total, source: 'expedia-rapid', currency: 'JPY', isLive: true, providerQuote: quote });
  assert.equal(normalized.accommodation!.total, 2233);
  const saved = parseSavedItinerary(normalized, { days: 3, budget: 10000, travelers: 4, partyType: 'family', currency: 'JPY', destination: 'Tokyo', startDate: input.checkInDate });
  assert.deepEqual(saved.accommodation!.providerQuote, quote);
  assert.equal(saved.budgetSummary.accommodationActual, 2233);
});
