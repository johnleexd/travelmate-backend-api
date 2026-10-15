import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedAccommodationSchema } from '../src/services/destination/planned-accommodation.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { normalizeItinerary, type ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { splitBudget } from '../src/schemas/domain.ts';

const preference = { name: 'Selected Tokyo Hotel', address: 'Tokyo, Japan', type: 'Hotel', source: 'provider', sourceId: 'liteapi:lp123' } as const;

test('provider planning preferences preserve identity without accepting price or quote claims', () => {
  assert.deepEqual(plannedAccommodationSchema.parse(preference), preference);
  assert.equal(plannedAccommodationSchema.safeParse({ ...preference, sourceId: 'rapid:123' }).success, true);
  for (const patch of [{ sourceId: undefined }, { sourceId: 'osm:node:123' }, { sourceId: 'https://example.test' }, { nightlyRate: 123 }, { available: true }, { quoteToken: 'invented' }]) {
    assert.equal(plannedAccommodationSchema.safeParse({ ...preference, ...patch }).success, false);
  }
  assert.equal(plannedAccommodationSchema.safeParse({ ...preference, source: 'openstreetmap' }).success, false);
  assert.equal(plannedAccommodationSchema.safeParse({ ...preference, source: 'openstreetmap', sourceId: 'osm:node:123' }).success, true);
  assert.equal(plannedAccommodationSchema.safeParse({ name: 'Manual stay', address: '', source: 'manual' }).success, true);
});

test('unquoted provider preferences survive saving without adding a confirmed accommodation cost', () => {
  const budget = splitBudget(1000, 1, 2);
  const itinerary = { destination: 'Tokyo, Japan', totalBudget: 1000, currency: 'JPY', source: 'mock', days: [1, 2].map(day => ({ day, date: '2040-01-01', theme: 'Explore', imageUrl: '', totalCost: 0, activities: [] })), budgetSummary: budget } as ItineraryResponse;
  const displayPreference = { ...preference, latitude:35.68, longitude:139.76, rating:4, amenities:['WiFi'], photos:[{reference:'lp123:photo',url:'https://static.cupid.travel/fixture.jpg',caption:'Fixture exterior',attribution:{creator:'Fixture photographer',license:'Provider-authorized photo',sourceUrl:'https://static.cupid.travel/fixture.jpg'}}] };
  const normalized = normalizeItinerary(itinerary, budget, 'solo', 1, 2, '2040-01-01');
  const saved = parseSavedItinerary({ ...normalized, plannedAccommodation: displayPreference }, { days: 2, currency: 'JPY', budget: 1000, travelers: 1, partyType: 'solo' });
  assert.deepEqual(saved.plannedAccommodation, displayPreference);
  assert.equal(plannedAccommodationSchema.safeParse({...displayPreference,latitude:91}).success,false);
  assert.equal(plannedAccommodationSchema.safeParse({...displayPreference,longitude:undefined}).success,false);
  assert.equal(saved.accommodation, undefined);
  assert.equal(saved.budgetSummary.accommodationActual, 0);
});
