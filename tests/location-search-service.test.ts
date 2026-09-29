import assert from 'node:assert/strict';
import test from 'node:test';
import { capitalForCountryCode, enrichCountrySuggestions, rankLocationSuggestions, reverseGeocodeLocation, type GeocodingPlace } from '../src/services/destination/location-search-service.ts';

let nextId = 1;
function place(name: string, featureCode: string, country: string, countryCode: string, population?: number, admin1?: string): GeocodingPlace {
  return { id: nextId++, name, feature_code: featureCode, country, country_code: countryCode, population, admin1, latitude: 1, longitude: 1 };
}

for (const [query, country, code] of [
  ['Japan', 'Japan', 'JP'],
  ['Philippines', 'Philippines', 'PH'],
  ['Georgia', 'Georgia', 'GE'],
  ['Thailand', 'Thailand', 'TH'],
  ['United States', 'United States', 'US'],
] as const) {
  test(`${query} resolves to the country and suppresses unrelated same-name localities`, () => {
    const results = rankLocationSuggestions(query, [
      place(query, 'PPL', 'Unrelated country', 'ZZ'),
      place(query, 'PCLI', country, code, 5_000_000),
      place(`${query} Mountain`, 'MT', 'Elsewhere', 'XY'),
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.countryCode, code);
    assert.equal(results[0]?.contextLabel, `Country • ${country}`);
  });
}

for (const [query, expectedCountry, featureCode, population] of [
  ['Tokyo', 'Japan', 'PPLC', 9_733_276],
  ['Cebu City', 'Philippines', 'PPLA', 965_332],
  ['London', 'United Kingdom', 'PPLC', 8_961_989],
  ['Paris', 'France', 'PPLC', 2_138_551],
  ['New York', 'United States', 'PPL', 8_804_190],
  ['Cambridge', 'United Kingdom', 'PPLA2', 145_674],
  ['Victoria', 'Canada', 'PPLA', 289_625],
] as const) {
  test(`${query} ranks the major destination above obscure same-name places`, () => {
    const results = rankLocationSuggestions(query, [
      place(query, 'PPL', 'Unrelated country', 'ZZ'),
      place(query, featureCode, expectedCountry, 'AA', population, 'Primary region'),
      place(`${query} Dam`, 'DAM', expectedCountry, 'AA'),
    ]);
    assert.equal(results[0]?.country, expectedCountry);
    assert.equal(results.some((result) => result.country === 'Unrelated country'), false);
    assert.match(results[0]?.contextLabel || '', / • /);
  });
}

test('Cebu keeps the relevant island and Cebu City while suppressing unrelated localities', () => {
  const results = rankLocationSuggestions('Cebu', [
    place('Cebu', 'PPL', 'Dominican Republic', 'DO'),
    place('Cebu', 'ISL', 'Philippines', 'PH', 4_164_535, 'Central Visayas'),
    place('Cebu City', 'PPLA', 'Philippines', 'PH', 965_332, 'Central Visayas'),
    place('Cebu', 'PPL', 'China', 'CN'),
    place('Cebuano', 'PPL', 'Philippines', 'PH', 5_430, 'Soccsksargen'),
  ]);
  assert.deepEqual(results.map((result) => result.name), ['Cebu', 'Cebu City']);
  assert.ok(results.every((result) => result.countryCode === 'PH'));
});

test('a strong exact city match suppresses low-prominence prefix noise', () => {
  const results = rankLocationSuggestions('London', [
    place('London', 'PPLC', 'United Kingdom', 'GB', 8_961_989, 'England'),
    place('London', 'PPL', 'Canada', 'CA', 422_324, 'Ontario'),
    place('Londonderry', 'PPLA2', 'United Kingdom', 'GB', 83_652, 'Northern Ireland'),
    place('Londontowne', 'PPL', 'United States', 'US', 8_018, 'Maryland'),
  ]);
  assert.deepEqual(results.map((result) => result.label), ['London, England, United Kingdom', 'London, Ontario, Canada']);
});

test('ambiguous major cities remain distinguishable instead of being blindly deduplicated', () => {
  const results = rankLocationSuggestions('Springfield', [
    place('Springfield', 'PPLA2', 'United States', 'US', 170_188, 'Missouri'),
    place('Springfield', 'PPLA', 'United States', 'US', 114_394, 'Illinois'),
    place('Springfield', 'PPL', 'United States', 'US', 154_341, 'Massachusetts'),
    place('Springfield', 'PPL', 'Another country', 'ZZ'),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(new Set(results.map((result) => result.region)), new Set(['Missouri', 'Illinois', 'Massachusetts']));
});

test('country codes resolve capitals globally from structured country data', () => {
  assert.equal(capitalForCountryCode('JP'), 'Tokyo');
  assert.equal(capitalForCountryCode('PH'), 'Manila');
  assert.equal(capitalForCountryCode('GE'), 'Tbilisi');
  assert.equal(capitalForCountryCode('FR'), 'Paris');
  assert.equal(capitalForCountryCode('ZZ'), '');
});

test('exact country suggestions are enriched with their geocoded capital', async () => {
  const country = rankLocationSuggestions('Japan', [place('Japan', 'PCLI', 'Japan', 'JP', 126_529_100)]);
  let requestedUrl = '';
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    requestedUrl = String(input);
    return Response.json({ results: [place('Tokyo', 'PPLC', 'Japan', 'JP', 9_733_276, 'Tokyo')] });
  };

  const results = await enrichCountrySuggestions(country, fakeFetch);
  assert.deepEqual(results.map((result) => result.name), ['Japan', 'Tokyo']);
  assert.match(requestedUrl, /name=Tokyo/);
  assert.match(requestedUrl, /countryCode=JP/);
});

test('capital enrichment degrades gracefully and does not affect city searches', async () => {
  const city = rankLocationSuggestions('Tokyo', [place('Tokyo', 'PPLC', 'Japan', 'JP', 9_733_276, 'Tokyo')]);
  let calls = 0;
  const results = await enrichCountrySuggestions(city, async () => {
    calls += 1;
    throw new Error('Provider unavailable');
  });
  assert.deepEqual(results, city);
  assert.equal(calls, 0);
});

test('reverse geocoding turns a permissioned coordinate into a current-location suggestion', async () => {
  let requestedUrl = '';
  const location = await reverseGeocodeLocation(10.3157, 123.8854, async (input) => {
    requestedUrl = String(input);
    return Response.json({ address: { city: 'Cebu City', state: 'Central Visayas', country: 'Philippines', country_code: 'ph' } });
  });
  assert.equal(location?.label, 'Cebu City, Central Visayas, Philippines');
  assert.equal(location?.placeType, 'Current location');
  assert.equal(location?.countryCode, 'PH');
  assert.match(requestedUrl, /lat=10\.315700/);
  assert.match(requestedUrl, /lon=123\.885400/);
});
