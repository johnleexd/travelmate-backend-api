import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { readTripVisitCandidates, readVisitedPlaces, recordTripVisits } from '../../src/services/platform/visited-place-service.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
after(() => prisma.$disconnect());
test('atomic visited-place saves persist media and ownership, survive reads, deduplicate concurrent repeats and remain separate from completion', async t => {
  const owner = await prisma.user.create({ data: { name: 'Trip visits integration fixture', email: `trip-visits-${randomUUID()}@example.test`, role: 'traveler', emailVerified: true } });
  t.after(async () => { await prisma.auditEvent.deleteMany({ where: { actorId: owner.id } }); await prisma.user.delete({ where: { id: owner.id } }); });
  const user = publicUser(owner);
  const places = [
    { placeId: 'Q243', name: 'Eiffel Tower', latitude: 48.8584, longitude: 2.2945 },
    { placeId: 'Q19675', name: 'Louvre Museum', latitude: 48.8606, longitude: 2.3376 },
    { placeId: 'Q2981', name: 'Notre-Dame de Paris', latitude: 48.853, longitude: 2.3499 },
  ];
  const activities = places.map(place => ({ title: 'Visit ' + place.name, category: 'activity', time: '09:00', estimatedCost: 0,
    place: { ...place, provider: 'wikidata', city: 'Paris', country: 'France', countryCode: 'FR', sourceUrl: 'https://www.wikidata.org/wiki/' + place.placeId, fetchedAt: new Date().toISOString(), address: 'Paris, France', openingHours: 'Not available' },
    imageUrl: 'https://images.unsplash.com/photo-1598258710957-db8614c2881e', imageAttribution: { creator: 'Fixture credit', license: 'Unsplash', provider: 'unsplash', sourceUrl: 'https://unsplash.com/photos/fixture', photoType: 'illustrative', downloadTracked: true } }));
  const trip = await prisma.trip.create({ data: { userId: owner.id, destination: 'Paris, France', destinationCity: 'Paris', destinationCountry: 'France', destinationCountryCode: 'FR', latitude: 48.8534, longitude: 2.3488, budget: 1000, currency: 'EUR', travelers: 1, startDate: new Date('2040-01-01'), endDate: new Date('2040-01-02'), itinerary: { days: [{ day: 1, activities: activities.slice(0, 2) }, { day: 2, activities: [activities[2], activities[0], { title: 'Daily meals allowance', category: 'food' }] }] } } });
  const list = await readTripVisitCandidates(user, trip.id); assert.equal(list.places.length, 3); assert.ok(list.places.every(row => !row.alreadyRecorded));
  const body = { tripId: trip.id, visitDate: '2020-01-01', timeZone: 'UTC', places: list.places.slice(0, 2).map(({ key, fingerprint }) => ({ key, fingerprint })) };
  await assert.rejects(() => recordTripVisits({ ...user, id: randomUUID() }, body), /not found/);
  await assert.rejects(() => recordTripVisits(user, { ...body, places: [...body.places, { key: 'wikidata:Q999', fingerprint: 'a'.repeat(64) }] }), /changed/);
  assert.equal((await readVisitedPlaces(user)).page.total, 0);
  const saves = await Promise.all([recordTripVisits(user, body), recordTripVisits(user, body)]);
  assert.equal(saves.reduce((n, result) => n + result.recorded, 0), 2);
  assert.equal((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status, 'active');
  const history = await readVisitedPlaces(user); assert.equal(history.page.total, 2);
  assert.ok(history.visits.every(row => row.tripId === trip.id && row.latitude && row.imageUrl && row.place && row.imageAttribution?.photoType === 'illustrative'));
  await executePlatformAction(user, 'complete-trip', { id: trip.id });
  assert.equal((await readVisitedPlaces(user)).page.total, 2);
  assert.equal((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status, 'completed');
  assert.equal((await readTripVisitCandidates(user, trip.id)).places.filter(row => row.alreadyRecorded).length, 2);
  const selections = list.places.map(({ key, fingerprint }) => ({ key, fingerprint }));
  assert.equal((await recordTripVisits(user, { ...body, places: [selections[2]] })).recorded, 1);
  assert.equal((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status, 'completed');
  assert.equal((await recordTripVisits(user, { ...body, visitDate: '2020-01-02', places: selections })).recorded, 0);
  await executePlatformAction(user, 'reopen-trip', { id: trip.id });
  assert.equal((await readVisitedPlaces(user)).page.total, 3);
  await prisma.trip.update({ where: { id: trip.id }, data: { itinerary: { days: [{ activities: [{ ...activities[0], title: 'Changed place' }] }] } } });
  await assert.rejects(() => recordTripVisits(user, body), /changed/);
});
