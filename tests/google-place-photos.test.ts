import test from 'node:test';
import assert from 'node:assert/strict';
import { createGooglePlacePhotoResolver, googlePlaceMatches } from '../src/services/itinerary/google-place-photos.ts';
import { fillDayDisplayPhotos } from '../src/services/itinerary/activity-display-photos.ts';
import { enrichSavedActivityPhotos, mergeActivityPhotos, retainStoredActivityPhotos } from '../src/services/itinerary/saved-activity-photos.ts';
import type { DayPlan, ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { prisma } from '../src/lib/prisma.ts';

const subject = { name: 'Exact Temple', city: 'Recorded City', country: 'Japan', countryCode: 'JP', latitude: 35, longitude: 139 };
const id = 'ChIJ_verified_place';
const place = () => ({ id, displayName: { text: subject.name }, location: { latitude: 35, longitude: 139 }, addressComponents: [{ longText: subject.city, types: ['locality'] }, { longText: 'Japan', shortText: 'JP', types: ['country'] }], photos: [{ name: `places/${id}/photos/fresh-reference`, widthPx: 1200, heightPx: 800, googleMapsUri: 'https://www.google.com/maps/place/?photo=source', authorAttributions: [{ displayName: 'Real Author', uri: 'https://www.google.com/maps/contrib/123', photoUri: 'https://lh3.googleusercontent.com/avatar' }] }] });
const day = (): DayPlan => ({ day: 1, date: '2040-01-01', theme: 'Recorded visits', imageUrl: '', totalCost: 50, activities: [{ title: subject.name, time: '09:00', description: 'Keep this description', estimatedCost: 50, category: 'activity', icon: 'map', location: subject.city, place: { ...subject, provider: 'wikidata', placeId: 'Q1', sourceUrl: 'https://www.wikidata.org/wiki/Q1', fetchedAt: '2040-01-01T00:00:00Z', address: 'Recorded address', openingHours: 'Confirm hours' } }] });

test('configuration disables every Google request even when a key and saved Place ID exist', async () => {
  let calls = 0;
  const resolver = createGooglePlacePhotoResolver(async () => { calls++; throw new Error('Must not request Google'); }, { key: () => 'configured-private-value', enabled: () => false });
  assert.deepEqual(await resolver(subject, id), { photo: null }); assert.equal(calls, 0);
});

test('identity validation rejects wrong country, city, name, coordinates, and absent geographic evidence', () => {
  assert.equal(googlePlaceMatches(place(), subject), true);
  for (const wrong of [{ ...place(), displayName: { text: 'Different Temple' } }, { ...place(), location: { latitude: 36, longitude: 139 } }, { ...place(), addressComponents: [] }, { ...place(), addressComponents: [{ longText: 'Other City', types: ['locality'] }, { longText: 'Japan', shortText: 'JP', types: ['country'] }] }, { ...place(), addressComponents: [{ longText: subject.city, types: ['locality'] }, { longText: 'China', shortText: 'CN', types: ['country'] }] }]) assert.equal(googlePlaceMatches(wrong, subject), false);
  assert.equal(googlePlaceMatches({ ...place(), addressComponents: [] }, { ...subject, latitude: undefined, longitude: undefined }), false);
});

test('official API uses private headers, rejects ambiguity, and retains only IDs between displays', async () => {
  const requests: { path: string; headers: Headers }[] = [];
  const resolver = createGooglePlacePhotoResolver(async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.hostname, 'places.googleapis.com'); assert.equal(url.searchParams.has('key'), false); assert.equal(headers.get('X-Goog-Api-Key'), 'private-test-value'); assert.equal(init?.cache, 'no-store');
    requests.push({ path: url.pathname, headers });
    if (url.pathname.endsWith('/media')) { assert.equal(url.searchParams.get('maxWidthPx'), '960'); assert.equal(url.searchParams.get('maxHeightPx'), '720'); return Response.json({ photoUri: 'https://lh3.googleusercontent.com/fresh-image' }); }
    return Response.json(url.pathname.endsWith('searchText') ? { places: [place()] } : place());
  }, { key: () => 'private-test-value' });
  const [a, b] = await Promise.all([resolver(subject), resolver(subject)]);
  assert.deepEqual(a, b); assert.equal(a.placeId, id); assert.ok(a.photo); assert.equal(requests.length, 2);
  await resolver(subject, id); assert.equal(requests.length, 4); assert.equal(requests[2].path, `/v1/places/${id}`);
  assert.equal(a.photo?.authors[0].displayName, 'Real Author'); assert.equal(JSON.stringify(a).includes('fresh-reference'), false);
  let media = 0;
  const ambiguous = createGooglePlacePhotoResolver(async input => { if (String(input).includes('/media?')) media++; return Response.json({ places: [place(), { ...place(), id: 'ChIJ_another_place' }] }); }, { key: () => 'private-test-value' });
  assert.equal((await ambiguous(subject)).photo, null); assert.equal(media, 0);
});

