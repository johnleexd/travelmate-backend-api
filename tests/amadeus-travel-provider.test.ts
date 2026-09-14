import assert from 'node:assert/strict';
import test from 'node:test';
import { createAmadeusTravelProvider, normalizeAccommodationOffers, normalizeActivityOffers, normalizeFlightOffers } from '../src/services/travel/amadeus-provider.ts';

const fetchedAt = '2026-09-10T00:00:00.000Z';

test('Amadeus flight offers normalize into comparable provider-neutral fields', () => {
  const result = normalizeFlightOffers({ data: [{
    id: 'offer-1', validatingAirlineCodes: ['PR'], numberOfBookableSeats: 4,
    price: { currency: 'PHP', grandTotal: '12500.50' },
    itineraries: [
      { duration: 'PT1H25M', segments: [{ carrierCode: 'PR', departure: { iataCode: 'MNL', at: '2026-10-01T08:00:00' }, arrival: { iataCode: 'CEB', at: '2026-10-01T09:25:00' } }] },
      { duration: 'PT1H30M', segments: [{ carrierCode: 'PR', departure: { iataCode: 'CEB', at: '2026-10-05T18:00:00' }, arrival: { iataCode: 'MNL', at: '2026-10-05T19:30:00' } }] },
    ],
  }] }, fetchedAt, false);
  assert.deepEqual(result[0], {
    id: 'amadeus:offer-1', provider: 'amadeus', airline: 'PR', origin: 'MNL', destination: 'CEB',
    departure: '2026-10-01T08:00:00', arrival: '2026-10-01T09:25:00', returnDeparture: '2026-10-05T18:00:00', returnArrival: '2026-10-05T19:30:00',
    duration: 'PT1H25M', price: 12500.5, currency: 'PHP', stops: 0, seatsAvailable: 4, fetchedAt, isLive: false,
  });
});

test('Amadeus activity offers normalize price, source, rating, and safe reference link', () => {
  const result = normalizeActivityOffers({ data: [{ id: 'act-1', name: 'Heritage walk', shortDescription: 'Guided city walk', rating: '4.5', bookingLink: 'https://example.com/book', price: { currencyCode: 'PHP', amount: '850.00' } }] }, 'Cebu City', fetchedAt, true);
  assert.equal(result[0].provider, 'amadeus');
  assert.equal(result[0].price, 850);
  assert.equal(result[0].currency, 'PHP');
  assert.equal(result[0].rating, 4.5);
  assert.equal(result[0].isLive, true);
  assert.equal(result[0].referenceUrl, 'https://example.com/book');
});

test('Amadeus hotel offers normalize price, room details, availability, and source labels', () => {
  const result = normalizeAccommodationOffers({ data: [{
    available: true,
    hotel: { hotelId: 'CEB123', name: 'Harbor Test Hotel' },
    offers: [{
      id: 'room-1', checkInDate: '2026-10-01', checkOutDate: '2026-10-04',
      room: { description: { text: '  Deluxe   sea-view room  ' } },
      price: { currency: 'PHP', total: '7500.40' },
      policies: { cancellations: [{ description: { text: 'Free cancellation before arrival.' } }] },
    }],
  }] }, { destination: 'Cordova, Cebu, Philippines', nights: 3 }, fetchedAt, false);

  assert.deepEqual(result[0], {
    id: 'amadeus:CEB123:room-1', hotelId: 'CEB123', offerId: 'room-1', name: 'Harbor Test Hotel',
    address: 'Cordova, Cebu, Philippines', checkInDate: '2026-10-01', checkOutDate: '2026-10-04',
    nightlyRate: 2500, total: 7500, currency: 'PHP', roomDescription: 'Deluxe sea-view room',
    cancellationPolicy: 'Free cancellation before arrival.', available: true, isLive: false,
    source: 'amadeus', fetchedAt,
  });
});

test('shared Amadeus provider authenticates once before hotel inventory and offer searches', async () => {
  const requestedUrls: string[] = [];
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith('/v1/security/oauth2/token')) return Response.json({ access_token: 'test-token' });
    if (url.includes('/hotels/by-geocode?')) return Response.json({ data: [{ hotelId: 'CEB123' }] });
    if (url.includes('/v3/shopping/hotel-offers?')) return Response.json({ data: [{
      available: true, hotel: { hotelId: 'CEB123', name: 'Harbor Test Hotel' },
      offers: [{ id: 'room-1', checkInDate: '2026-10-01', checkOutDate: '2026-10-04', price: { currency: 'PHP', total: '7500' } }],
    }] });
    return new Response(null, { status: 404 });
  };
  const provider = await createAmadeusTravelProvider({
    AMADEUS_API_KEY: 'client-id', AMADEUS_API_SECRET: 'client-secret', AMADEUS_ENV: 'test',
  }, fakeFetch as typeof fetch);
  assert.ok(provider);

  const result = await provider.searchAccommodations({
    destination: 'Cordova, Cebu, Philippines', latitude: 10.25, longitude: 123.95,
    checkInDate: '2026-10-01', checkOutDate: '2026-10-04', adults: 3, nights: 3,
  }, fetchedAt);

  assert.equal(requestedUrls.filter((url) => url.endsWith('/v1/security/oauth2/token')).length, 1);
  assert.match(requestedUrls[1], /hotels\/by-geocode\?/);
  assert.match(requestedUrls[2], /roomQuantity=2/);
  assert.equal(result.accommodations[0].hotelId, 'CEB123');
  assert.equal(result.inventoryAvailable, true);
  assert.equal(result.hotelsFound, true);
});

test('normalizers discard malformed prices instead of inventing values', () => {
  assert.deepEqual(normalizeFlightOffers({ data: [{ id: 'bad', price: { total: 'unknown' }, itineraries: [] }] }, fetchedAt, false), []);
  assert.deepEqual(normalizeActivityOffers({ data: [{ id: 'bad', name: 'Unknown', price: { amount: 'call us' } }] }, 'Cebu', fetchedAt, false), []);
  assert.deepEqual(normalizeAccommodationOffers({ data: [{ hotel: { hotelId: 'bad', name: 'Unknown' }, offers: [{ id: 'bad', price: { total: 'call us' } }] }] }, { destination: 'Cebu', nights: 2 }, fetchedAt, false), []);
});
