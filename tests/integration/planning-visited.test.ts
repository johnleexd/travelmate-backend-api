import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { readVisitedPlaces } from '../../src/services/platform/visited-place-service.ts';
import { GET_VISITED_PLACES } from '../../src/controllers/platform-controller.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';
import { buildGroundedPlan } from '../../src/services/itinerary/grounded-plan.ts';

after(() => prisma.$disconnect());
test('saved-trip retries and confirmed visits persist once, preserve repeats, and enforce ownership', async t => {
  const createUser = (name: string) => prisma.user.create({ data: { name, email: `visited-${randomUUID()}@example.test`, role: 'traveler', emailVerified: true } });
  const owner = await createUser('Visited test fixture'), other = await createUser('Other visited test fixture');
  t.after(() => prisma.$transaction(async tx => { await tx.auditEvent.deleteMany({ where: { actorId: { in: [owner.id, other.id] } } }); await tx.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); }));
  const user = publicUser(owner), stranger = publicUser(other);
  const activity = { title: 'Eiffel Tower', time: '09:00', durationMinutes: 60, description: 'User itinerary fixture', category: 'activity', icon: 'map', estimatedCost: 10 };
  const itinerary = { destination: 'Paris, France', totalBudget: 1000, currency: 'EUR', source: 'mock', travelers: 1, partyType: 'solo',
    days: [{ day: 1, date: '2040-01-01', theme: 'Paris', imageUrl: '', totalCost: 10, activities: [activity] }],
    budgetSummary: { accommodation: 0, food: 0, activities: 10, transport: 0, reserve: 990, dailyAverage: 10, total: 1000 } };
  const body = { destination: 'Paris, France', budget: 1000, currency: 'EUR', startDate: '2040-01-01', endDate: '2040-01-01', travelers: 1, partyType: 'solo', interests: ['culture'], itinerary, weather: null };
  const saves = await Promise.all(Array.from({ length: 3 }, () => executePlatformAction(user, 'save-trip', body))) as Array<{ id: string }>;
  assert.equal(new Set(saves.map(row => row.id)).size, 1);
  const tripId = saves[0].id;
  assert.equal(await prisma.trip.count({ where: { userId: owner.id } }), 1);
  assert.equal(await prisma.itineraryVersion.count({ where: { tripId } }), 1);
  assert.equal(await prisma.visitedPlace.count({ where: { userId: owner.id } }), 0);
  assert.equal((await executePlatformAction(user, 'save-trip', body) as { id: string }).id, tripId);
  const keyed = { ...body, saveKey: `request-${randomUUID()}` };
  const keyedTrip = await executePlatformAction(user, 'save-trip', keyed) as { id: string };
  await assert.rejects(() => executePlatformAction(user, 'save-trip', { ...keyed, interests: ['food'] }), /different plan/);
  await assert.rejects(() => executePlatformAction(user, 'duplicate-trip', { id: tripId }), /no longer available/);
  assert.equal(await prisma.trip.count({ where: { userId: owner.id } }), 2);
  const visitBody = { tripId, dayIndex: 0, activityIndex: 0, visitDate: '2020-01-01', timeZone: 'UTC', name: 'Forged name', latitude: 999 };
  const visits = await Promise.all([executePlatformAction(user, 'record-visit', visitBody), executePlatformAction(user, 'record-visit', visitBody)]) as Array<{ visit: { id: string; name: string; latitude?: number }; alreadyRecorded: boolean }>;
  assert.equal(visits[0].visit.id, visits[1].visit.id); assert.equal(visits[0].visit.name, 'Eiffel Tower'); assert.equal(visits[0].visit.latitude, undefined);
  assert.equal(await prisma.visitedPlace.count({ where: { userId: owner.id } }), 1);
  await executePlatformAction(user, 'record-visit', { ...visitBody, tripId: keyedTrip.id });
  assert.equal(await prisma.visitedPlace.count({ where: { userId: owner.id } }), 1);
  await executePlatformAction(user, 'record-visit', { ...visitBody, visitDate: '2020-01-02' });
  assert.equal(await prisma.visitedPlace.count({ where: { userId: owner.id } }), 2);
  await assert.rejects(() => executePlatformAction(stranger, 'record-visit', visitBody), /not found/);
  await assert.rejects(() => executePlatformAction(stranger, 'remove-visit', { id: visits[0].visit.id }), /not found/);
  await assert.rejects(() => readVisitedPlaces(stranger, visits[0].visit.id), /cursor/);
  assert.equal((await readVisitedPlaces(stranger)).visits.length, 0);
  assert.equal((await GET_VISITED_PLACES(new Request('http://localhost/api/platform/visited-places'))).status, 401);
  const auth = await GET_VISITED_PLACES(new Request('http://localhost/api/platform/visited-places', { headers: { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` } }));
  assert.equal(auth.status, 200); assert.equal((await auth.json()).page.total, 2);
  await executePlatformAction(user, 'archive-trip', { id: tripId }); await executePlatformAction(user, 'delete-trip', { id: tripId });
  assert.equal((await readVisitedPlaces(user)).visits[0].tripId, undefined);
  await executePlatformAction(user, 'remove-visit', { id: visits[0].visit.id });
  assert.equal((await readVisitedPlaces(user)).page.total, 1);
  await prisma.visitedPlace.createMany({ data: Array.from({ length: 22 }, (_, i) => ({ userId: owner.id, name: `History fixture ${i}`, destination: 'Test destination', placeKey: `manual:test-${i}`, visitDate: new Date('2020-01-01') })) });
  const page = await readVisitedPlaces(user); assert.equal(page.visits.length, 20); assert.equal(page.page.hasMore, true);
  const next = await readVisitedPlaces(user, page.page.nextCursor); assert.equal(next.visits.length, 3);
  assert.ok(next.visits.every(row => !page.visits.some(previous => previous.id === row.id)));
  const filtered = await readVisitedPlaces(user, undefined, 'History fixture 21'); assert.equal(filtered.page.total, 1);
  const anchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
  const known = { ...anchor, provider: 'wikidata', placeId: 'Q243', name: 'Eiffel Tower', description: 'Controlled place fixture', latitude: 48.8584, longitude: 2.2945,
    sourceUrl: 'https://www.wikidata.org/wiki/Q243', fetchedAt: new Date().toISOString(), openingHours: 'Not available', address: 'Champ de Mars', distanceKm: 4 } as import('../../src/services/itinerary/grounded-places.ts').GroundedPlace;
  const grounded = buildGroundedPlan({ destination: body.destination, anchor, startingLocation: 'Toronto, Canada', startDate: body.startDate, endDate: body.endDate,
    budget: 1000, currency: 'EUR', travelers: 1, partyType: 'solo', rooms: 1, places: [known], placeDataStatus: 'live', source: 'openai', transportation: 'Walking',
    schedule: [{ day: 1, date: body.startDate, theme: 'Paris', visits: [{ placeId: 'Q243', startMinutes: 600, durationMinutes: 60, participants: 1 }] }] });
  const groundedTrip = await executePlatformAction(user, 'save-trip', { ...body, itinerary: grounded, saveKey: `grounded-${randomUUID()}` }) as { id: string };
  const secondGroundedTrip = await executePlatformAction(user, 'save-trip', { ...body, itinerary: grounded, saveKey: `grounded-${randomUUID()}` }) as { id: string };
  const trustedBody = { tripId: groundedTrip.id, dayIndex: 0, activityIndex: 0, activityTitle: 'Visit Eiffel Tower', placeId: 'Q243', visitDate: '2020-02-01', timeZone: 'UTC' };
  await assert.rejects(() => executePlatformAction(user, 'record-visit', { ...trustedBody, activityTitle: 'Stale activity' }), /changed/);
  const trusted = await executePlatformAction(user, 'record-visit', trustedBody) as { visit: { id: string; placeKey: string; latitude: number } };
  const again = await executePlatformAction(user, 'record-visit', { ...trustedBody, tripId: secondGroundedTrip.id }) as { visit: { id: string }; alreadyRecorded: boolean };
  assert.equal(trusted.visit.placeKey, 'wikidata:Q243'); assert.equal(trusted.visit.latitude, 48.8584); assert.equal(again.visit.id, trusted.visit.id); assert.equal(again.alreadyRecorded, true);
  assert.ok(keyedTrip.id);
  await assert.rejects(() => executePlatformAction(user, 'book', { listingId: 'fixture' }), /no longer available/);
  await assert.rejects(() => executePlatformAction(user, 'subscribe', { plan: 'paid' }), /not allowed/);
});