test('expired names refresh once; configuration errors cool down and do not disclose a key', async () => {
  let media = 0, details = 0;
  const resolver = createGooglePlacePhotoResolver(async input => {
    if (String(input).includes('/media?')) return ++media === 1 ? Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 }) : Response.json({ photoUri: 'https://lh3.googleusercontent.com/image' });
    if (!String(input).includes('searchText')) details++;
    return Response.json(String(input).includes('searchText') ? { places: [place()] } : place());
  }, { key: () => 'private-test-value' });
  assert.ok((await resolver(subject)).photo); assert.equal(media, 2); assert.equal(details, 1);
  let calls = 0;
  const blocked = createGooglePlacePhotoResolver(async () => { calls++; return Response.json({ error: { status: 'PERMISSION_DENIED', message: 'private-test-value forbidden', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }, { status: 403 }); }, { key: () => 'private-test-value' });
  const warnings: string[] = [], original = console.warn; console.warn = value => warnings.push(String(value));
  try { assert.equal((await blocked(subject)).photo, null); assert.equal((await blocked({ ...subject, name: 'Another Temple' })).photo, null); }
  finally { console.warn = original; }
  assert.equal(calls, 1); assert.ok(warnings[0].includes('API_KEY_SERVICE_BLOCKED')); assert.equal(warnings.join('').includes('private-test-value'), false);
});

test('working photos and hotels bypass Google; success stores only ID and image failures use fallback', async () => {
  const photo = { placeId: id, imageUrl: 'https://lh3.googleusercontent.com/image', googleMapsUri: place().photos[0].googleMapsUri, authors: place().photos[0].authorAttributions };
  const fallbackPhoto = { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Saved.jpg', imageAttribution: { creator: 'Saved Author', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/?curid=1' } };
  let googleCalls = 0, fallbackCalls = 0;
  const google = async () => { googleCalls++; return { placeId: id, photo }; };
  const fallback = async () => { fallbackCalls++; return fallbackPhoto; };
  const original = day(), result = await fillDayDisplayPhotos('Recorded City, Japan', original, undefined, undefined, [], google, fallback);
  assert.equal(result.day.activities[0].googlePlaceId, id); assert.equal(result.day.activities[0].imageUrl, undefined); assert.ok(result.googlePhotos[0]); assert.equal(fallbackCalls, 0);
  const plan = { destination: 'Recorded City, Japan', days: [original] } as ItineraryResponse;
  const stored = mergeActivityPhotos(plan, original, result.day);
  assert.equal(stored.days[0].activities[0].googlePlaceId, id); assert.equal(JSON.stringify(stored).includes('googleusercontent'), false); assert.equal(JSON.stringify(stored).includes('fresh-reference'), false); assert.equal(stored.days[0].activities[0].description, original.activities[0].description);
  assert.equal(retainStoredActivityPhotos(plan, stored).days[0].activities[0].googlePlaceId, id);
  const rescheduled = { ...plan, days: [{ ...original, activities: [{ ...original.activities[0], time: '10:00' }] }] };
  assert.equal(retainStoredActivityPhotos(rescheduled, stored).days[0].activities[0].googlePlaceId, id);
  const different = { ...rescheduled, days: [{ ...original, activities: [{ ...original.activities[0], place: { ...original.activities[0].place!, name: 'Different Temple' } }] }] };
  assert.equal(retainStoredActivityPhotos(different, stored).days[0].activities[0].googlePlaceId, undefined);
  const working = { ...original, activities: [{ ...original.activities[0], ...fallbackPhoto }, { ...original.activities[0], category: 'accommodation' as const }] };
  await fillDayDisplayPhotos('Recorded City, Japan', working, undefined, undefined, [], google, fallback); assert.equal(googleCalls, 1);
  const failed = await fillDayDisplayPhotos('Recorded City, Japan', original, undefined, undefined, [], google, fallback, [0]); assert.equal(failed.day.activities[0].imageUrl, fallbackPhoto.imageUrl); assert.equal(googleCalls, 1); assert.equal(fallbackCalls, 1);
});

test('the save schema blocks transient Google URLs rather than persisting submitted photo content', () => {
  const original = day();
  original.activities[0] = { ...original.activities[0], place: undefined, imageUrl: 'https://lh3.googleusercontent.com/transient' };
  const plan = { destination: 'Recorded City, Japan', totalBudget: 1000, currency: 'PHP', partyType: 'solo', travelers: 1, days: [original], budgetSummary: { accommodation: 0, food: 0, activities: 50, transport: 0, reserve: 950, total: 1000, dailyAverage: 50 } };
  assert.throws(() => parseSavedItinerary(plan, { days: 1, budget: 1000, currency: 'PHP', travelers: 1, partyType: 'solo' }), /Google photo URLs are transient/);
});

test('owned completed/archived saved trips can retain matched IDs without changing lifecycle or activity data', async () => {
  const find = prisma.trip.findFirst, update = prisma.trip.updateMany;
  try {
    for (const status of ['completed', 'archived']) {
      const original = day(), plan = { destination: 'Recorded City, Japan', days: [original] } as ItineraryResponse;
      let writes = 0;
      prisma.trip.findFirst = (async (args: any) => { assert.equal(args.where.userId, 'owner'); assert.equal(args.where.status, undefined); return { id: 'trip', status, destination: plan.destination, updatedAt: new Date(), itinerary: plan }; }) as any;
      prisma.trip.updateMany = (async (args: any) => { writes++; assert.equal(args.where.status, status); assert.deepEqual(Object.keys(args.data), ['itinerary']); assert.equal(args.data.itinerary.days[0].activities[0].googlePlaceId, id); assert.equal(args.data.itinerary.days[0].activities[0].description, original.activities[0].description); return { count: 1 }; }) as any;
      const result = await enrichSavedActivityPhotos('owner', 'trip', 1, async (_destination, input) => ({ ...input, activities: input.activities.map(activity => ({ ...activity, googlePlaceId: id })) }));
      assert.equal(result?.persisted, true); assert.equal(writes, 1);
    }
  } finally { prisma.trip.findFirst = find; prisma.trip.updateMany = update; }
});
