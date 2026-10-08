import assert from 'node:assert/strict';
import test from 'node:test';
import { attachAccommodationPhotos } from '../src/services/destination/accommodation-photos.ts';
import { normalizeAccommodationPlaces } from '../src/services/destination/accommodation-places.ts';

const row = (id: number, tags: Record<string, string> = {}) => ({ type: 'node', id, lat: 48.86, lon: 2.35, tags: { name: 'Exact Property ' + id, tourism: 'hotel', ...tags } });
const location = { destination: 'Paris', latitude: 48.86, longitude: 2.35 };
function photo(title: string, patch: Record<string, unknown> = {}) {
  return { pageid: 123, title, imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/property.jpg', extmetadata: { Artist: { value: '<b>Property photographer</b>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } }, ...patch }] };
}
test('exact mapped property files get attributed photos, never a name search or arbitrary URL fetch', async () => {
  const rows = normalizeAccommodationPlaces({ elements: [row(1, { wikimedia_commons: 'File:Exact_Property.jpg' }), row(2)] }, location);
  let calls = 0;
  const result = await attachAccommodationPhotos(rows, async input => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.hostname, 'commons.wikimedia.org');
    assert.equal(url.searchParams.get('titles'), 'File:Exact Property.jpg');
    assert.equal(url.searchParams.has('generator'), false); assert.equal(url.searchParams.has('gsrsearch'), false);
    return Response.json({ query: { pages: { 123: photo('File:Exact Property.jpg') } } });
  });
  assert.equal(calls, 1); assert.ok(result[0].imageUrl);
  assert.equal(result[0].imageAttribution?.creator, 'Property photographer');
  assert.equal(result[0].imageAttribution?.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(result[1].imageUrl, undefined); assert.equal(result[1].address, 'Address not supplied');
  assert.equal('commonsFile' in result[0], false);
});
test('unknown licenses, missing creators, external images, illustrations and provider failures stay placeholders', async () => {
  const rows = normalizeAccommodationPlaces({ elements: [row(1, { wikimedia_commons: 'File:Exact Property.jpg' })] }, location);
  for (const patch of [
    { extmetadata: { Artist: { value: 'Creator' }, LicenseShortName: { value: 'All rights reserved' } } },
    { extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } },
    { thumburl: 'https://unverified.example.test/property.jpg' },
    { mime: 'image/svg+xml' },
    { extmetadata: { Artist: { value: 'Creator' }, LicenseShortName: { value: 'CC BY 4.0' }, ImageDescription: { value: 'AI-generated illustration' } } },
  ]) {
    const result = await attachAccommodationPhotos(rows, async () => Response.json({ query: { pages: { 123: photo('File:Exact Property.jpg', patch) } } }));
    assert.equal(result[0].imageUrl, undefined);
  }
  assert.equal((await attachAccommodationPhotos(rows, async () => Response.json({}, { status: 503 })))[0].imageUrl, undefined);
});
test('Wikidata photos use the property-linked entity and require matching name, address and physical coordinates', async () => {
  const rows = normalizeAccommodationPlaces({ elements: [row(1, { wikidata: 'Q123', 'addr:city': 'Paris' }), row(2, { wikidata: 'Q456' }), row(3, { wikidata: 'Q789', 'addr:city': 'Paris' })] }, location);
  const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
  const result = await attachAccommodationPhotos(rows, async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: {
      Q123: { labels: { en: { value: 'Exact Property 1' } }, claims: { P6375: claim({ text: 'Paris' }), P18: claim('Exact Property.jpg'), P625: claim({ latitude: 48.86, longitude: 2.35 }) } },
      Q789: { labels: { en: { value: 'Unrelated property' } }, claims: { P6375: claim({ text: 'Different Street' }), P18: claim('Unrelated Property.jpg'), P625: claim({ latitude: 48.86, longitude: 2.35 }) } },
      Q456: { claims: { P18: claim('Unrelated Property.jpg'), P625: claim({ latitude: 35, longitude: 139 }) } },
    } });
    assert.equal(url.searchParams.get('titles'), 'File:Exact Property.jpg');
    return Response.json({ query: { pages: { 123: photo('File:Exact Property.jpg') } } });
  });
  assert.ok(result[0].imageUrl); assert.equal(result[1].imageUrl, undefined); assert.equal(result[2].imageUrl, undefined);
});
