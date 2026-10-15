import assert from 'node:assert/strict';
import test from 'node:test';
const isolatedUrl = process.env.TRAVELMATE_ISOLATED_TEST_DATABASE;
test('generated schedules retain IDs, times, place/photo/cost references and map pins through a real save/reopen', { skip: !isolatedUrl ? 'Set TRAVELMATE_ISOLATED_TEST_DATABASE to a migrated isolated test database.' : false }, async () => {
  process.env.DATABASE_URL = isolatedUrl!;
  const { prisma } = await import('../../src/lib/prisma.ts');
  const { publicUser } = await import('../../src/schemas/domain.ts');
  const { executePlatformAction } = await import('../../src/services/platform/platform-service.ts');
  const { buildGroundedPlan } = await import('../../src/services/itinerary/grounded-plan.ts');
  const { completeGroundedSchedule } = await import('../../src/services/itinerary/generated-day-scheduler.ts');
  const { buildTripMapManifest } = await import('../../src/services/navigation/trip-map-service.ts');
  const anchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
  const places = Array.from({ length: 9 }, (_, i) => ({ ...anchor, provider: 'wikidata' as const, placeId: `Q${100 + i}`, name: `Isolated synthetic museum ${i}`, description: 'Synthetic database fixture, not travel facts.', latitude: anchor.latitude + i * 0.0001, fetchedAt: '2026-10-11T00:00:00.000Z', sourceUrl: `https://www.wikidata.org/wiki/Q${100 + i}`, openingHours: 'Not available; confirm with venue', address: 'Not available', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/test-museum.jpg', imageAttribution: { creator: 'Fixture photographer', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:test-museum.jpg' } }));
  const itinerary = buildGroundedPlan({ destination: 'Paris, France', anchor, startingLocation: '', startDate: '2040-01-25', endDate: '2040-01-27', budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo', rooms: 1, places, placeDataStatus: 'live', source: 'catalog', transportation: 'Walking', schedule: completeGroundedSchedule(anchor, places, [], '2040-01-25', 3, 1, 'balanced') });
  const owner = await prisma.user.create({ data: { name: 'Isolated generation test', email: `generation-isolated-${crypto.randomUUID()}@example.test`, role: 'traveler', emailVerified: true } });
  let tripId: string | undefined;
  try {
    const saved = await executePlatformAction(publicUser(owner), 'save-trip', { destination: itinerary.destination, destinationDetails: anchor, budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo', startDate: '2040-01-25', endDate: '2040-01-27', interests: ['culture'], itinerary, weather: null }) as { id: string };
    tripId = saved.id; await prisma.$disconnect();
    const reopened = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    const plan = reopened.itinerary as unknown as typeof itinerary;
    assert.deepEqual(plan.days, JSON.parse(JSON.stringify(itinerary.days)));
    assert.equal(plan.grounding?.total, itinerary.grounding?.total);
    const map = buildTripMapManifest(reopened);
    assert.ok(map.days.every(day => day.activities.filter(a => !a.budgetOnly).length === 3));
    assert.equal(map.days[0].activities[0].activityId, plan.days[0].activities[0].id);
    assert.equal(map.days[0].activities[0].place?.latitude, plan.days[0].activities[0].place?.latitude);
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId } }), 1);
  } finally {
    if (tripId) { await prisma.auditEvent.deleteMany({ where: { targetId: tripId, actorId: owner.id } }); await prisma.trip.delete({ where: { id: tripId, userId: owner.id } }); }
    await prisma.user.delete({ where: { id: owner.id } }); await prisma.$disconnect();
  }
});
