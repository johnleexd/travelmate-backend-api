import test from 'node:test';
import assert from 'node:assert/strict';
import { fillStoredDestinationDayPhotos } from '../src/services/itinerary/stored-destination-day-photos.ts';
import { mergeActivityPhotos, retainStoredActivityPhotos } from '../src/services/itinerary/saved-activity-photos.ts';
import type { ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
const photo = { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Existing.jpg', imageAttribution: { creator: 'Original author', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/?curid=123' } };
const plan = () => ({ destination: 'Manila, Philippines', accommodation: { name: 'Preserve hotel', photos: [{ url: 'https://hotel-provider.test/photo.jpg' }] }, days: [{ day: 1, date: '2040-01-01', theme: 'Original theme', totalCost: 50, imageUrl: photo.imageUrl, imageAttribution: photo.imageAttribution, activities: [{ title: 'Original attraction', time: '09:00', category: 'activity', description: 'Original text', estimatedCost: 50, place: { name: 'Original attraction', city: 'Manila', country: 'Philippines' }, ...photo }] }, { day: 2, date: '2040-01-02', theme: 'Details need confirmation', totalCost: 20, imageUrl: '', activities: [{ title: 'Daily meals in Manila', time: 'Daily allowance', category: 'food', estimatedCost: 20 }] }] } as unknown as ItineraryResponse);
test('missing day covers reuse the stored destination with original credit without adding activities or changing trip data', () => {
  const before = plan(), result = fillStoredDestinationDayPhotos(before);
  assert.equal(result.days[0], before.days[0]);
  assert.equal(result.days[1].imageUrl, photo.imageUrl); assert.equal(result.days[1].imageAttribution?.photoType, 'destination'); assert.equal(result.days[1].imageAttribution?.illustrative, true);
  assert.equal(result.days[1].imageAttribution?.creator, photo.imageAttribution.creator);
  assert.deepEqual(result.days[1].activities, before.days[1].activities); assert.equal(result.days[1].totalCost, 20); assert.deepEqual(result.accommodation, before.accommodation);
  const persisted = mergeActivityPhotos(before, before.days[1], result.days[1]);
  assert.equal(persisted.days[1].imageUrl, photo.imageUrl);
  assert.equal(retainStoredActivityPhotos(before, persisted).days[1].imageUrl, photo.imageUrl);
  assert.equal(before.days[1].imageUrl, '');
});
test('existing covers, foreign attraction photos, restricted rights and hotel photos are preserved without becoming a new fallback', () => {
  const before = plan(); before.days[1] = { ...before.days[1], ...photo };
  assert.equal(fillStoredDestinationDayPhotos(before).days[1], before.days[1]);
  for (const change of [{ place: { name: 'Foreign attraction', city: 'Seoul', country: 'South Korea' } }, { imageAttribution: { ...photo.imageAttribution, license: 'CC BY-NC 4.0' } }, { category: 'accommodation' }]) {
    const invalid = plan(); invalid.days[0].imageUrl = ''; invalid.days[0].imageAttribution = undefined;
    Object.assign(invalid.days[0].activities[0], change);
    assert.equal(fillStoredDestinationDayPhotos(invalid).days[1].imageUrl, '');
  }
});
