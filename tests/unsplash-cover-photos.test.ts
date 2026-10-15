import assert from 'node:assert/strict';
import test from 'node:test';
import { loadUnsplashDestinationPhotos, trackUnsplashCoverSelection, verifiedUnsplashPhoto } from '../src/services/destination/unsplash-cover-photos.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';

const destination = { city: 'Manila', country: 'Philippines', countryCode: 'PH', latitude: 14.6042, longitude: 120.9822 };
const photo = (id = 'manila-photo') => ({
  id, asset_type: 'photo', description: 'Manila skyline', alt_description: 'city buildings at sunset',
  urls: { regular: 'https://images.unsplash.com/photo-1598258710957-db8614c2881e?ixid=required-provider-token&ixlib=rb-4.1.0&w=1080&q=80' },
  location: { city: 'Manila', country: 'Philippines', name: 'Manila, Philippines', position: { latitude: 14.609054, longitude: 121.022257 } },
  user: { name: 'Alexes Gerard', links: { html: 'https://unsplash.com/@xlexes' } },
  links: { html: 'https://unsplash.com/photos/' + id, download_location: 'https://api.unsplash.com/photos/' + id + '/download?ixid=tracking-token' },
});
test('verified photos keep exact provider hotlinks and attribution referral URLs', () => {
  const result = verifiedUnsplashPhoto(photo(), destination)!;
  assert.equal(result.src, photo().urls.regular);
  assert.equal(result.id, 'manila-photo');
  assert.equal(result.provider, 'unsplash');
  assert.equal(result.scope, 'destination');
  assert.equal(new URL(result.attribution.photographerUrl!).searchParams.get('utm_source'), 'travelmate');
  assert.equal(new URL(result.attribution.sourceUrl).searchParams.get('utm_medium'), 'referral');
});
test('nearby Metro Manila cities, wrong countries, distant coordinates, flags and unknown locations are excluded', () => {
  for (const city of ['Makati', 'Mandaluyong', 'Quezon City']) {
    assert.equal(verifiedUnsplashPhoto({ ...photo(), location: { ...photo().location, city, name: city + ', Metro Manila, Philippines' } }, destination), null);
  }
  for (const invalid of [
    { ...photo(), location: { ...photo().location, country: 'Japan' } },
    { ...photo(), location: { ...photo().location, position: { latitude: 33.6, longitude: 130.4 } } },
    { ...photo(), location: undefined },
    { ...photo(), alt_description: 'flag on a pole' },
    { ...photo(), asset_type: 'illustration' },
    { ...photo(), urls: { regular: 'https://flagcdn.com/ph.png' } },
    { ...photo(), user: undefined },
  ]) assert.equal(verifiedUnsplashPhoto(invalid, destination), null);
});
test('exact city and country in location name work when city or coordinates are omitted', () => {
  assert.ok(verifiedUnsplashPhoto({ ...photo(), location: { city: null, country: 'Philippines', name: 'Manila, Philippines' } }, destination));
  assert.equal(verifiedUnsplashPhoto({ ...photo(), location: { city: null, country: 'Philippines', name: 'Metro Manila, Philippines' } }, destination), null);
});
test('parallel cards reuse one search and cached details; only suitable photos remain in the pool', async () => {
  clearProviderCache();
  const calls: string[] = [];
  const first = photo('first'), second = photo('second'), wrong = { ...photo('wrong'), location: { ...photo().location, city: 'Makati' } };
  const fixtures = [first, second, wrong, { ...photo('flag'), alt_description: 'national flag on a pole' }];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); assert.equal(new Headers(init?.headers).get('Authorization'), 'Client-ID test-key');
    if (String(url).includes('/search/photos')) return Response.json({ results: fixtures });
    return Response.json(fixtures.find(item => String(url).endsWith('/' + item.id)));
  }) as typeof fetch;
  const results = await Promise.all([loadUnsplashDestinationPhotos(destination, fetcher, 'test-key'), loadUnsplashDestinationPhotos(destination, fetcher, 'test-key')]);
  assert.deepEqual(results[0].map(item => item.id), ['first', 'second']);
  assert.deepEqual(results[0], results[1]);
  await loadUnsplashDestinationPhotos(destination, fetcher, 'test-key');
  assert.equal(calls.filter(url => url.includes('/search/photos')).length, 1);
  assert.equal(calls.length, 4);
});
test('selection tracking uses the provider download URL once per trip/photo and never accepts a client URL', async () => {
  clearProviderCache();
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json(String(url).includes('/download') ? { url: 'unused' } : photo('tracking'));
  }) as typeof fetch;
  assert.equal(await trackUnsplashCoverSelection('user', 'trip', 'tracking', fetcher, 'key'), true);
  assert.equal(await trackUnsplashCoverSelection('user', 'trip', 'tracking', fetcher, 'key'), true);
  assert.equal(calls.filter(url => url.includes('/download')).length, 1);
  assert.ok(calls.some(url => url === photo('tracking').links.download_location));
  assert.equal(await trackUnsplashCoverSelection('user', 'trip', 'https://evil.example', fetcher, 'key'), false);
});
test('missing setup and provider failures return no pool rather than unrelated photos', async () => {
  const fetcher = (async () => { throw new Error('offline'); }) as typeof fetch;
  clearProviderCache();
  assert.deepEqual(await loadUnsplashDestinationPhotos(destination, fetcher, ''), []);
  assert.deepEqual(await loadUnsplashDestinationPhotos(destination, fetcher, 'key'), []);
});
