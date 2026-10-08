import { withProviderCache } from '../cache/provider-cache.ts';
import type { DestinationAnchor, PlaceEvidence } from './grounding-schema.ts';
import { destinationAnchorSchema, GroundingInputError } from './grounding-schema.ts';
import { searchGlobalLocations } from '../destination/global-location-search.ts';
import { resolveDestination } from '../destination/location-resolution.ts';

type Claim = { rank?: string; mainsnak?: { datavalue?: { value?: any } }; qualifiers?: Record<string, Array<{ datavalue?: { value?: any } }>> };
type Entity = { labels?: Record<string, { value: string }>; aliases?: Record<string, Array<{ value: string }>>; descriptions?: Record<string, { value: string }>; claims?: Record<string, Claim[]> };
export interface GroundedPlace extends PlaceEvidence {
  description: string;
  imageUrl?: string;
  imageAttribution?: { creator: string; license: string; licenseUrl?: string; sourceUrl: string };
  openingWindows?: Array<{ weekdays: number[]; startMinutes: number; endMinutes: number }>;
}
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const values = (entity: Entity | undefined, property: string): any[] => (entity?.claims?.[property] ?? []).filter(claim => claim.rank !== 'deprecated').flatMap(claim => claim.mainsnak?.datavalue ? [claim.mainsnak.datavalue.value] : []);
const ids = (entity: Entity | undefined, property: string): string[] => values(entity, property).flatMap(value => /^Q\d+$/.test(value?.id) ? [value.id] : []);
const strip = (value: string = '') => value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

export function openingDetails(entity: Entity, entities: Record<string, Entity>) {
  const windows: NonNullable<GroundedPlace['openingWindows']> = [];
  const descriptions: string[] = [];
  const label = (id: unknown) => typeof id === 'string' ? entities[id]?.labels?.en?.value ?? '' : '';
  const minutes = (value: string) => {
    const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return undefined;
    let hour = Number(match[1]); const minute = Number(match[2] ?? 0);
    if (match[3]) { if (hour < 1 || hour > 12) return undefined; hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0); }
    return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
  };
  for (const claim of (entity.claims?.P3025 ?? []).filter(value => value.rank !== 'deprecated')) {
    const days = label(claim.mainsnak?.datavalue?.value?.id);
    const start = label(claim.qualifiers?.P8626?.[0]?.datavalue?.value?.id);
    const end = label(claim.qualifiers?.P8627?.[0]?.datavalue?.value?.id);
    if (days) descriptions.push(`${days}: ${start || 'opening time not available'}–${end || 'closing time not available'}`);
    const weekdays = /^all days of the week$|^every day$/i.test(days) ? [0,1,2,3,4,5,6]
      : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].flatMap((name, index) => days.toLowerCase() === name.toLowerCase() ? [index] : []);
    const startMinutes = minutes(start), endMinutes = minutes(end);
    // Seasonal/holiday/part-specific schedules require confirmation, not guessed interpretation.
    if (weekdays.length && startMinutes !== undefined && endMinutes !== undefined && endMinutes > startMinutes
      && Object.keys(claim.qualifiers ?? {}).every(key => ['P8626','P8627'].includes(key))) windows.push({ weekdays, startMinutes, endMinutes });
  }
  const address = values(entity, 'P6375').find(value => value?.language === 'en')?.text ?? values(entity, 'P6375').find(value => typeof value?.text === 'string')?.text;
  return { openingHours: descriptions.length ? `${descriptions.join('; ')} (Wikidata reference; seasonal/holiday exceptions and current hours need confirmation)`.slice(0, 1000) : 'Not available; confirm with the venue', address: typeof address === 'string' ? address.slice(0, 1000) : 'Not available', openingWindows: windows.length ? windows : undefined };
}

