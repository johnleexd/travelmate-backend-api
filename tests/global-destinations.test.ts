import assert from 'node:assert/strict';
import test from 'node:test';
import { countries } from 'countries-list';
import { countryDestinations, countryForQuery, deduplicateDestinations, searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { searchGlobalLocations } from '../src/services/destination/global-location-search.ts';

test('every supported country has genuine indexed destinations with valid IDs and coordinates', () => {
  for (const [code, country] of Object.entries(countries)) {
    assert.equal(countryForQuery(country.name), code, country.name);
    const rows = countryDestinations(code);
    assert.ok(rows.length > 0, code);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.ok(rows.every(row => row.countryCode === code && row.country === country.name && Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 && Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180), code);
  }
});

for (const code of ['JP','PH','FR','US','BR','ZA','NZ','TH','ES','IN','EG','FJ']) {
  test(`${code} browsing offers cities, regions and natural destinations without provider calls`, async () => {
    const name = countries[code as keyof typeof countries].name;
    const rows = await searchGlobalLocations(name, async () => { throw new Error('Country browsing must be local.'); });
    assert.ok(rows.length >= 10);
    assert.ok(rows.every(row => row.countryCode === code));
    assert.ok(rows.some(row => /city|capital|locality/i.test(row.placeType)));
    assert.ok(rows.some(row => row.placeType === 'Region'));
    assert.ok(rows.some(row => ['Island','Mountain','Park or nature reserve','Lake','Beach','Canyon','Waterfall'].includes(row.placeType)));
    assert.ok(rows.every(row => row.contextLabel.includes(row.country)));
  });
}

test('city, region, tourist landmark, non-English and country-qualified searches use actual GeoNames names', () => {
  for (const [query, code] of [['Kyoto','JP'],['Cebu','PH'],['Bali, Indonesia','ID'],['Barcelona, Spain','ES'],['Mount Fuji','JP'],['東京','JP']]) {
    const rows = searchDestinationIndex(query);
    assert.ok(rows.some(row => row.countryCode === code), query);
    if (query.includes(',')) assert.ok(rows.every(row => row.countryCode === code), query);
  }
  assert.equal(searchDestinationIndex('Kyoto')[0].name, 'Kyoto');
});

test('provider results are deduplicated and explicitly filtered to the qualified country', async () => {
  let url = '';
  const rows = await searchGlobalLocations('Unlisted Coast, France', async input => {
    url = String(input);
    const place = { id: 999999991, name: 'Unlisted Coast', feature_code: 'BCH', country: 'France', country_code: 'FR', latitude: 43, longitude: 5 };
    return Response.json({ results: [place, place, { ...place, id: 999999992, country: 'Brazil', country_code: 'BR' }] });
  });
  assert.match(url, /countryCode=FR/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].countryCode, 'FR');
  assert.equal(rows[0].placeType, 'Beach');
  assert.equal(deduplicateDestinations([...rows, ...rows]).length, 1);
});

test('small countries are not padded with invented destinations', () => {
  const rows = countryDestinations('VA');
  assert.ok(rows.length > 0 && rows.length < 10);
  assert.ok(rows.every(row => row.countryCode === 'VA'));
});
