import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildTripVisitCandidates, candidateAlreadyRecorded } from '../src/services/platform/trip-visit-candidates.ts';
import { prisma } from '../src/lib/prisma.ts';
after(() => prisma.$disconnect());
const anchor = { destinationCity: 'Paris', destinationCountry: 'France', destinationCountryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
const place = { provider: 'wikidata', placeId: 'Q243', name: 'Eiffel Tower', city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8584, longitude: 2.2945, sourceUrl: 'https://www.wikidata.org/wiki/Q243', fetchedAt: '2026-10-14T00:00:00Z', openingHours: 'Not available', address: 'Champ de Mars' };
const activity = { title: 'Visit Eiffel Tower', category: 'activity', place };
const makeTrip = (activities: unknown[]) => ({ id: 'trip-test', destination: 'Paris, France', ...anchor, itinerary: { days: [{ activities }, { activities: [activity] }] } });

test('all saved days are read; verified IDs deduplicate repeats without requiring photos or opening hours', () => {
  const candidates = buildTripVisitCandidates(makeTrip([activity]));
  assert.equal(candidates.length, 1); assert.equal(candidates[0].key, 'wikidata:Q243');
  assert.equal(candidates[0].latitude, place.latitude); assert.equal(candidates[0].place?.placeId, 'Q243');
  assert.equal(candidates[0].destination, 'Champ de Mars, Paris, France');
});
test('allowances, meal breaks, placeholders and generic unnamed activities are not places', () => {
  const trip = makeTrip([{ title: 'Daily meals allowance', category: 'food' }, { title: 'Lunch', category: 'activity' }, { title: 'Museum visit', category: 'activity' }, { title: 'Rest break', category: 'activity' }, { title: 'Beach walking', category: 'activity' }, { title: 'Additional activity', category: 'activity' }]);
  assert.deepEqual(buildTripVisitCandidates(trip).map(row => row.name), ['Eiffel Tower']);
});
test('fallback identity retains distinct same-name places, coordinates, addresses and uncertain legacy activities', () => {
  const trip = makeTrip([{ title: 'Market Hall', category: 'activity', place: { name: 'Market Hall', latitude: 48.85, longitude: 2.35 } }, { title: 'Market Hall', category: 'activity', place: { name: 'Market Hall', latitude: 48.88, longitude: 2.33 } }, { title: 'Museum of History', category: 'activity' }, { title: 'Museum of History', category: 'activity' }]);
  const rows = buildTripVisitCandidates(trip); assert.equal(rows.length, 5); assert.equal(new Set(rows.map(row => row.key)).size, 5);
  const wrong = makeTrip([{ ...activity, place: { ...place, city: 'Tokyo', country: 'Japan', countryCode: 'JP' } }]);
  assert.ok(buildTripVisitCandidates(wrong)[0].key.startsWith('manual:'));
});
test('available saved photo metadata is retained; time/notes do not change place fingerprint, place changes do', () => {
  const photo = { imageUrl: 'https://images.unsplash.com/photo-1598258710957-db8614c2881e', imageAttribution: { creator: 'Fixture credit', license: 'Unsplash', sourceUrl: 'https://unsplash.com/photos/fixture', provider: 'unsplash', photoType: 'illustrative', downloadTracked: true } };
  const before = buildTripVisitCandidates(makeTrip([{ ...activity, ...photo }]))[0];
  assert.deepEqual(before.imageAttribution, photo.imageAttribution);
  assert.equal(before.fingerprint, buildTripVisitCandidates(makeTrip([{ ...activity, time: '14:00', description: 'Edited notes' }]))[0].fingerprint);
  assert.notEqual(before.fingerprint, buildTripVisitCandidates(makeTrip([{ ...activity, place: { ...place, placeId: 'Q19675', sourceUrl: 'https://www.wikidata.org/wiki/Q19675' } }]))[0].fingerprint);
});
test('old records match only a strong ID or an unambiguous same-trip location; names alone never merge', () => {
  const rows = buildTripVisitCandidates(makeTrip([activity])), candidate = rows[0];
  const visit = { placeKey: candidate.key, name: candidate.name, destination: candidate.destination, tripId: 'another-trip', latitude: place.latitude, longitude: place.longitude };
  assert.equal(candidateAlreadyRecorded(candidate, 'trip-test', [visit], rows), true);
  assert.equal(candidateAlreadyRecorded(candidate, 'trip-test', [{ ...visit, placeKey: 'manual:old', latitude: 0, longitude: 0 }], rows), false);
  assert.equal(candidateAlreadyRecorded(candidate, 'trip-test', [{ ...visit, placeKey: 'manual:old', tripId: 'trip-test' }], rows), true);
});
test('incomplete historical place references retain IDs and points without becoming verified identities', () => {
  const rows = buildTripVisitCandidates(makeTrip([{ title: 'Old saved venue', category: 'activity', place: { provider: 'wikidata', placeId: 'Q243', name: 'Eiffel Tower', latitude: 48.8584, longitude: 2.2945 } }]));
  assert.equal(rows[0].place?.placeId, 'Q243'); assert.equal(rows[0].latitude, 48.8584);
  assert.ok(rows[0].key.startsWith('manual:'));
});
