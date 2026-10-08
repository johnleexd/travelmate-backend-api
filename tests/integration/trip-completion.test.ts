import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { readTripDetails, readTripPage } from '../../src/repositories/trip-workspace-repository.ts';

after(() => prisma.$disconnect());
test('completed travel and hotel survive fresh database reads, archive/restore and reopening', async t => {
  const owner = await prisma.user.create({ data: { name: 'Completion test fixture', email: `completion-${randomUUID()}@example.test`, role: 'traveler', emailVerified: true } });
  t.after(() => prisma.$transaction(async tx => {
    await tx.auditEvent.deleteMany({ where: { actorId: owner.id } });
    await tx.user.delete({ where: { id: owner.id } });
  }));
  const itinerary = { destination: 'Paris', plannedAccommodation: { name: 'Fixture Paris Hotel', address: 'Paris, France', source: 'manual', nightlyEstimate: 0 }, days: [] };
  const trip = await prisma.trip.create({ data: { userId: owner.id, destination: 'Paris', budget: 1000, currency: 'EUR',
    startDate: new Date('2040-01-01'), endDate: new Date('2040-01-03'), travelers: 1, partyType: 'solo', interests: ['culture'], itinerary,
    versions: { create: { version: 1, kind: 'saved', itinerary } } } });
  const user = publicUser(owner);
  const complete = () => executePlatformAction(user, 'complete-trip', { id: trip.id });
  await Promise.all([complete(), complete()]);
  const read = await readTripDetails(user, trip.id);
  assert.equal(read.status, 'completed'); assert.ok(read.completedAt); assert.deepEqual(read.itinerary, itinerary);
  const page = await readTripPage(user);
  assert.equal(page.trips[0].status, 'completed'); assert.equal(page.trips[0].completedAt, read.completedAt);
  assert.equal(page.trips[0].selectedAccommodation?.name, 'Fixture Paris Hotel');
  assert.equal(await prisma.itineraryVersion.count({ where: { tripId: trip.id } }), 1);
  await executePlatformAction(user, 'archive-trip', { id: trip.id });
  await executePlatformAction(user, 'restore-trip', { id: trip.id });
  assert.equal((await readTripDetails(user, trip.id)).completedAt, read.completedAt);
  await assert.rejects(() => executePlatformAction(user, 'duplicate-trip', { id: trip.id }), /no longer available/);
  assert.equal(await prisma.trip.count({ where: { userId: owner.id } }), 1);
  await executePlatformAction(user, 'reopen-trip', { id: trip.id });
  assert.equal((await readTripDetails(user, trip.id)).status, 'active');
  assert.equal((await readTripDetails(user, trip.id)).completedAt, undefined);
});
