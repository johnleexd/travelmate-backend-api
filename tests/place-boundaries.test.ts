import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { retrieveGroundedPlaces, distanceKm, placeMatchesAnchor } from '../src/services/itinerary/grounded-places.ts';
import { loadPlaceBoundary } from '../src/services/itinerary/place-boundaries.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { buildGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { verifiedSavedActivityPlace } from '../src/services/navigation/trip-map-service.ts';
const reference = JSON.parse(readFileSync(new URL('./fixtures/gimcheon-place-photo-references.json', import.meta.url), 'utf8'));
const boundary = JSON.parse(readFileSync(new URL('./fixtures/gimcheon-boundary.json', import.meta.url), 'utf8'));
const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];
const gumiBoundary = { ...boundary[0], osm_id: 123, name: 'Gumi', address: { country_code: 'kr' }, namedetails: { 'name:en': 'Gumi' }, extratags: { wikidata: 'Q42073' }, geojson: { type: 'Polygon', coordinates: [[[128.3,36.05],[128.4,36.05],[128.4,36.25],[128.3,36.25],[128.3,36.05]]] } }; // Test-only neighboring polygon.
function fixtureFetcher(fixture = reference): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    if (url.hostname === 'nominatim.openstreetmap.org') return Response.json(url.searchParams.get('q')?.startsWith('Gumi,') ? [gumiBoundary] : boundary);
    if (url.hostname.endsWith('.wikipedia.org')) {
      const pages = url.searchParams.get('generator') === 'geosearch' ? fixture.initial : url.hostname === 'en.wikipedia.org' ? fixture.extended : fixture.local;
      return Response.json({ query: { pages: Object.fromEntries(pages.map((page: any) => [page.pageid, page])) } });
    }
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: Object.fromEntries(url.searchParams.get('ids')!.split('|').map(id => [id, fixture.entities[id] ?? {}])) });
    if (url.hostname === 'commons.wikimedia.org') return Response.json(fixture.photos);
    throw new Error('Unexpected provider');
  };
}

test('actual Gimcheon boundary recovers a Confucian heritage site with no administrative parent', async () => {
  clearProviderCache();
  const places = await retrieveGroundedPlaces(reference.anchor, fixtureFetcher());
  const school = places.find(place => place.placeId === 'Q18229777')!;
  assert.ok(school);
  assert.equal(school.locationScope, 'city');
  assert.equal(school.city, 'Gimcheon');
  assert.equal(school.membershipSourceUrl, 'https://www.openstreetmap.org/relation/7715625');
  assert.ok(!places.some(place => place.placeId === 'Q121747212')); // Outside this city's polygon, with no neighboring boundary evidence.
  assert.ok(!places.some(place => place.placeId === 'Q17314918')); // Generic heritage metadata alone does not establish a separate visit site.
});

test('missing country and city fields can use a verified neighboring boundary without pretending to be city-local', async () => {
  clearProviderCache();
  const fixture = structuredClone(reference);
  const source = fixture.extended.find((page: any) => page.pageprops?.wikibase_item === 'Q121747212');
  fixture.entities.Q42073 = { labels: { en: { value: 'Gumi' } }, descriptions: { en: { value: 'city in North Gyeongsang Province, South Korea' } }, claims: { P625: claim({ latitude: 36.21, longitude: 128.35444 }), P17: claim({ id: 'Q884' }) } };
  fixture.entities.Q900000 = { labels: { en: { value: 'Test-only Gumi museum' } }, descriptions: { en: { value: 'museum' } }, claims: { P131: claim({ id: 'Q42073' }), P17: claim({ id: 'Q884' }) } };
  fixture.extended.push({ ...source, pageid: 900000, pageprops: { wikibase_item: 'Q900000' } });
  const places = await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture));
  const museum = places.find(place => place.placeId === 'Q121747212')!;
  assert.equal(museum.city, 'Gumi');
  assert.equal(museum.locationScope, 'nearby');
  assert.equal(museum.selectedCity, 'Gimcheon');
  assert.ok(Math.abs(museum.distanceFromDestinationKm! - distanceKm(fixture.anchor, museum)) < 0.01);
  assert.equal(placeMatchesAnchor(museum, fixture.anchor), true);
  assert.equal(placeMatchesAnchor({ ...museum, selectedCity: 'Seoul' }, fixture.anchor), false);
  const { description, imageUrl, imageAttribution, openingWindows, ...evidence } = museum;
  assert.ok(verifiedSavedActivityPlace({ place: evidence }, fixture.anchor));
});

