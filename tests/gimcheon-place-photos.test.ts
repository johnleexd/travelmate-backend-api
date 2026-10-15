import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { retrieveGroundedPlaces, distanceKm } from '../src/services/itinerary/grounded-places.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { buildGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
const reference = JSON.parse(readFileSync(new URL('./fixtures/gimcheon-place-photo-references.json', import.meta.url), 'utf8'));
const fetcher = (fixture = reference): typeof fetch => async input => {
  const url = new URL(String(input));
  if (url.hostname.endsWith('.wikipedia.org')) {
    const pages = url.searchParams.get('generator') === 'geosearch' ? fixture.initial : url.hostname === 'en.wikipedia.org' ? fixture.extended : fixture.local;
    return Response.json({ query: { pages: Object.fromEntries(pages.map((page: any) => [page.pageid, page])) } });
  }
  if (url.hostname === 'www.wikidata.org') return Response.json({ entities: Object.fromEntries(url.searchParams.get('ids')!.split('|').map(id => [id, fixture.entities[id] ?? {}])) });
  if (url.hostname === 'commons.wikimedia.org') return Response.json(fixture.photos);
  throw new Error('Unexpected provider');
};

test('sparse center coverage expands without accepting a neighboring-city museum or unverified locality', async () => {
  const places = await retrieveGroundedPlaces(reference.anchor, fetcher());
  const temple = places.find(place => place.placeId === 'Q625286')!;
  assert.ok(temple);
  assert.ok(distanceKm(reference.anchor, temple) > 10);
  assert.equal(temple.name, 'Jikjisa');
  assert.ok(places.some(place => place.placeId === 'Q18998999'));
  assert.ok(!places.some(place => ['Q121747212', 'Q17314918', 'Q18229777'].includes(place.placeId)));
  assert.match(temple.imageUrl!, /Jikjitempleentrance\.jpg/);
  assert.equal(temple.imageAttribution?.creator, 'Crossmr');
  const schedule = completeGroundedSchedule(reference.anchor, places, [], '2040-01-01', 7, 1, 'balanced');
  const plan = buildGroundedPlan({ destination: 'Gimcheon, South Korea', anchor: reference.anchor, startingLocation: '', startDate: '2040-01-01', endDate: '2040-01-07', budget: 1000000, currency: 'KRW', travelers: 1, partyType: 'solo', rooms: 1, places, placeDataStatus: 'live', schedule, source: 'catalog', transportation: '' });
  assert.equal(plan.days.flatMap(day => day.activities.filter(activity => activity.place)).length, 2);
  assert.equal(plan.days[0].activities.find(activity => activity.place?.placeId === temple.placeId)?.imageUrl, temple.imageUrl);
  assert.ok(plan.days.slice(2).every(day => day.planningStatus === 'incomplete' && !day.imageUrl));
});

test('Commons filename normalization maps only the exact P18 file, retaining real attribution', async () => {
  const fixture = structuredClone(reference);
  fixture.entities.Q625286.claims.P18[0].mainsnak.datavalue.value = 'Exact_temple.jpg';
  const page = Object.values(fixture.photos.query.pages)[0] as any;
  page.title = 'File:Exact temple.jpg';
  const places = await retrieveGroundedPlaces(fixture.anchor, fetcher(fixture));
  assert.ok(places.find(place => place.placeId === 'Q625286')!.imageUrl);
  assert.equal(places.find(place => place.placeId === 'Q18998999')!.imageUrl, undefined);
});

test('provider outages are reported as failures, rather than successful zero-place coverage', async () => {
  await assert.rejects(retrieveGroundedPlaces(reference.anchor, async () => new Response(null, { status: 503 })), /provider request failed/);
});

test('unsafe Commons illustrations and missing credits remain unavailable', async () => {
  const fixture = structuredClone(reference);
  const page = Object.values(fixture.photos.query.pages)[0] as any;
  page.imageinfo[0].extmetadata.ImageDescription = { value: 'AI-generated illustration of a temple' };
  const places = await retrieveGroundedPlaces(fixture.anchor, fetcher(fixture));
  assert.equal(places.find(place => place.placeId === 'Q625286')!.imageUrl, undefined);
});

test('supported Wikidata instance type preserves an attraction with no English description', async () => {
  const fixture = structuredClone(reference);
  delete fixture.entities.Q625286.descriptions.en;
  const places = await retrieveGroundedPlaces(fixture.anchor, fetcher(fixture));
  assert.match(places.find(place => place.placeId === 'Q625286')!.description, /temple/i);
});

test('an activity beyond the first 50 P18 files still receives its own photo', async () => {
  const fixture = structuredClone(reference);
  fixture.initial = Array.from({ length: 51 }, (_, index) => {
    const id = 'Q' + (9000 + index);
    const entity = structuredClone(fixture.entities.Q625286);
    entity.claims.P18[0].mainsnak.datavalue.value = `Exact temple ${index}.jpg`;
    fixture.entities[id] = entity;
    return { pageid: index, title: `Test-only temple ${index}`, coordinates: [{ lat: fixture.anchor.latitude, lon: fixture.anchor.longitude }], pageprops: { wikibase_item: id } };
  });
  let photoCalls = 0;
  const places = await retrieveGroundedPlaces(fixture.anchor, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'commons.wikimedia.org') return fetcher(fixture)(input, init);
    photoCalls++;
    const template = Object.values(fixture.photos.query.pages)[0] as any;
    return Response.json({ query: { pages: Object.fromEntries(url.searchParams.get('titles')!.split('|').map((title, index) => [index, { ...template, title, imageinfo: [{ ...template.imageinfo[0], thumburl: `https://upload.wikimedia.org/wikipedia/commons/${encodeURIComponent(title.slice(5))}` }] }])) } });
  });
  assert.equal(photoCalls, 2);
  assert.equal(places.length, 51);
  assert.match(places.find(place => place.placeId === 'Q9050')!.imageUrl!, /Exact%20temple%2050\.jpg/);
});
