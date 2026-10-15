import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const { prisma } = await import('../src/lib/prisma.ts');
const { emptyGeneratedDays, repairIncompleteTrip } = await import('../src/services/itinerary/incomplete-trip-repair.ts');
const { loadGroundedPlaces } = await import('../src/services/itinerary/grounded-places.ts');
const { parseSavedItinerary } = await import('../src/services/itinerary/saved-trip-schema.ts');
const { createItineraryVersion } = await import('../src/services/platform/platform-service.ts');
const directory = '../audit/2026-10-13/missing-activities';
fs.mkdirSync(directory, { recursive: true });
const apply = process.argv.includes('--apply');
const reports: any[] = [];
try {
  const trips = await prisma.trip.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'desc' } });
  for (const trip of trips) {
    const original = trip.itinerary as any;
    const empty = emptyGeneratedDays(original);
    if (!empty.length) { reports.push({ id: trip.id, destination: trip.destination, skipped: original.manuallyEdited ? 'manual-edits-preserved' : !original.grounding ? 'legacy-unverified-plan-preserved' : 'no-untouched-empty-generated-days' }); continue; }
    const events: Record<string, unknown>[] = [];
    try {
      const catalog = await loadGroundedPlaces(original.grounding.destination);
      const repaired = repairIncompleteTrip(original, catalog.places, Array.isArray(trip.interests) ? trip.interests.map(String) : [], event => events.push(event));
      if (!repaired.added) { reports.push({ id: trip.id, destination: trip.destination, emptyDays: empty.map(day => day.day), catalog: catalog.places.length, skipped: 'no-new-feasible-verified-places', providerStatus: catalog.status }); continue; }
      const context = { days: original.days.length, currency: trip.currency as any, budget: Number(trip.budget), travelers: trip.travelers, partyType: trip.partyType, startDate: trip.startDate.toISOString().slice(0, 10), destination: trip.destination };
      const itinerary = parseSavedItinerary(repaired.plan, context);
      for (const day of original.days) {
        const after = itinerary.days[day.day - 1];
        if (day.activities.length) assert.deepEqual(after.activities.slice(-day.activities.length), day.activities);
        if (!repaired.days.includes(day.day)) assert.deepEqual(after, day);
      }
      fs.writeFileSync(`${directory}/repair-${trip.id}.json`, JSON.stringify({ original: { ...trip, userId: undefined }, proposedItinerary: itinerary, added: repaired.added, changedDays: repaired.days, events }, null, 2));
      let applied = false;
      if (apply) applied = await prisma.$transaction(async transaction => {
        await transaction.$queryRaw`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`;
        const current = await transaction.trip.findUnique({ where: { id: trip.id } });
        if (!current || current.updatedAt.getTime() !== trip.updatedAt.getTime() || current.status !== 'active') return false;
        const count = await transaction.itineraryVersion.count({ where: { tripId: trip.id } });
        if (!count) await createItineraryVersion(transaction, current, 'saved');
        const saved = await transaction.trip.update({ where: { id: trip.id }, data: { itinerary: itinerary as any } });
        await createItineraryVersion(transaction, saved, 'regenerated');
        await transaction.auditEvent.create({ data: { actorId: current.userId, action: 'repair-empty-generated-days', targetId: current.id } });
        return true;
      });
      const report = { id: trip.id, destination: trip.destination, catalog: catalog.places.length, added: repaired.added, changedDays: repaired.days, before: original.days.map((day: any) => day.activities.filter((a: any) => !!a.place).length), after: itinerary.days.map(day => day.activities.filter(a => !!a.place).length), applied, ...(apply && !applied ? { skipped: 'changed-concurrently' } : {}) };
      reports.push(report); console.log(JSON.stringify(report));
    } catch (error) { const report = { id: trip.id, destination: trip.destination, error: error instanceof Error ? error.message : 'Repair failed' }; reports.push(report); console.warn(JSON.stringify(report)); }
  }
} finally {
  fs.writeFileSync(directory + (apply ? '/repair-live-results.json' : '/repair-preview-results.json'), JSON.stringify(reports, null, 2));
  await prisma.$disconnect();
}
