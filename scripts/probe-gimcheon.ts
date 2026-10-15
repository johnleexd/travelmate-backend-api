import fs from 'node:fs';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { retrieveGroundedPlaces, entityBelongsToDestination, distanceKm } from '../src/services/itinerary/grounded-places.ts';
const directory = process.argv.includes('--membership') ? '../audit/2026-10-11/gimcheon-membership' : '../audit/2026-10-11/gimcheon-generation';
const phase = process.argv.includes('--membership') ? 'membership' : process.argv.includes('--after') ? 'after' : 'before';
fs.mkdirSync(directory, { recursive: true });
const candidates = searchDestinationIndex('Gimcheon');
console.log(JSON.stringify({ candidates }));
const candidate = candidates.find(place => place.countryCode === 'KR')!;
const anchor = { city: candidate.name, country: candidate.country, countryCode: candidate.countryCode, latitude: candidate.latitude, longitude: candidate.longitude };
const entries: any[] = [];
const entities: Record<string, any> = {};
const pages: any[] = [];
const fetcher: typeof fetch = async (input, init) => {
  const url = String(input), started = Date.now();
  try {
    const response = await fetch(input, init);
    const payload = await response.clone().text();
    const index = entries.length;
    entries.push({ url, status: response.status, durationMs: Date.now() - started, bytes: payload.length });
    fs.writeFileSync(`${directory}/${phase}-response-${index}.json`, payload);
    try { const data = JSON.parse(payload); if (data.entities) Object.assign(entities, data.entities); if (url.includes('en.wikipedia.org')) pages.push(...Object.values(data.query?.pages ?? {})); } catch {}
    console.log(JSON.stringify(entries.at(-1)));
    return response;
  } catch (error) { entries.push({ url, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }); throw error; }
};
try {
  if (process.argv.includes('--coverage')) {
    for (const [label, language, lat, lon] of [['ko-center', 'ko', anchor.latitude, anchor.longitude], ['en-west', 'en', anchor.latitude, anchor.longitude - 0.17], ['ko-west', 'ko', anchor.latitude, anchor.longitude - 0.17], ['en-south', 'en', anchor.latitude - 0.15, anchor.longitude]] as const) {
      const url = `https://${language}.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', action: 'query', generator: 'geosearch', ggscoord: `${lat}|${lon}`, ggsradius: '10000', ggslimit: '500', ggsnamespace: '0', prop: 'coordinates|pageprops', coprimary: 'primary', colimit: 'max', ppprop: 'wikibase_item' })}`;
      const response = await fetch(url, { headers: { 'User-Agent': 'TravelMate/1.0 (destination reference lookup)' } });
      const data = await response.json();
      fs.writeFileSync(`${directory}/coverage-${label}.json`, JSON.stringify(data, null, 2));
      console.log(JSON.stringify({ label, status: response.status, pages: Object.values(data.query?.pages ?? {}).map((page: any) => ({ title: page.title, id: page.pageprops?.wikibase_item, point: page.coordinates?.[0] })) }));
    }
    process.exit(0);
  }
  if (process.argv.includes('--expanded-coverage')) {
    for (const language of ['en', 'ko']) {
      const params = new URLSearchParams({ format: 'json', action: 'query', generator: 'search', gsrsearch: `nearcoord:30km,${anchor.latitude},${anchor.longitude}`, gsrlimit: '100', gsrnamespace: '0', prop: 'coordinates|pageprops', coprimary: 'primary', colimit: 'max', ppprop: 'wikibase_item' });
      const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${params}`, { headers: { 'User-Agent': 'TravelMate/1.0 (destination reference lookup)' } });
      const data = await response.json();
      fs.writeFileSync(`${directory}/coverage-expanded-${language}.json`, JSON.stringify(data, null, 2));
      console.log(JSON.stringify({ language, status: response.status, count: Object.keys(data.query?.pages ?? {}).length, pages: Object.values(data.query?.pages ?? {}).map((page: any) => ({ title: page.title, id: page.pageprops?.wikibase_item })) }));
    }
    process.exit(0);
  }
  const places = await retrieveGroundedPlaces(anchor, fetcher);
  const checks = pages.map(page => {
    const id = page.pageprops?.wikibase_item, point = page.coordinates?.[0], entity = entities[id];
    return { title: page.title, id, coordinate: point, distanceKm: point ? distanceKm(anchor, { latitude: point.lat, longitude: point.lon }) : null,
      destinationMatch: id ? entityBelongsToDestination(id, entities, anchor) : false, description: entity?.descriptions?.en?.value,
      p31: entity?.claims?.P31?.map((claim: any) => claim.mainsnak?.datavalue?.value?.id), p18: entity?.claims?.P18?.map((claim: any) => claim.mainsnak?.datavalue?.value), p131: entity?.claims?.P131?.map((claim: any) => claim.mainsnak?.datavalue?.value?.id) };
  });
  fs.writeFileSync(`${directory}/${phase}-evidence.json`, JSON.stringify({ anchor, requests: entries, checks, places }, null, 2));
  console.log(JSON.stringify({ anchor, pages: pages.length, checks, accepted: places.length, photos: places.filter(place => place.imageUrl).length }));
} catch (error) { fs.writeFileSync(`${directory}/${phase}-evidence.json`, JSON.stringify({ anchor, requests: entries, error: String(error) }, null, 2)); console.log(JSON.stringify({ failure: String(error) })); process.exitCode = 1; }
