import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const { prisma } = await import('../src/lib/prisma.ts');
const { googlePlacesConfigured } = await import('../src/services/itinerary/google-place-photos.ts');
const directory = '../audit/2026-10-12/non-google-activity-photos';
const repairs = JSON.parse(fs.readFileSync(directory + '/actual-repair-summary.json', 'utf8'));
const nonPhoto = (value: any) => {
  const plan = structuredClone(value); delete plan.groundingProof;
  for (const day of plan.days) {
    delete day.imageUrl; delete day.imageAttribution;
    for (const activity of day.activities) { delete activity.imageUrl; delete activity.imageAttribution; }
  }
  return plan;
};
try {
  assert.equal(process.env.GOOGLE_PLACES_PHOTOS_ENABLED, 'false');
  assert.equal(googlePlacesConfigured(), false);
  const trips: any[] = [];
  for (const repair of repairs.results) {
    const before = JSON.parse(fs.readFileSync(directory + '/before-' + repair.tripId + '.json', 'utf8'));
    const after = JSON.parse(fs.readFileSync(directory + '/after-' + repair.tripId + '.json', 'utf8'));
    const record = await prisma.trip.findUniqueOrThrow({ where: { id: repair.tripId } });
    const plan = record.itinerary as any;
    assert.deepEqual(plan, after.itinerary, 'Public saved record must retain its verified photo-only repair.');
    assert.deepEqual(nonPhoto(plan), nonPhoto(before.itinerary));
    assert.ok(plan.days.every((day: any) => day.imageUrl));
    for (const [dayIndex, day] of before.itinerary.days.entries()) for (const [activityIndex, activity] of day.activities.entries()) {
      if (!activity.imageUrl) continue;
      const current = plan.days[dayIndex].activities[activityIndex];
      assert.equal(current.imageUrl, activity.imageUrl);
      assert.deepEqual(current.imageAttribution, activity.imageAttribution);
    }
    trips.push({ tripId: record.id, destination: record.destination, dayCovers: plan.days.length, preservedNonPhotoData: true, preservedWorkingPhotosAndCredits: true, persistedRepairUnchanged: true });
  }
  const schemas = await prisma.$queryRaw<Array<{ schema_name: string }>>`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'travelmate_non_google_photos_test_%'`;
  assert.equal(schemas.length, 0, 'Temporary browser verification schemas must be cleaned up.');
  const result = { googleEnabled: false, trips, temporarySchemasRemaining: schemas.length };
  fs.writeFileSync(directory + '/final-public-record-integrity.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await prisma.$disconnect(); }
