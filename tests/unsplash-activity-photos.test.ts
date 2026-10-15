import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createUnsplashActivityResolver, matchUnsplashActivity, selectUnsplashActivityPhoto } from '../src/services/itinerary/unsplash-activity-photos.ts';
import { createUnsplashRequestClient, searchUnsplashPhotos } from '../src/services/destination/unsplash-cover-photos.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { fillMissingDayPhotos } from '../src/services/itinerary/activity-photo-fallback.ts';
import { enrichSavedActivityPhotos, mergeActivityPhotos, retainSelectedActivityPhotos, retainStoredActivityPhotos } from '../src/services/itinerary/saved-activity-photos.ts';
import { buildGroundedPlan, signGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { prisma } from '../src/lib/prisma.ts';
import { POST_SAVED_ACTIVITY_PHOTOS } from '../src/controllers/activity-photo-controller.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import type { DayPlan, ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
after(() => prisma.$disconnect());
const subject = { name: 'Recorded Falls', city: 'Recorded Town', region: 'Recorded Province', country: 'Philippines', countryCode: 'PH', latitude: 10, longitude: 123 };
const photo = (id = 'exact') => ({ id, description: 'Recorded Falls entrance', asset_type: 'photo', urls: { regular: 'https://images.unsplash.com/photo-123?ixid=preserved&w=1080&q=80' }, location: { city: subject.city, country: subject.country, position: { latitude: 10, longitude: 123 } }, user: { name: 'Actual photographer', username: 'author', links: { html: 'https://unsplash.com/@author' } }, links: { html: 'https://unsplash.com/photos/' + id, download_location: 'https://api.unsplash.com/photos/' + id + '/download?ixid=provider-token' } });
const day = { day: 1, date: '2040-01-01', theme: 'Original day', imageUrl: '', totalCost: 123, activities: [{ id: 'activity', title: 'Visit Recorded Falls', time: '10:00', category: 'activity', estimatedCost: 123, description: 'Original description', icon: 'map', place: { ...subject, name: subject.name, provider: 'wikidata', placeId: 'Q123', fetchedAt: '2040-01-01T00:00:00Z', sourceUrl: 'https://www.wikidata.org/wiki/Q123', openingHours: 'Needs confirmation', address: 'Original address' } }] } as DayPlan;
const plan = { destination: 'Recorded Town, Recorded Province, Philippines', days: [day], currency: 'PHP', totalBudget: 1000, travelers: 1, budgetSummary: { total: 1000 } } as ItineraryResponse;
const resolver = (records: ReturnType<typeof photo>[], calls: string[]) => createUnsplashActivityResolver(fetch, () => 'fixture-key', async url => { calls.push(url); return url.includes('/search/') ? { results: records } : records.find(item => new URL(url).pathname.endsWith('/' + item.id)); });

test('full identity, country and coordinates distinguish exact, illustrative and unrelated photos', () => {
  assert.equal(matchUnsplashActivity(photo(), subject), 'place');
  assert.equal(matchUnsplashActivity({ ...photo(), description: 'City streets' }, subject), 'destination');
  assert.equal(matchUnsplashActivity({ ...photo(), location: { city: subject.city, country: subject.country } }, subject), 'place');
  for (const invalid of [
    { ...photo(), location: { ...photo().location, country: 'Japan' } },
    { ...photo(), location: { ...photo().location, position: { latitude: 35, longitude: 139 } } },
    { ...photo(), location: undefined },
    { ...photo(), asset_type: 'illustration' },
    { ...photo(), description: 'Recorded Falls logo' },
    { ...photo(), description: 'Recorded Falls flag' },
    { ...photo(), location: { ...photo().location, position: { latitude: NaN, longitude: 123 } } },
  ]) assert.equal(matchUnsplashActivity(invalid, subject), null);
});

test('multiple hits are evaluated; exact selection retains hotlink and linked credit; equivalent requests coalesce', async () => {
  clearProviderCache(); const calls: string[] = [];
  const wrong = { ...photo('wrong'), location: { ...photo().location, country: 'Japan' } };
  const find = resolver([wrong, photo('exact')], calls);
  const [a, b] = await Promise.all([find(subject), find({ ...subject, name: 'RECORDED FALLS' })]);
  assert.deepEqual(a, b); assert.equal(a!.imageAttribution.photoId, 'exact'); assert.equal(a!.imageAttribution.illustrative, false);
  assert.equal(a!.imageUrl, photo().urls.regular); assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0]).searchParams.get('query'), 'Recorded Falls Recorded Town Recorded Province Philippines');
  for (const url of [a!.imageAttribution.sourceUrl, a!.imageAttribution.photographerUrl!]) { assert.equal(new URL(url).searchParams.get('utm_source'), 'travelmate'); assert.equal(new URL(url).searchParams.get('utm_medium'), 'referral'); }
  await find(subject); assert.equal(calls.length, 3);
});

