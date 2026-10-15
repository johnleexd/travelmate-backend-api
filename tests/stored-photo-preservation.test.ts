import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { canonicalStoredMedia, storedPhoto } from '../src/lib/stored-trip-media.ts';
import { createItineraryActivityPhotoResolver, fillGeneratedTripPhotos, fillMissingDayPhotos } from '../src/services/itinerary/activity-photo-fallback.ts';
import { enrichSavedActivityPhotos, mergeActivityPhotos, retainStoredActivityPhotos } from '../src/services/itinerary/saved-activity-photos.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import type { DayPlan, ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
const source = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Original.jpg';
const credit = { creator: 'Original photographer', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/?curid=123' };
const day: DayPlan = { day: 1, date: '2040-01-01', theme: 'Original itinerary', imageUrl: '', totalCost: 100, activities: [{ id: 'original', title: 'Original attraction', time: '09:00', description: 'Original description', category: 'activity', estimatedCost: 100, icon: 'map', location: 'City, Country' }] };
after(() => prisma.$disconnect());

test('stored photos with older field names or incomplete current metadata survive enrichment without any lookups', async () => {
  for (const fields of [{ imageUrl: source }, { photoUrl: source, photoAttribution: credit }, { image: { src: source, attribution: credit } }]) {
    const legacy = { ...day, activities: [{ ...day.activities[0], ...fields }] } as DayPlan;
    let calls = 0;
    const result = await fillMissingDayPhotos('City, Country', legacy, async () => { calls++; throw new Error('Offline'); });
    assert.deepEqual(result.activities, legacy.activities); assert.equal(calls, 0);
    const plan = { destination: 'City, Country', days: [legacy] } as ItineraryResponse;
    assert.equal(mergeActivityPhotos(plan, legacy, day), plan);
  }
});

test('only a confirmed failure for the current URL permits replacing a photo; empty/error responses retain every field', async () => {
  const stored = { ...day, activities: [{ ...day.activities[0], imageUrl: source, imageAttribution: credit }] };
  const failures = [{ index: 0, imageUrl: source }];
  for (const resolver of [async () => null, async () => { throw new Error('Timeout'); }]) {
    const result = await fillMissingDayPhotos('City, Country', stored, resolver, undefined, undefined, failures);
    assert.deepEqual(result, stored);
  }
  const replacement = { imageUrl: source.replace('Original', 'Replacement'), imageAttribution: credit };
  const enriched = await fillMissingDayPhotos('City, Country', stored, async () => replacement, undefined, undefined, failures);
  const plan = { destination: 'City, Country', days: [stored] } as ItineraryResponse;
  assert.equal(mergeActivityPhotos(plan, stored, enriched), plan);
  const updated = mergeActivityPhotos(plan, stored, enriched, failures);
  assert.equal(updated.days[0].activities[0].imageUrl, replacement.imageUrl);
  assert.equal(updated.days[0].activities[0].description, day.activities[0].description);
  assert.equal(updated.days[0].totalCost, 100);
  assert.equal(mergeActivityPhotos(plan, stored, enriched, [{ index: 0, imageUrl: 'stale' }]), plan);
});

test('legacy alias photos retain their source and credit through a manual timing edit', () => {
  const legacy = { ...day, activities: [{ ...day.activities[0], photoUrl: source, photoAttribution: credit }] };
  const plan = { destination: 'City, Country', totalBudget: 1000, currency: 'PHP', days: [legacy] };
  const submitted = { days: [{ activities: [{ ...legacy.activities[0], time: '09:15' }] }] };
  const edited = applyManualItineraryChanges(plan, submitted, 1, 1000, 1, 'PHP') as unknown as ItineraryResponse;
  assert.equal(edited.days[0].activities[0].imageUrl, source);
  assert.deepEqual(edited.days[0].activities[0].imageAttribution, credit);
  assert.deepEqual(storedPhoto(canonicalStoredMedia(legacy.activities[0], true)), { imageUrl: source, imageAttribution: credit });
});

test('new generation resolves photos before return and stays usable when a provider never responds', async () => {
  const plan = { destination: 'City, Country', days: [day] } as ItineraryResponse;
  const enriched = await fillGeneratedTripPhotos(plan, undefined, async () => ({ imageUrl: source, imageAttribution: credit }), 100);
  assert.equal(enriched.days[0].activities[0].imageUrl, source);
  assert.equal(enriched.days[0].activities[0].imageAttribution?.photoType, 'place');
  const started = Date.now();
  const offline = await fillGeneratedTripPhotos(plan, undefined, () => new Promise(() => {}), 20);
  assert.ok(Date.now() - started < 500); assert.deepEqual(offline, plan);
  const fallback = createItineraryActivityPhotoResolver(async (_subject, signal) => new Promise(resolve => signal!.addEventListener('abort', () => resolve(null), { once: true })), async () => ({ imageUrl: 'https://images.unsplash.com/photo-fallback', imageAttribution: { ...credit, provider: 'unsplash', license: 'Unsplash', photoId: 'fallback', illustrative: true, match: 'activity' } }), 10);
  const illustration = await fillGeneratedTripPhotos(plan, undefined, fallback, 100);
  assert.equal(illustration.days[0].activities[0].imageUrl, 'https://images.unsplash.com/photo-fallback');
  assert.equal(illustration.days[0].activities[0].imageAttribution?.photoType, 'illustrative');
});

test('replacement enrichment persists only the selected photo and reopening keeps it when providers are offline', async t => {
  const savedDay = { ...day, imageUrl: source, imageAttribution: credit, activities: [{ ...day.activities[0], imageUrl: source, imageAttribution: credit }] };
  const original = { destination: 'City, Country', totalBudget: 1000, currency: 'PHP', days: [savedDay], accommodation: { name: 'Saved hotel', total: 500 } } as ItineraryResponse;
  let current = { id: 'replacement-trip', userId: 'owner', destination: original.destination, itinerary: structuredClone(original), updatedAt: new Date() };
  const read = prisma.trip.findFirst, write = prisma.trip.updateMany;
  t.after(() => { prisma.trip.findFirst = read; prisma.trip.updateMany = write; });
  Reflect.set(prisma.trip, 'findFirst', async ({ where }: { where: { userId: string } }) => where.userId === current.userId ? current : null);
  let writes = 0;
  Reflect.set(prisma.trip, 'updateMany', async ({ where, data }: { where: { itinerary: { equals: unknown } }; data: { itinerary: ItineraryResponse } }) => {
    assert.deepEqual(Object.keys(data), ['itinerary']); assert.deepEqual(where.itinerary.equals, current.itinerary);
    writes++; current = { ...current, itinerary: structuredClone(data.itinerary) }; return { count: 1 };
  });
  const replacement = { imageUrl: source.replace('Original', 'Replacement'), imageAttribution: { ...credit, photoType: 'place' as const } };
  const failures = [{ index: 0, imageUrl: source }];
  const result = await enrichSavedActivityPhotos('owner', current.id, 1, async (destination, day, _, signal, selection, failed) => fillMissingDayPhotos(destination, day, async () => replacement, signal, selection, failed), failures);
  assert.equal(result?.persisted, true); assert.equal(writes, 1);
  assert.equal(current.itinerary.days[0].activities[0].imageUrl, replacement.imageUrl);
  assert.equal(current.itinerary.days[0].imageUrl, replacement.imageUrl);
  const retained = retainStoredActivityPhotos(original, current.itinerary);
  assert.equal(retained.days[0].imageUrl, replacement.imageUrl);
  assert.equal(retained.days[0].activities[0].imageUrl, replacement.imageUrl);
  assert.deepEqual(current.itinerary.accommodation, original.accommodation);
  assert.equal(current.itinerary.days[0].activities[0].description, original.days[0].activities[0].description);
  const before = structuredClone(current.itinerary);
  const reopened = await enrichSavedActivityPhotos('owner', current.id, 1, async (destination, day) => fillMissingDayPhotos(destination, day, async () => { throw new Error('Must not query an existing photo'); }));
  assert.equal(reopened?.persisted, false); assert.equal(writes, 1); assert.deepEqual(current.itinerary, before);
});