export async function validateDestinationAnchor(destination: string, value: unknown, latitude: unknown, longitude: unknown, fetcher: typeof fetch = fetch) {
  const parsed = destinationAnchorSchema.safeParse(value);
  if (!parsed.success) throw new GroundingInputError('Select a destination city/locality with country and coordinates before generating.');
  const anchor = parsed.data;
  if (latitude !== anchor.latitude || longitude !== anchor.longitude) throw new GroundingInputError('Destination coordinates do not match the selected place.');
  if (!normalized(destination).startsWith(normalized(anchor.city))) throw new GroundingInputError('Destination text does not match the selected city.');
  let matches = await searchGlobalLocations(`${anchor.city}, ${anchor.country}`, fetcher);
  let match = matches.find(place => normalized(place.name) === normalized(anchor.city) && place.countryCode === anchor.countryCode && distanceKm(place, anchor) < 0.5);
  if (!match) {
    matches = (await resolveDestination(destination, fetcher)).candidates;
    match = matches.find(place => normalized(place.name) === normalized(anchor.city) && place.countryCode === anchor.countryCode && distanceKm(place, anchor) < 0.5);
  }
  if (!match || match.placeType === 'Country') throw new GroundingInputError('Choose a specific city/locality from destination search; its country and coordinates could not be validated.');
  return { ...anchor, city: match.name, country: match.country };
}

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Geographic proximity alone never proves city/country identity. */
export function entityBelongsToDestination(id: string, entities: Record<string, Entity>, anchor: DestinationAnchor): boolean {
  let frontier = [id];
  const visited = new Set<string>();
  let cityMatch = false, countryMatch = false, conflictingCountry = false;
  for (let depth = 0; depth <= 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      if (visited.has(current)) continue;
      visited.add(current);
      const entity = entities[current];
      const names = [entity?.labels?.en?.value ?? '', ...(entity?.aliases?.en ?? []).map(alias => alias.value)];
      if (depth > 0 && names.some(name => normalized(name) === normalized(anchor.city))) cityMatch = true;
      for (const country of ids(entity, 'P17')) {
        const codes = values(entities[country], 'P297');
        if (codes.includes(anchor.countryCode)) countryMatch = true;
        else if (codes.length) conflictingCountry = true;
      }
      next.push(...ids(entity, 'P131'));
    }
    frontier = next;
  }
  return cityMatch && countryMatch && !conflictingCountry;
}