test('destination matches remain explicitly illustrative; no confident match and API errors return null', async () => {
  clearProviderCache(); const calls: string[] = [];
  const result = await resolver([{ ...photo(), description: 'Recorded Town streets' }], calls)(subject);
  assert.equal(result!.imageAttribution.illustrative, true); assert.equal(result!.imageAttribution.match, 'destination');
  clearProviderCache(); assert.equal(await resolver([], [])(subject), null);
  clearProviderCache(); assert.equal(await createUnsplashActivityResolver(fetch, () => 'key', async () => { throw new Error('HTTP 429'); })(subject), null);
  assert.equal(await createUnsplashActivityResolver(fetch, () => '')(subject), null);
});

test('shared search cache deduplicates equivalent queries including empty results', async () => {
  clearProviderCache(); let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ results: [] }); }) as typeof fetch;
  await Promise.all([searchUnsplashPhotos(new URLSearchParams({ query: 'Recorded Town  Philippines', per_page: '6' }), 'key', fetcher), searchUnsplashPhotos(new URLSearchParams({ per_page: '6', query: 'recorded town Philippines' }), 'key', fetcher)]);
  assert.equal(calls, 1);
});

test('provider rate limits and outages stop further network calls until cooldown expires', async () => {
  for (const status of [429, 503]) {
    let now = 1000, calls = 0; const request = createUnsplashRequestClient(0, () => now);
    const fetcher = (async () => { calls++; return new Response('', { status, headers: { 'Retry-After': '60' } }); }) as typeof fetch;
    await assert.rejects(request('https://api.unsplash.com/search/photos?query=test', 'key', fetcher));
    await assert.rejects(request('https://api.unsplash.com/photos/exact', 'key', fetcher), /cooling down/); assert.equal(calls, 1);
    now += 61000; await assert.rejects(request('https://api.unsplash.com/photos/exact', 'key', fetcher)); assert.equal(calls, 2);
  }
});

test('selection tracking calls the returned download URL once, not the binary URL or every render', async t => {
  clearProviderCache(); const previous = process.env.UNSPLASH_ACCESS_KEY; process.env.UNSPLASH_ACCESS_KEY = 'fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.UNSPLASH_ACCESS_KEY; else process.env.UNSPLASH_ACCESS_KEY = previous; });
  const result = (await resolver([photo()], [])(subject))!; const calls: string[] = [];
  const fetcher = (async input => { calls.push(String(input)); return Response.json({ url: 'unused' }); }) as typeof fetch;
  const selected = await selectUnsplashActivityPhoto(result, 'test-trip', undefined, fetcher);
  await selectUnsplashActivityPhoto(result, 'test-trip', undefined, fetcher);
  assert.equal(selected.imageAttribution.downloadTracked, true); assert.ok(selected.imageAttribution.selectedAt);
  assert.deepEqual(calls, [photo().links.download_location]); assert.equal(selected.imageUrl, result.imageUrl);
});

test('photo-only merge preserves concurrent edits, budgets, hotels and existing photos; saved proof remains valid', async () => {
  clearProviderCache(); const selected = (await resolver([photo()], [])(subject))!;
  const enriched = { ...day, totalCost: 9999, activities: [{ ...day.activities[0], estimatedCost: 9999, ...selected }] };
  const latest = { ...plan, days: [{ ...day, totalCost: 456, activities: [{ ...day.activities[0], description: 'Concurrent description', estimatedCost: 456 }] }], accommodation: { name: 'Original hotel' }, grounding: { test: true } } as unknown as ItineraryResponse;
  latest.groundingProof = signGroundedPlan(latest);
  const updated = mergeActivityPhotos(latest, day, enriched);
  assert.equal(updated.days[0].activities[0].description, 'Concurrent description'); assert.equal(updated.days[0].totalCost, 456); assert.equal(updated.days[0].activities[0].estimatedCost, 456); assert.deepEqual(updated.accommodation, latest.accommodation); assert.ok(verifyGroundedPlan(updated));
  assert.equal(retainStoredActivityPhotos(latest, updated).days[0].activities[0].imageUrl, selected.imageUrl);
  assert.equal(retainStoredActivityPhotos({ ...latest, days: [{ ...latest.days[0], activities: [{ ...latest.days[0].activities[0], imageUrl: 'new-cache-choice', imageAttribution: selected.imageAttribution }] }] }, updated).days[0].activities[0].imageUrl, selected.imageUrl);
  assert.equal(mergeActivityPhotos(updated, day, { ...enriched, activities: [{ ...enriched.activities[0], imageUrl: 'replacement' }] }), updated);
  const moved = { ...latest, days: [{ ...latest.days[0], activities: [{ ...latest.days[0].activities[0], place: { ...day.activities[0].place!, longitude: 124 } }] }] };
  assert.equal(mergeActivityPhotos(moved, day, enriched), moved);
  await fillMissingDayPhotos(plan.destination, day, async () => selected);
  assert.equal(retainSelectedActivityPhotos(plan).days[0].activities[0].imageUrl, selected.imageUrl);
});

