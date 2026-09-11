import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeActivityOffers, normalizeFlightOffers } from '../src/services/travel/amadeus-provider.ts';

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

test('normalizers discard malformed prices instead of inventing values', () => {
  assert.deepEqual(normalizeFlightOffers({ data: [{ id: 'bad', price: { total: 'unknown' }, itineraries: [] }] }, fetchedAt, false), []);
  assert.deepEqual(normalizeActivityOffers({ data: [{ id: 'bad', name: 'Unknown', price: { amount: 'call us' } }] }, 'Cebu', fetchedAt, false), []);
});
