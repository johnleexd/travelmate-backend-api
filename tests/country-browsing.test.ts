import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise a fresh checkout/container with no optional SQLite catalogue installed.
process.env.GLOBAL_LOCATION_CATALOGUE_PATH = new URL('./fixtures/not-installed.sqlite', import.meta.url).pathname;
const { availableCountry, searchAvailableCountries } = await import('../src/services/destination/destination-index.ts');
const { globalCatalogueAvailable } = await import('../src/services/destination/global-catalogue.ts');
const { searchGlobalLocationsPage } = await import('../src/services/destination/global-location-search.ts');
const { selectedAreaParent, searchDestinationAreas } = await import('../src/services/destination/destination-areas.ts');
const { GET, GET_AREAS } = await import('../src/controllers/locations-controller.ts');
const { prisma } = await import('../src/lib/prisma.ts');
const { createSessionToken } = await import('../src/middlewares/auth-middleware.ts');
const offline: typeof fetch = async () => { throw new Error('Provider intentionally offline'); };
test.after(async () => prisma.$disconnect());

test('country browsing works without the optional SQLite asset and labels limited coverage', () => {
  assert.equal(globalCatalogueAvailable(), false);
  const first = searchAvailableCountries();
  assert.ok(first.total > 200); assert.equal(first.locations.length, 20);
  assert.equal(first.coverage, 'partial-provider'); assert.match(first.message, /coverage is limited/);
  const ids: number[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page = searchAvailableCountries('', offset);
    for (const country of page.locations) {
      assert.equal(country.placeType, 'Country'); assert.equal(country.scopeType, 'country');
      assert.equal(country.provider, 'geonames'); assert.ok(Number.isFinite(country.latitude));
      assert.equal(availableCountry(country.countryCode)?.id, country.id); ids.push(country.id);
    }
    offset = page.nextOffset;
  }
  assert.equal(new Set(ids).size, first.total);
});

test('country aliases and ISO codes resolve real source roots rather than namesake cities', () => {
  for (const query of ['Japan', 'JP', 'JPN', '日本']) {
    const page = searchAvailableCountries(query);
    assert.equal(page.total, 1); assert.equal(page.locations[0].id, 1861060);
  }
  assert.equal(searchAvailableCountries('nonexistent-country-fixture').total, 0);
  assert.equal(availableCountry('ZZ'), undefined);
});

test('a fallback country opens its paged cities offline and keeps the selected country scope', async () => {
  const japan = availableCountry('JP')!;
  const parent = selectedAreaParent(japan.id, japan.countryCode);
  const first = await searchDestinationAreas(parent, '', 0, offline);
  assert.ok(first.areas.length > 0); assert.ok(first.nextOffset !== null);
  assert.ok(first.areas.every(place => place.countryCode === 'JP'));
  assert.equal(first.coverage, 'partial-geographic');
  const more = await searchDestinationAreas(parent, '', first.nextOffset!, offline);
  assert.ok(more.areas.every(place => !first.areas.some(prior => prior.id === place.id)));
  const country = await searchGlobalLocationsPage('', 0, offline, 'JP');
  assert.equal(country.countryScope?.id, japan.id);
  const city = await searchGlobalLocationsPage('Tokyo', 0, offline, 'JP');
  assert.ok(city.locations.some(place => place.name === 'Tokyo'));
  assert.ok(city.locations.every(place => place.countryCode === 'JP'));
});

test('official Philippine browsing remains available when the global asset is absent', async () => {
  const country = availableCountry('PH')!;
  const page = await searchDestinationAreas(selectedAreaParent(country.id, 'PH'), '', 0, offline, true);
  assert.ok(page.areas.length > 0); assert.equal(page.coverage, 'complete-administrative');
  assert.ok(page.areas.every(place => place.countryCode === 'PH'));
});

test('the authenticated country and area APIs work without SQLite and keep validation and rate limits', async t => {
  let count = 1;
  const replace = (target: object, key: string, implementation: unknown) => {
    const original = Reflect.get(target, key); Reflect.set(target, key, implementation);
    t.after(() => Reflect.set(target, key, original));
  };
  replace(prisma.user, 'findFirst', async () => ({ id: 'offline-country-browser', role: 'traveler', accountStatus: 'active', emailVerified: true }));
  replace(prisma, '$queryRaw', async () => [{ count }]);
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(globalThis, 'fetch', offline);
  const headers = { cookie: `travelmate_session=${createSessionToken('offline-country-browser', 'traveler')}` };
  const countries = await GET(new Request('http://localhost/api/locations?kind=countries&q=Japan', { headers }));
  assert.equal(countries.status, 200);
  const country = (await countries.json()).locations[0];
  assert.equal(country.id, 1861060);
  const areas = await GET_AREAS(new Request(`http://localhost/api/locations/areas?parentId=${country.id}&countryCode=JP&hierarchy=true`, { headers }));
  assert.equal(areas.status, 200); assert.ok((await areas.json()).areas.length > 0);
  const scoped = await GET(new Request('http://localhost/api/locations?countryCode=JP&q=Tokyo', { headers }));
  assert.equal(scoped.status, 200); assert.equal((await scoped.json()).countryScope.countryCode, 'JP');
  assert.equal((await GET(new Request('http://localhost/api/locations?kind=countries'))).status, 401);
  assert.equal((await GET(new Request('http://localhost/api/locations?countryCode=ZZ&q=Tokyo', { headers }))).status, 400);
  assert.equal((await GET(new Request('http://localhost/api/locations?kind=countries&offset=-1', { headers }))).status, 400);
  count = 61;
  assert.equal((await GET(new Request('http://localhost/api/locations?kind=countries', { headers }))).status, 429);
});
