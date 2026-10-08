import assert from 'node:assert/strict';
import test from 'node:test';
import { reverseGeocodeLocation } from '../src/services/destination/location-search-service.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { AmadeusTravelProvider } from '../src/services/travel/amadeus-provider.ts';

for (const [latitude, longitude, name, region, country, code] of [
  [35.68, 139.69, 'Tokyo', 'Tokyo', 'Japan', 'jp'],
  [48.85, 2.35, 'Paris', 'Ile-de-France', 'France', 'fr'],
  [-33.92, 18.42, 'Cape Town', 'Western Cape', 'South Africa', 'za'],
] as const) {
  test(`reverse geocoding uses the browser coordinates for ${name}`, async () => {
    const result = await reverseGeocodeLocation(latitude, longitude, async input => {
      const url = new URL(String(input));
      assert.equal(Number(url.searchParams.get('lat')), latitude);
      assert.equal(Number(url.searchParams.get('lon')), longitude);
      return Response.json({ address: { city: name, state: region, country, country_code: code } });
    });
    assert.equal(result?.name, name); assert.equal(result?.countryCode, code.toUpperCase());
    assert.equal(result?.latitude, latitude); assert.equal(result?.longitude, longitude);
    assert.ok(result?.label.includes(country));
    assert.ok(searchDestinationIndex(`${name}, ${country}`).some(location => location.countryCode === code.toUpperCase()));
  });
}

test('reverse lookup does not substitute a default city for invalid coordinates or failed delivery', async () => {
  let calls = 0;
  assert.equal(await reverseGeocodeLocation(NaN, 1, async () => { calls++; return Response.json({}); }), null);
  assert.equal(calls, 0);
  assert.equal(await reverseGeocodeLocation(12, 13, async () => Response.json({}, { status: 503 })), null);
  assert.equal(await reverseGeocodeLocation(12, 13, async () => Response.json({ address: { country: 'France', country_code: 'fr' } })), null);
});

test('flight departure airport uses the selected origin point and prefers its country', async () => {
  let searched = false;
  const provider = new AmadeusTravelProvider('test-token', 'test', async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/locations/airports')) {
      assert.equal(url.searchParams.get('latitude'), '43.65'); assert.equal(url.searchParams.get('longitude'), '-79.38');
      return Response.json({ data: [{ iataCode: 'BUF', address: { countryCode: 'US' } }, { iataCode: 'YYZ', address: { countryCode: 'CA' } }] });
    }
    if (url.pathname.endsWith('/locations')) { assert.equal(url.searchParams.get('keyword'), 'Paris'); return Response.json({ data: [{ iataCode: 'PAR' }] }); }
    if (url.pathname.endsWith('/flight-offers')) {
      searched = true; assert.equal(url.searchParams.get('originLocationCode'), 'YYZ');
      assert.equal(url.searchParams.get('departureDate'), '2040-01-01'); assert.equal(url.searchParams.get('returnDate'), '2040-01-31');
      return Response.json({ data: [] });
    }
    throw new Error('Unexpected endpoint');
  });
  await provider.searchFlights({ origin: 'Toronto, Ontario, Canada', originCoordinates: { latitude: 43.65, longitude: -79.38 }, originCountryCode: 'CA', destination: 'Paris, France', departureDate: '2040-01-01', returnDate: '2040-01-31', adults: 1, currency: 'EUR' }, new Date().toISOString());
  assert.ok(searched);
});

test('a starting area without a domestic airport can use a provider-listed nearby airport', async () => {
  const provider = new AmadeusTravelProvider('test-token', 'test', async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/locations/airports')) return Response.json({ data: [{ iataCode: 'FCO', address: { countryCode: 'IT' } }] });
    if (url.pathname.endsWith('/locations')) return Response.json({ data: [{ iataCode: 'PAR' }] });
    assert.equal(url.searchParams.get('originLocationCode'), 'FCO'); return Response.json({ data: [] });
  });
  await provider.searchFlights({ origin: 'Vatican City', originCoordinates: { latitude: 41.9, longitude: 12.45 }, originCountryCode: 'VA', destination: 'Paris', departureDate: '2040-01-01', adults: 1, currency: 'EUR' }, new Date().toISOString());
});

test('manual international city names retain accents and country qualifications', async () => {
  const provider = new AmadeusTravelProvider('test-token', 'test', async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/locations')) {
      if (url.searchParams.get('keyword') !== 'Paris') {
        assert.equal(url.searchParams.get('keyword'), 'München'); assert.equal(url.searchParams.get('countryCode'), 'DE');
        return Response.json({ data: [{ iataCode: 'MUC' }] });
      }
      return Response.json({ data: [{ iataCode: 'PAR' }] });
    }
    assert.equal(url.searchParams.get('originLocationCode'), 'MUC'); return Response.json({ data: [] });
  });
  await provider.searchFlights({ origin: 'München, Germany', destination: 'Paris', departureDate: '2040-01-01', adults: 1, currency: 'EUR' }, new Date().toISOString());
});
