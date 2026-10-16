import assert from 'node:assert/strict';
import test from 'node:test';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { loadGroundedPlaces } from '../src/services/itinerary/grounded-places.ts';
import { verifiedPlaceSnapshot } from '../src/services/itinerary/verified-place-snapshots.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';

const tokyo = { city: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.6895, longitude: 139.69171 };

test('reviewed Tokyo fallback produces a full culture-focused week without duplicate places', () => {
  const places = verifiedPlaceSnapshot(tokyo);
  assert.equal(places.length, 14);
  assert.equal(new Set(places.map(place => place.placeId)).size, places.length);
  assert.ok(places.every(place => place.city === 'Tokyo' && place.countryCode === 'JP' && /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/.test(place.sourceUrl)));
  const days = completeGroundedSchedule(tokyo, places, [], '2040-01-01', 7, 1, 'balanced', { interests: ['culture'], travelStyle: 'balanced', transportation: 'walking' });
  assert.deepEqual(days.map(day => day.visits.length), [2, 2, 2, 2, 2, 2, 2]);
  assert.ok(days.every(day => day.planningStatus === 'suggested'));
  assert.equal(new Set(days.flatMap(day => day.visits.map(visit => visit.placeId))).size, 14);
});

test('reviewed fallback is bound to the exact city and country', () => {
  assert.deepEqual(verifiedPlaceSnapshot({ ...tokyo, city: 'Kyoto' }), []);
  assert.deepEqual(verifiedPlaceSnapshot({ ...tokyo, country: 'Philippines', countryCode: 'PH' }), []);
  assert.deepEqual(verifiedPlaceSnapshot({ ...tokyo, latitude: 34.69 }), []);
});

test('place loading returns the reviewed Tokyo snapshot when public providers fail', async t => {
  clearProviderCache();
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
  const result = await loadGroundedPlaces(tokyo, undefined, false, { tripDays: 7, forceRefresh: true });
  assert.equal(result.status, 'stale-cache');
  assert.equal(result.places.length, 14);
  assert.equal(result.coverage.accepted, 14);
  assert.equal(result.coverage.providerFailures, 1);
});