test('owned saved-trip enrichment retries compare-and-swap and updates only photo JSON fields', async t => {
  clearProviderCache(); const selected = (await resolver([photo()], [])(subject))!;
  let current: any = { id: 'trip', userId: 'owner', destination: plan.destination, itinerary: plan, updatedAt: new Date(), budget: 1000 };
  let writes = 0;
  const replace = (key: string, value: unknown) => { const previous = Reflect.get(prisma.trip, key); Reflect.set(prisma.trip, key, value); t.after(() => Reflect.set(prisma.trip, key, previous)); };
  replace('findFirst', async ({ where }: any) => where.userId === current.userId ? current : null);
  replace('updateMany', async ({ where, data }: any) => { writes++; assert.deepEqual(Object.keys(data), ['itinerary']); assert.deepEqual(where.itinerary.equals, current.itinerary); if (writes === 1) { current = { ...current, itinerary: { ...plan, days: [{ ...day, activities: [{ ...day.activities[0], description: 'New edit' }] }] }, updatedAt: new Date(Date.now() + 1) }; return { count: 0 }; } current.itinerary = data.itinerary; return { count: 1 }; });
  assert.equal(await enrichSavedActivityPhotos('other', 'trip', 1, async () => { throw new Error('Must not run'); }), null);
  const result = await enrichSavedActivityPhotos('owner', 'trip', 1, async () => ({ ...day, activities: [{ ...day.activities[0], ...selected }] }));
  assert.equal(result!.persisted, true); assert.equal(writes, 2); assert.equal(current.itinerary.days[0].activities[0].description, 'New edit'); assert.equal(current.budget, 1000);
  const reopened = await enrichSavedActivityPhotos('owner', 'trip', 1, async (_destination, savedDay) => savedDay);
  assert.equal(reopened!.persisted, false); assert.equal(writes, 2);
});

test('verified Wikimedia thumbnail and complete attribution persist and remain unchanged on reopening', async t => {
  const selected = { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Recorded_Falls.jpg/960px-Recorded_Falls.jpg', imageAttribution: { creator: 'Commons photographer', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/?curid=42' } };
  let current = { id: 'wiki-trip', userId: 'owner', destination: plan.destination, itinerary: plan, updatedAt: new Date(), budget: 1000 };
  let writes = 0;
  const oldRead = prisma.trip.findFirst, oldWrite = prisma.trip.updateMany;
  t.after(() => { prisma.trip.findFirst = oldRead; prisma.trip.updateMany = oldWrite; });
  Reflect.set(prisma.trip, 'findFirst', async ({ where }: any) => where.userId === current.userId ? current : null);
  Reflect.set(prisma.trip, 'updateMany', async ({ data }: any) => { assert.deepEqual(Object.keys(data), ['itinerary']); writes++; current = { ...current, itinerary: data.itinerary }; return { count: 1 }; });
  const enriched = await enrichSavedActivityPhotos('owner', 'wiki-trip', 1, async (_destination, savedDay) => ({ ...savedDay, activities: [{ ...savedDay.activities[0], ...selected }] }));
  assert.equal(enriched?.persisted, true);
  const reopened = await enrichSavedActivityPhotos('owner', 'wiki-trip', 1, async (_destination, savedDay) => savedDay);
  assert.equal(reopened?.persisted, false); assert.equal(writes, 1);
  assert.equal(reopened?.day?.activities[0].imageUrl, selected.imageUrl);
  assert.deepEqual(reopened?.day?.activities[0].imageAttribution, selected.imageAttribution);
  assert.equal(current.budget, 1000);
});

