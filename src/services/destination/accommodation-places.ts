import { localizePropertyNames } from './accommodation-localization.ts';
import { attachAccommodationPhotos } from './accommodation-photos.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import { allowRequest } from '../../middlewares/rate-limit-middleware.ts';

export interface NearbyAccommodation {
  id: string;
  name: string;
  originalName?: string;
  nameSource?: string;
  type: 'Hotel' | 'Hostel' | 'Resort' | 'Guesthouse' | 'Motel' | 'Apartment';
  address: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  source: 'openstreetmap';
  sourceUrl: string;
  city?: string;
  countryCode?: string;
  imageUrl?: string;
  imageAttribution?: { creator: string; license: string; licenseUrl?: string; sourceUrl: string };
  commonsFile?: string;
  wikidataId?: string;
}
export interface AccommodationLocation { destination: string; latitude: number; longitude: number; countryCode?: string; radiusKm?: number }
const types: Record<string, NearbyAccommodation['type']> = { hotel: 'Hotel', hostel: 'Hostel', resort: 'Resort', guest_house: 'Guesthouse', motel: 'Motel', apartment: 'Apartment' };
export function accommodationDistanceKm(a: number, b: number, c: number, d: number) {
  const rad = Math.PI / 180;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin((c-a)*rad/2)**2 + Math.cos(a*rad)*Math.cos(c*rad)*Math.sin((d-b)*rad/2)**2));
}
export function normalizeAccommodationPlaces(payload: unknown, location: AccommodationLocation): NearbyAccommodation[] {
  const elements = (payload as { elements?: unknown[] })?.elements;
  if (!Array.isArray(elements)) throw new Error('Accommodation listing provider returned an invalid response.');
  const rows = elements.flatMap((raw): NearbyAccommodation[] => {
    if (!raw || typeof raw !== 'object') return [];
    const element = raw as { id?: number; type?: string; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> };
    const tags = element.tags || {};
    const latinTag = Object.entries(tags).find(([key, value]) => /^name:.*-Latn$/.test(key) && !/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{M}\p{S}]/u.test(value))?.[1];
    const name = (tags['official_name:en'] || tags['name:en'] || latinTag || tags.int_name || tags.name || '').trim();
    const nameSource = tags['official_name:en'] || tags['name:en'] ? 'official-english' : latinTag ? 'transliterated' : undefined;
    const type = types[tags.tourism] || (tags.leisure === 'resort' ? 'Resort' : undefined);
    const latitude = element.lat ?? element.center?.lat, longitude = element.lon ?? element.center?.lon;
    if (!name || !type || !Number.isInteger(element.id) || !['node','way','relation'].includes(element.type || '') || latitude === undefined || longitude === undefined || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    if (location.countryCode && /^[a-z]{2}$/i.test(tags['addr:country'] || '') && tags['addr:country'].toUpperCase() !== location.countryCode.toUpperCase()) return [];
    const distanceKm = accommodationDistanceKm(location.latitude, location.longitude, latitude, longitude);
    if (distanceKm > (location.radiusKm ?? 10) + 0.1) return [];
    const street = [tags['addr:housenumber'], tags['addr:street:en'] || tags['addr:street']].filter(Boolean).join(' ');
    const address = [street, tags['addr:suburb:en'] || tags['addr:suburb'], tags['addr:city:en'] || tags['addr:city'], tags['addr:province:en'] || tags['addr:province'], tags['addr:postcode'], tags['addr:country']].filter(Boolean).join(', ');
    return [{ id: `osm:${element.type}:${element.id}`, name: name.slice(0,150), originalName: tags.name?.slice(0,150), nameSource, type, address: address.slice(0,300) || `Address not supplied`, latitude, longitude, ...(tags.wikimedia_commons?.startsWith('File:') ? { commonsFile: tags.wikimedia_commons } : {}), ...(/^Q\d+$/.test(tags.wikidata || '') ? { wikidataId: tags.wikidata } : {}), distanceKm: Math.round(distanceKm*10)/10, source: 'openstreetmap', sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`, ...(tags['addr:city'] ? { city: tags['addr:city'] } : {}), ...(/^[a-z]{2}$/i.test(tags['addr:country'] || '') ? { countryCode: tags['addr:country'].toUpperCase() } : {}) }];
  }).sort((a,b) => a.distanceKm-b.distanceKm || a.name.localeCompare(b.name));
  const unique: NearbyAccommodation[] = [];
  for (const row of rows) {
    if (unique.some(item => item.id === row.id || (item.name.normalize('NFKD').toLowerCase() === row.name.normalize('NFKD').toLowerCase() && accommodationDistanceKm(item.latitude,item.longitude,row.latitude,row.longitude) < 0.1))) continue;
    unique.push(row);
  }
  return unique.slice(0,40);
}
export async function searchAccommodationPlaces(location: AccommodationLocation, fetchImplementation: typeof fetch = fetch) {
  const endpoint = process.env.ACCOMMODATION_PLACES_URL || 'https://overpass-api.de/api/interpreter';
  const policy = { source: 'hotels' as const, freshForMs: 24*60*60_000, staleForMs: 48*60*60_000 };
  const key = `osm-english-v2:${endpoint}:${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${location.countryCode || ''}:${location.radiusKm ?? 10}`;
  return withProviderCache(key, policy, async () => {
    // Public Overpass is suitable for small development projects. Protect its
    // shared capacity; production can configure a hosted/private instance.
    if (endpoint === 'https://overpass-api.de/api/interpreter' && !await allowRequest('accommodation-places:public',100,86_400_000)) throw new Error('Accommodation listing service daily limit reached.');
    const around = `around:${(location.radiusKm ?? 10) * 1000},${location.latitude},${location.longitude}`;
    const query = `[out:json][timeout:12][maxsize:16777216];(nwr["tourism"~"^(hotel|hostel|resort|guest_house|motel|apartment)$"](${around});nwr["leisure"="resort"](${around}););out center tags 100;`;
    const endpoints = [endpoint, ...(process.env.ACCOMMODATION_PLACES_FALLBACK_URL ? [process.env.ACCOMMODATION_PLACES_FALLBACK_URL] : endpoint === 'https://overpass-api.de/api/interpreter' ? ['https://overpass.kumi.systems/api/interpreter'] : [])];
    for (const [index, url] of endpoints.entries()) {
      try {
        const response = await fetchImplementation(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TravelMate/1.0 (nearby accommodation discovery)' }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`Accommodation listing provider unavailable (${response.status}).`);
        const payload = await response.json();
        if (payload?.remark) throw new Error('Accommodation listing provider could not complete the search.');
        return attachAccommodationPhotos(await localizePropertyNames(normalizeAccommodationPlaces(payload, location), process.env, fetchImplementation), fetchImplementation);
      } catch (error) { if (index === endpoints.length - 1) throw error; }
    }
    throw new Error('Accommodation listing provider unavailable.');
  });
}
