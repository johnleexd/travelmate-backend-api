import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { activityPhotoSubject, createItineraryActivityPhotoResolver, fillMissingDayPhotos } from '../src/services/itinerary/activity-photo-fallback.ts';
import { matchUnsplashActivity } from '../src/services/itinerary/unsplash-activity-photos.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import { mergeActivityPhotos } from '../src/services/itinerary/saved-activity-photos.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import type { DayPlan, ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import type { GroundedPlace } from '../src/services/itinerary/grounded-places.ts';
import { nonPhotographicPlaceImage } from '../src/lib/place-photo-content.ts';
after(() => prisma.$disconnect());
const credit = { creator: 'Recorded author', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/?curid=123', photoType: 'place' as const };
const photo = { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Original.jpg', imageAttribution: credit };
const day: DayPlan = { day: 1, date: '2040-01-01', theme: 'Visits', imageUrl: photo.imageUrl, imageAttribution: credit, totalCost: 100, activities: [{ id: 'visit', title: 'Eiffel Tower', time: '09:00', description: 'Original notes', category: 'activity', icon: 'map', estimatedCost: 100, ...photo }] };
const plan = { destination: 'Paris, France', currency: 'EUR', totalBudget: 1000, days: [day] } as ItineraryResponse;

test('historic etchings and engravings cannot masquerade as actual place photos', () => {
  for (const evidence of ['Etchings by Israël Silvestre', '17th-century_engravings_of_Paris', 'Louvre sketch', 'Woodcut of a church', 'AI-generated temple']) assert.equal(nonPhotographicPlaceImage(evidence), true);
  assert.equal(nonPhotographicPlaceImage('Louvre Museum courtyard, photograph, architecture in Paris'), false);
  assert.equal(nonPhotographicPlaceImage('St-Denis de la Châtre vers 1650', 'Sylvestre Israël 1621-1691'), true);
  assert.equal(nonPhotographicPlaceImage('Modern photo of a cathedral built in 1650', 'Current photographer'), false);
});

test('notes, time and cost preserve stored photos; changing a place clears its photo and mirrored cover', () => {
  for (const patch of [{ description: 'New notes' }, { time: '11:00' }, { estimatedCost: 150 }]) {
    const edited = applyManualItineraryChanges(plan, { days: [{ activities: [{ ...day.activities[0], ...patch }] }] }, 1, 1000, 1, 'EUR') as unknown as ItineraryResponse;
    assert.equal(edited.days[0].activities[0].imageUrl, photo.imageUrl);
    assert.deepEqual(edited.days[0].activities[0].imageAttribution, credit);
  }
  const changed = applyManualItineraryChanges(plan, { days: [{ activities: [{ ...day.activities[0], title: 'Louvre Museum' }] }] }, 1, 1000, 1, 'EUR') as unknown as ItineraryResponse;
  assert.equal(changed.days[0].activities[0].imageUrl, undefined);
  assert.equal(changed.days[0].imageUrl, '');
});

test('a delayed photo response cannot overwrite a changed place; time/notes edits still accept it', () => {
  const before = { ...day, activities: day.activities.map(({ imageUrl, imageAttribution, ...activity }) => activity) };
  const changed = { ...plan, days: [{ ...before, activities: [{ ...before.activities[0], title: 'Louvre Museum' }] }] };
  assert.equal(mergeActivityPhotos(changed, before, day), changed);
  const notes = { ...plan, days: [{ ...before, activities: [{ ...before.activities[0], description: 'New notes', time: '12:00' }] }] };
  const merged = mergeActivityPhotos(notes, before, day);
  assert.equal(merged.days[0].activities[0].imageUrl, photo.imageUrl);
  assert.equal(merged.days[0].activities[0].description, 'New notes');
});

test('named titles work without an address; generic activities skip place search and remain illustrative', async () => {
  assert.equal(activityPhotoSubject(day.activities[0], plan.destination)?.name, 'Eiffel Tower');
  for (const title of ['Lunch', 'Beach walking']) assert.equal(activityPhotoSubject({ ...day.activities[0], title }, plan.destination)?.kind, 'generic');
  let wiki = 0;
  const resolve = createItineraryActivityPhotoResolver(async () => { wiki++; return photo; }, async () => ({ ...photo, imageAttribution: { ...credit, illustrative: true, match: 'activity' } }));
  const lunch = { ...day, activities: [{ ...day.activities[0], title: 'Lunch', imageUrl: undefined, imageAttribution: undefined }] };
  const enriched = await fillMissingDayPhotos(plan.destination, lunch, resolve);
  assert.equal(wiki, 0);
  assert.equal(enriched.activities[0].imageAttribution?.photoType, 'illustrative');
  const noPhoto = await fillMissingDayPhotos(plan.destination, lunch, async () => null);
  assert.equal(noPhoto.activities[0].title, 'Lunch');
  assert.equal(noPhoto.activities[0].imageUrl, undefined);
  const edited = applyManualItineraryChanges(plan, { days: [{ activities: [{ ...lunch.activities[0], title: 'Unavailable private venue' }] }] }, 1, 1000, 1, 'EUR') as unknown as ItineraryResponse;
  assert.equal(edited.days[0].activities[0].title, 'Unavailable private venue');
});

test('generic photos require relevant provider metadata, not just search position', () => {
  const subject = { name: 'Lunch', city: 'Paris', country: 'France', kind: 'generic' as const };
  assert.equal(matchUnsplashActivity({ asset_type: 'photo', description: 'A restaurant meal' }, subject), 'activity');
  assert.equal(matchUnsplashActivity({ asset_type: 'photo', description: 'A mountain landscape' }, subject), null);
  assert.equal(matchUnsplashActivity({ asset_type: 'photo', description: 'A restaurant meal', location: { country: 'Japan' } }, subject), null);
});

test('actual photo availability breaks close relevance ties; interests, geography and schedule win', () => {
  const anchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.85, longitude: 2.35 };
  const venue = (id: number, description: string, photographed = false): GroundedPlace => ({ ...anchor, provider: 'wikidata', placeId: `Q${id}`, name: `Venue ${id}`, description, sourceUrl: `https://www.wikidata.org/wiki/Q${id}`, fetchedAt: '2026-10-13T00:00:00Z', address: 'Not available', openingHours: 'Needs confirmation', ...(photographed ? photo : {}) });
  const choose = (places: GroundedPlace[], interests: string[] = []) => completeGroundedSchedule(anchor, places, [], '2040-01-01', 1, 1, 'relaxed', { interests })[0].visits;
  assert.equal(choose([venue(1, 'museum'), venue(2, 'museum', true)])[0].placeId, 'Q2');
  assert.equal(choose([venue(1, 'art museum'), venue(2, 'beach', true)], ['art'])[0].placeId, 'Q1');
  assert.equal(choose([venue(1, 'museum')]).length, 1);
  assert.equal(choose([venue(1, 'museum'), { ...venue(2, 'museum', true), country: 'Japan', countryCode: 'JP' }])[0].placeId, 'Q1');
  assert.equal(choose([venue(1, 'museum'), { ...venue(2, 'museum', true), openingWindows: [{ weekdays: [0,1,2,3,4,5,6], startMinutes: 600, endMinutes: 615 }] }])[0].placeId, 'Q1');
});