export async function retrieveGroundedPlaces(anchor: DestinationAnchor, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<GroundedPlace[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const json = async (host: string, parameters: Record<string, string>) => {
    const response = await fetcher(`${host}/w/api.php?${new URLSearchParams({ format: 'json', ...parameters })}`, {
      headers: { 'User-Agent': 'TravelMate/1.0 (destination reference lookup)', 'Api-User-Agent': 'TravelMate/1.0' }, signal: requestSignal,
    });
    if (!response.ok) throw new Error('Destination reference provider unavailable.');
    const result = await response.json() as any;
    if (result.error) throw new Error('Destination reference provider rejected the lookup.');
    return result;
  };
  const nearby = await json('https://en.wikipedia.org', {
    action: 'query', generator: 'geosearch', ggscoord: `${anchor.latitude}|${anchor.longitude}`, ggsradius: '5000', ggslimit: '50', ggsnamespace: '0',
    prop: 'coordinates|pageprops', coprimary: 'primary', ppprop: 'wikibase_item',
  });
  const pages = Object.values(nearby.query?.pages ?? {}) as Array<{ title: string; pageid: number; coordinates?: Array<{ lat: number; lon: number }>; pageprops?: { wikibase_item?: string } }>;
  const entities: Record<string, Entity> = {};
  let frontier = pages.flatMap(page => /^Q\d+$/.test(page.pageprops?.wikibase_item ?? '') ? [page.pageprops!.wikibase_item!] : []);
  for (let depth = 0; depth <= 5 && frontier.length; depth++) {
    const missing = [...new Set(frontier)].filter(id => !entities[id]).slice(0, 150);
    for (let offset = 0; offset < missing.length; offset += 50) {
      const data = await json('https://www.wikidata.org', { action: 'wbgetentities', ids: missing.slice(offset, offset + 50).join('|'), props: 'labels|aliases|descriptions|claims', languages: 'en' });
      Object.assign(entities, data.entities ?? {});
    }
    frontier = missing.flatMap(id => [...ids(entities[id], 'P131'), ...ids(entities[id], 'P17'), ...ids(entities[id], 'P3025'), ...(entities[id]?.claims?.P3025 ?? []).flatMap(claim => Object.values(claim.qualifiers ?? {}).flatMap(snaks => snaks.flatMap(snak => /^Q\d+$/.test(snak.datavalue?.value?.id) ? [snak.datavalue!.value.id] : [])))]);
  }
  const fetchedAt = new Date().toISOString();
  const places = pages.flatMap(page => {
    const id = page.pageprops?.wikibase_item;
    const point = page.coordinates?.[0];
    if (!id || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [];
    const coordinate = { latitude: point.lat, longitude: point.lon };
    const entity = entities[id];
    const description = entity?.descriptions?.en?.value ?? '';
    if (!entityBelongsToDestination(id, entities, anchor) || distanceKm(anchor, coordinate) > 5
      || !/museum|garden|park|temple|church|mosque|cathedral|castle|palace|tower|bridge|monument|beach|market|historic|heritage|tourist|square|library|gallery|theatre|theater|aquarium|zoo/i.test(description)
      || /former|demolished|destroyed|proposed/i.test(description)) return [];
    const name = entity.labels?.en?.value || page.title;
    return [{ provider: 'wikidata' as const, placeId: id, name, description: description.slice(0, 600), ...coordinate,
      city: anchor.city, country: anchor.country, countryCode: anchor.countryCode,
      sourceUrl: `https://www.wikidata.org/wiki/${id}`, fetchedAt, ...openingDetails(entity, entities),
      file: values(entity, 'P18').find(value => typeof value === 'string') as string | undefined }];
  });
  const files = [...new Set(places.flatMap(place => place.file ? [`File:${place.file}`] : []))].slice(0, 50);
  const images = new Map<string, { imageUrl: string; imageAttribution: GroundedPlace['imageAttribution'] }>();
  if (files.length) {
    try {
      const data = await json('https://commons.wikimedia.org', { action: 'query', titles: files.join('|'), prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1200' });
      for (const page of Object.values(data.query?.pages ?? {}) as any[]) {
        const info = page.imageinfo?.[0];
        const metadata = info?.extmetadata ?? {};
        const license = strip(metadata.LicenseShortName?.value);
        const creator = strip(metadata.Artist?.value);
        const imageUrl = info?.thumburl || info?.url;
        // No unattributed images, local artwork, maps, or AI illustrations.
        if (!creator || !/CC BY|CC0|public domain/i.test(license) || !/^image\/(jpeg|png|webp|avif)$/.test(info?.mime ?? '')
          || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(imageUrl ?? '')
          || /\b(map|logo|drawing|illustration|AI-generated|AI generated)\b/i.test(`${page.title} ${strip(metadata.ImageDescription?.value)}`)) continue;
        const ccLicense = license.match(/^CC (BY(?:-SA)?)(?: )([\d.]+)$/i);
        const licenseUrl = /^https:\/\//.test(metadata.LicenseUrl?.value ?? '') ? metadata.LicenseUrl.value
          : ccLicense ? `https://creativecommons.org/licenses/${ccLicense[1].toLowerCase()}/${ccLicense[2]}/` : /^CC0$/i.test(license) ? 'https://creativecommons.org/publicdomain/zero/1.0/' : undefined;
        images.set(page.title, { imageUrl, imageAttribution: { creator: creator.slice(0, 200), license, licenseUrl,
          sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}` } });
      }
    } catch { /* Missing photos must not prevent a reference-backed plan. */ }
  }
  const used = new Set<string>();
  return places.map(({ file, ...place }) => {
    const image = file ? images.get(`File:${file}`) : undefined;
    if (!image || used.has(image.imageUrl)) return place;
    used.add(image.imageUrl);
    return { ...place, ...image };
  });
}

export async function loadGroundedPlaces(anchor: DestinationAnchor, signal?: AbortSignal) {
  const key = `grounded-places:${anchor.countryCode}:${normalized(anchor.city)}:${anchor.latitude.toFixed(5)}:${anchor.longitude.toFixed(5)}`;
  try {
    const result = await withProviderCache(key, { source: 'activities', freshForMs: 6 * 3600000, staleForMs: 24 * 3600000 }, () => retrieveGroundedPlaces(anchor, fetch, signal));
    return { places: result.value, status: result.freshness.status };
  } catch { return { places: [] as GroundedPlace[], status: 'unavailable' as const }; }
}