test('wrong country and conflicting coordinate evidence remain excluded inside a city boundary', async () => {
  clearProviderCache();
  const fixture = structuredClone(reference);
  fixture.entities.Q18229777.claims.P17 = claim({ id: 'Q999999' });
  fixture.entities.Q999999 = { claims: { P297: claim('JP') } };
  fixture.entities.Q18998999.claims.P625 = claim({ latitude: 35, longitude: 130, globe: 'http://www.wikidata.org/entity/Q2' });
  const places = await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture));
  assert.ok(!places.some(place => ['Q18229777','Q18998999'].includes(place.placeId)));
});

test('precise cross-source coordinates and country can verify nearby scope while leaving municipality unconfirmed', async () => {
  const fixture = structuredClone(reference);
  const page = fixture.extended.find((page: any) => page.pageprops?.wikibase_item === 'Q121747212');
  fixture.entities.Q121747212.claims.P17 = claim({ id: 'Q884' });
  fixture.entities.Q121747212.claims.P625 = claim({ latitude: page.coordinates[0].lat, longitude: page.coordinates[0].lon, precision: 0.000001, globe: 'http://www.wikidata.org/entity/Q2' });
  clearProviderCache();
  const place = (await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture))).find(place => place.placeId === 'Q121747212')!;
  assert.equal(place.locationScope, 'nearby');
  assert.equal(place.city, 'Locality unconfirmed');
  assert.equal(place.membershipSourceUrl, 'https://www.openstreetmap.org/relation/7715625');
  assert.equal(placeMatchesAnchor(place, fixture.anchor), true);
  fixture.entities.Q121747212.claims.P625[0].mainsnak.datavalue.value.precision = 1;
  clearProviderCache();
  assert.ok(!(await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture))).some(place => place.placeId === 'Q121747212'));
});

test('exact mapped venue corroboration resolves erroneous Wikidata coordinates without accepting an unrelated venue', async () => {
  const fixture = structuredClone(reference);
  const page = fixture.extended.find((page: any) => page.pageprops?.wikibase_item === 'Q121747212');
  fixture.entities.Q121747212.claims.P625 = claim({ latitude: page.coordinates[0].lat - 1, longitude: page.coordinates[0].lon, precision: 0.000001, globe: 'http://www.wikidata.org/entity/Q2' });
  const mapped = { osm_type: 'way', osm_id: 456, name: 'Park Chung-hee Presidential Museum', lat: String(page.coordinates[0].lat), lon: String(page.coordinates[0].lon), extratags: { wikidata: 'Q121747212' }, address: { city: 'Gumi', country_code: 'kr' } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'nominatim.openstreetmap.org' && url.searchParams.get('q')?.startsWith('Park Chung-hee')) return Response.json([mapped]);
    return fixtureFetcher(fixture)(input, init);
  };
  clearProviderCache();
  const place = (await retrieveGroundedPlaces(fixture.anchor, fetcher)).find(place => place.placeId === 'Q121747212')!;
  assert.equal(place.city, 'Gumi');
  assert.equal(place.latitude, page.coordinates[0].lat);
  assert.equal(place.coordinateSourceUrl, 'https://www.openstreetmap.org/way/456');
  mapped.extratags.wikidata = 'Q999999';
  clearProviderCache();
  assert.ok(!(await retrieveGroundedPlaces(fixture.anchor, fetcher)).some(place => place.placeId === 'Q121747212'));
});

test('proximity does not merge an independent attraction; an explicit parent reference does', async () => {
  const fixture = structuredClone(reference);
  const temple = fixture.extended.find((page: any) => page.pageprops?.wikibase_item === 'Q625286');
  const point = temple.coordinates[0];
  fixture.entities.Q900002 = structuredClone(fixture.entities.Q18998999);
  fixture.entities.Q900002.labels = { en: { value: 'Test-only nearby statue' } };
  fixture.extended.push({ pageid: 900002, title: 'Test-only nearby statue', coordinates: [{ lat: point.lat + 0.0001, lon: point.lon }], pageprops: { wikibase_item: 'Q900002' } });
  clearProviderCache();
  assert.ok((await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture))).some(place => place.placeId === 'Q900002'));
  fixture.entities.Q900002.claims.P361 = claim({ id: 'Q625286' });
  clearProviderCache();
  assert.ok(!(await retrieveGroundedPlaces(fixture.anchor, fixtureFetcher(fixture))).some(place => place.placeId === 'Q900002'));
});