test('saved-photo endpoint requires an authenticated owner and ignores submitted trip fields', async t => {
  const replace = (target: object, key: string, value: unknown) => { const old = Reflect.get(target, key); Reflect.set(target, key, value); t.after(() => Reflect.set(target, key, old)); };
  replace(prisma.user, 'findFirst', async () => ({ id: 'owner', name: 'Fixture owner', email: 'test@example.test', role: 'traveler', accountStatus: 'active', emailVerified: true }));
  replace(prisma, '$queryRaw', async () => [{ count: 1 }]); t.mock.method(Math, 'random', () => 0.5);
  let reads = 0;
  replace(prisma.trip, 'findFirst', async ({ where }: any) => { reads++; assert.equal(where.userId, 'owner'); assert.equal(where.status, undefined); return null; });
  const request = (value: object, authenticated = true) => new Request('http://localhost/api/platform/trips/other-trip/photos', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie: 'travelmate_session=' + createSessionToken('owner', 'traveler') } : {}) }, body: JSON.stringify(value) });
  assert.equal((await POST_SAVED_ACTIVITY_PHOTOS(request({ day: 1 }, false))).status, 401); assert.equal(reads, 0);
  assert.equal((await POST_SAVED_ACTIVITY_PHOTOS(request({ day: 32 }))).status, 400); assert.equal(reads, 0);
  assert.equal((await POST_SAVED_ACTIVITY_PHOTOS(request({ day: 1, itinerary: { forged: true }, budget: 1 }))).status, 404); assert.equal(reads, 1);
});

test('new generation photo metadata survives strict save parsing and the grounded proof', async () => {
  clearProviderCache(); const selected = (await resolver([photo()], [])(subject))!;
  const anchor = { city: subject.city, country: subject.country, countryCode: 'PH', latitude: subject.latitude, longitude: subject.longitude };
  const generated = buildGroundedPlan({ destination: plan.destination, anchor, startingLocation: '', startDate: day.date, endDate: day.date, budget: 1000, currency: 'PHP', travelers: 1, partyType: 'solo', rooms: 1, places: [{ ...day.activities[0].place!, provider: 'wikidata', description: 'Fixture source description' }], placeDataStatus: 'live', source: 'catalog', transportation: 'Walking', schedule: [{ day: 1, date: day.date, theme: 'Visit', visits: [{ placeId: 'Q123', startMinutes: 600, durationMinutes: 60, participants: 1 }] }] });
  const enriched = mergeActivityPhotos(generated, generated.days[0], { ...generated.days[0], activities: generated.days[0].activities.map(activity => activity.place ? { ...activity, ...selected } : activity) });
  const saved = parseSavedItinerary(enriched, { destination: plan.destination, startDate: day.date, days: 1, currency: 'PHP', budget: 1000, travelers: 1, partyType: 'solo' });
  assert.deepEqual(saved.days[0].activities[0].imageAttribution, selected.imageAttribution);
  assert.equal(saved.days[0].activities[0].imageUrl, selected.imageUrl); assert.ok(verifyGroundedPlan(saved as ItineraryResponse));
  assert.equal(saved.days[0].totalCost, generated.days[0].totalCost); assert.deepEqual(saved.grounding!.categories, generated.grounding!.categories);
  const manual = { ...enriched, days: enriched.days.map(day => ({ ...day, activities: day.activities.map(activity => activity.place ? { ...activity, place: undefined, placeVerification: 'unverified' as const, location: 'Recorded Falls, Recorded Town, Philippines' } : activity) })) };
  manual.groundingProof = signGroundedPlan(manual);
  const manualSaved = parseSavedItinerary(manual, { destination: plan.destination, startDate: day.date, days: 1, currency: 'PHP', budget: 1000, travelers: 1, partyType: 'solo' });
  assert.equal(manualSaved.days[0].activities[0].placeVerification, 'unverified'); assert.equal(manualSaved.days[0].activities[0].imageUrl, selected.imageUrl);
  for (const invalid of [{ ...selected.imageAttribution, photographerUrl: 'https://evil.test/@author' }, { ...selected.imageAttribution, illustrative: false, match: 'destination' as const }]) {
    const corrupted = { ...enriched, days: enriched.days.map(day => ({ ...day, activities: day.activities.map(activity => activity.place ? { ...activity, imageAttribution: invalid } : activity) })) };
    corrupted.groundingProof = signGroundedPlan(corrupted);
    assert.throws(() => parseSavedItinerary(corrupted, { destination: plan.destination, startDate: day.date, days: 1, currency: 'PHP', budget: 1000, travelers: 1, partyType: 'solo' }), /place-linked source attribution/);
  }
});

test('failed selection tracking retains the image and records a pending retry without blocking the trip', async t => {
  clearProviderCache(); const previous = process.env.UNSPLASH_ACCESS_KEY; process.env.UNSPLASH_ACCESS_KEY = 'fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.UNSPLASH_ACCESS_KEY; else process.env.UNSPLASH_ACCESS_KEY = previous; });
  const result = (await resolver([photo()], [])(subject))!;
  const selected = await selectUnsplashActivityPhoto(result, 'outage-trip', undefined, (async () => new Response('', { status: 503 })) as typeof fetch);
  assert.equal(selected.imageUrl, result.imageUrl); assert.equal(selected.imageAttribution.downloadTracked, false); assert.equal(selected.imageAttribution.photoId, result.imageAttribution.photoId);
});
