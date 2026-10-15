import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDestinationCoverPhoto as resolveCover, destinationPhotoQuerySchema } from '../src/services/destination/destination-cover-photo.ts';
import { searchGlobalLocations } from '../src/services/destination/global-location-search.ts';
import type { GroundedPlace } from '../src/services/itinerary/grounded-places.ts';

const noPlaces = async () => ({ places: [] as GroundedPlace[], status: 'unavailable' as const });
const resolveDestinationCoverPhoto = (input: Parameters<typeof resolveCover>[0], search?: Parameters<typeof resolveCover>[1], places?: Parameters<typeof resolveCover>[2]) => resolveCover(input, search, places, async () => null);
test('Manila and Fukuoka resolve to different licensed real landmark or city photos without new provider setup', async () => {
  for (const [city, countryCode, file] of [['Manila', 'PH', 'The_Manila_Cathedral'], ['Fukuoka', 'JP', 'Fukuoka_City_from_Fukuoka_Tower']]) {
    const photo = await resolveDestinationCoverPhoto({ city, countryCode }, searchGlobalLocations, noPlaces);
    assert.equal(photo?.city, city); assert.equal(photo?.scope, 'destination');
    assert.ok(photo?.src.includes(file));
    assert.ok(photo?.attribution.sourceUrl.startsWith('https://commons.wikimedia.org/wiki/File:'));
    assert.ok(photo?.attribution.licenseUrl?.startsWith('https://creativecommons.org/'));
    assert.ok(!photo?.src.includes('flag'));
  }
});
test('country conflicts, distant saved coordinates and unknown place identities never select a similarly named destination', async () => {
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila', country: 'Japan', countryCode: 'PH' }, searchGlobalLocations, noPlaces), null);
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila', countryCode: 'PH', latitude: 33.6, longitude: 130.4 }, searchGlobalLocations, noPlaces), null);
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila' }, searchGlobalLocations, noPlaces), null);
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila', countryCode: 'PH' }, async () => [], noPlaces), null);
});
test('legacy saved country names resolve the correct city and country', async () => {
  assert.equal((await resolveDestinationCoverPhoto({ city: 'Fukuoka', country: 'Japan' }, searchGlobalLocations, noPlaces))?.city, 'Fukuoka');
});
test('ambiguous cities do not pick an arbitrary match; coordinates narrow duplicate names', async () => {
  const match = (await searchGlobalLocations('Manila, PH'))[0];
  const search = async () => [match, { ...match, latitude: 1, longitude: 2 }];
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila', countryCode: 'PH' }, search, noPlaces), null);
  assert.equal((await resolveDestinationCoverPhoto({ city: 'Manila', countryCode: 'PH', latitude: match.latitude, longitude: match.longitude }, search, noPlaces))?.scope, 'destination');
});
test('other destinations reuse only matched licensed photographs from the existing grounded-place provider', async () => {
  const match = (await searchGlobalLocations('Paris, FR'))[0];
  const place: GroundedPlace = { provider: 'wikidata', placeId: 'Q100', name: 'Paris museum', city: match.name, country: match.country, countryCode: 'FR',
    latitude: match.latitude, longitude: match.longitude, sourceUrl: 'https://www.wikidata.org/wiki/Q100', fetchedAt: new Date().toISOString(),
    description: 'museum in Paris', address: '', openingHours: '', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Paris_museum.jpg',
    imageAttribution: { creator: 'Test author', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Paris_museum.jpg' } };
  const load = async () => ({ places: [ { ...place, city: 'London' }, { ...place, countryCode: 'JP' },
    { ...place, imageUrl: place.imageUrl!.replace('Paris_museum', 'Flag_of_France') }, { ...place, imageAttribution: undefined }, place ], status: 'live' as const });
  const photo = await resolveDestinationCoverPhoto({ city: 'Paris', countryCode: 'FR' }, searchGlobalLocations, load);
  assert.equal(photo?.src, place.imageUrl); assert.equal(photo?.city, 'Paris');
});
test('unrelated country photos never substitute for an unavailable destination cover', async () => {
  const fallback = await resolveDestinationCoverPhoto({ city: 'Cebu City', countryCode: 'PH' }, searchGlobalLocations, noPlaces);
  assert.equal(fallback, null);
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Paris', countryCode: 'FR' }, searchGlobalLocations, noPlaces), null);
});
test('photo query rejects partial or invalid coordinates and unsafe country/city inputs', () => {
  assert.equal(destinationPhotoQuerySchema.safeParse({ city: 'Manila', countryCode: 'PH', latitude: 14 }).success, false);
  assert.equal(destinationPhotoQuerySchema.safeParse({ city: 'Manila', latitude: 91, longitude: 120 }).success, false);
  assert.equal(destinationPhotoQuerySchema.safeParse({ city: 'Manila', countryCode: 'Philippines' }).success, false);
  assert.equal(destinationPhotoQuerySchema.safeParse({ city: 'x'.repeat(101) }).success, false);
});
test('city fallback avoids the attraction catalog and preserves its real attribution', async () => {
  const photo = { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Paris_skyline.jpg', imageAttribution: { creator: 'Recorded photographer', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/?curid=42' } };
  const cover = await resolveCover({ city: 'Paris', countryCode: 'FR' }, searchGlobalLocations, async () => { throw Error('Catalog should not be called'); }, async anchor => { assert.equal(anchor.city, 'Paris'); return photo; });
  assert.equal(cover?.scope, 'destination'); assert.deepEqual(cover?.attribution, photo.imageAttribution);
  assert.equal(cover?.label, 'Destination photo: Paris, France');
});
test('region conflict cannot resolve a similarly named city in another region', async () => {
  const match = (await searchGlobalLocations('Manila, PH'))[0];
  assert.equal(await resolveDestinationCoverPhoto({ city: 'Manila', countryCode: 'PH', region: 'Unrelated region' }, async () => [match], noPlaces), null);
});