test('ambiguous, wrong-name, or wrong-country boundaries cannot validate a place', async () => {
  for (const payload of [[boundary[0], boundary[0]], [{ ...boundary[0], address: { country_code: 'jp' } }], [{ ...boundary[0], name: 'Unrelated', namedetails: {} }]]) {
    clearProviderCache();
    assert.equal(await loadPlaceBoundary(reference.anchor, async () => Response.json(payload)), null);
  }
  clearProviderCache();
  assert.equal(await loadPlaceBoundary(reference.anchor, async () => Response.json(boundary), 'Q999999'), null);
});

test('the same boundary validation supports selected localities across countries', async () => {
  for (const anchor of [{ city: 'Hamburg', country: 'Germany', countryCode: 'DE', latitude: 53.55, longitude: 10 }, { city: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.68, longitude: 139.69 }]) {
    clearProviderCache();
    const payload = [{ ...gumiBoundary, name: anchor.city, address: { country_code: anchor.countryCode.toLowerCase() }, namedetails: { 'name:en': anchor.city }, extratags: {}, geojson: { type: 'Polygon', coordinates: [[[anchor.longitude - 0.1, anchor.latitude - 0.1], [anchor.longitude + 0.1, anchor.latitude - 0.1], [anchor.longitude + 0.1, anchor.latitude + 0.1], [anchor.longitude - 0.1, anchor.latitude + 0.1], [anchor.longitude - 0.1, anchor.latitude - 0.1]]] } }];
    const result = await loadPlaceBoundary(anchor, async () => Response.json(payload));
    assert.equal(result?.city, anchor.city);
    assert.equal(result?.countryCode, anchor.countryCode);
  }
});

test('nearby visits reserve outbound and return travel, survive save validation, and display the real locality', () => {
  const place = { provider: 'wikidata' as const, placeId: 'Q900001', name: 'Test-only nearby temple', description: 'Buddhist temple', city: 'Neighboring town', country: reference.anchor.country, countryCode: 'KR', latitude: reference.anchor.latitude, longitude: reference.anchor.longitude + 0.13, sourceUrl: 'https://www.wikidata.org/wiki/Q900001', fetchedAt: new Date().toISOString(), openingHours: 'Opening hours need confirmation', address: 'Not available', locationScope: 'nearby' as const, selectedCity: 'Gimcheon', distanceFromDestinationKm: 0, membershipSourceUrl: 'https://www.openstreetmap.org/relation/123' };
  place.distanceFromDestinationKm = Math.round(distanceKm(place, reference.anchor) * 100) / 100;
  const schedule = completeGroundedSchedule(reference.anchor, [place], [], '2040-01-01', 1, 1, 'balanced');
  const visit = schedule[0].visits[0];
  const transfer = Math.ceil(distanceKm(place, reference.anchor) / 4 * 60) + 15;
  assert.ok(visit.startMinutes >= 540 + transfer);
  assert.ok(visit.startMinutes + visit.durationMinutes + transfer <= 1080);
  const plan = buildGroundedPlan({ destination: 'Gimcheon, South Korea', anchor: reference.anchor, startingLocation: '', startDate: '2040-01-01', endDate: '2040-01-01', budget: 1000000, currency: 'KRW', travelers: 1, partyType: 'solo', rooms: 1, places: [place], placeDataStatus: 'live', schedule, source: 'catalog', transportation: '' });
  const parsed = parseSavedItinerary(plan, { days: 1, budget: 1000000, currency: 'KRW', travelers: 1, partyType: 'solo', startDate: '2040-01-01', destination: plan.destination });
  const activity = parsed.days[0].activities.find(activity => activity.place)!;
  assert.equal(activity.place!.city, 'Neighboring town');
  assert.match(activity.description, /Nearby attraction.*Neighboring town, outside Gimcheon/);
  assert.match(activity.description, /route confirmation.*Return time is reserved/);
  const distant = { ...place, longitude: reference.anchor.longitude + 0.3 };
  distant.distanceFromDestinationKm = Math.round(distanceKm(distant, reference.anchor) * 100) / 100;
  assert.equal(completeGroundedSchedule(reference.anchor, [distant], [], '2040-01-01', 1, 1, 'balanced')[0].visits.length, 0);
});
