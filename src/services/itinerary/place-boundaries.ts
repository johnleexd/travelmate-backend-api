import { fetchGeocoderSearch } from '../destination/geocoder-client.ts';
import { parsePolygon, pointInGeography, type PolygonGeometry } from '../destination/geographic-membership.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import type { DestinationAnchor } from './grounding-schema.ts';

export interface PlaceBoundary { city: string; countryCode: string; geometry: PolygonGeometry; sourceUrl: string; wikidataId?: string }
const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One cached, explicit-selection boundary lookup, using the existing geocoder queue. */
export async function loadPlaceBoundary(anchor: DestinationAnchor, fetcher: typeof fetch, wikidataId?: string): Promise<PlaceBoundary | null> {
  try {
    const result = await withProviderCache(`place-boundary:v1:${anchor.countryCode}:${normalize(anchor.city)}:${anchor.latitude}:${anchor.longitude}:${wikidataId ?? 'name'}`, { source: 'activities', freshForMs: 24 * 3600000, staleForMs: 24 * 3600000 }, async () => {
      const params = new URLSearchParams({ q: `${anchor.city}, ${anchor.country}`, countrycodes: anchor.countryCode.toLowerCase(), format: 'jsonv2', addressdetails: '1', namedetails: '1', extratags: '1', polygon_geojson: '1', polygon_threshold: '0.0001', limit: '5', 'accept-language': 'en' });
      const payload = await fetchGeocoderSearch(params, fetcher);
      if (!Array.isArray(payload)) throw new Error('Invalid city boundary response');
      const matches = payload.flatMap(raw => {
        if (raw?.address?.country_code?.toUpperCase() !== anchor.countryCode || raw.type !== 'administrative' || !['city', 'town', 'municipality', 'county', 'district', 'borough', 'village'].includes(raw.addresstype)
          || !['relation', 'way'].includes(raw.osm_type) || !Number.isInteger(raw.osm_id)) return [];
        const names = [raw.name, ...Object.values(raw.namedetails ?? {})].filter((name): name is string => typeof name === 'string');
        if (wikidataId && raw.extratags?.wikidata && raw.extratags.wikidata !== wikidataId) return [];
        // An exact Wikidata reference or source-provided name alias must identify this locality.
        if (!(wikidataId && raw.extratags?.wikidata === wikidataId) && !names.some(name => normalize(name) === normalize(anchor.city))) return [];
        const geometry = parsePolygon(raw.geojson);
        if (!geometry || !pointInGeography(anchor.latitude, anchor.longitude, geometry)) return [];
        return [{ city: anchor.city, countryCode: anchor.countryCode, geometry, sourceUrl: `https://www.openstreetmap.org/${raw.osm_type}/${raw.osm_id}`, wikidataId: raw.extratags?.wikidata }];
      });
      console.info(JSON.stringify({ event: 'place_boundary_validation', city: anchor.city, returned: payload.length, accepted: matches.length }));
      if (matches.length !== 1) throw new Error('No unique matching administrative boundary');
      return matches[0];
    });
    return result.value;
  } catch (error) {
    console.warn('[TravelMate places] Boundary unavailable:', anchor.city, error instanceof Error ? error.message : 'Request failed');
    return null;
  }
}

export const containsPlace = (boundary: PlaceBoundary, point: { latitude: number; longitude: number }) => pointInGeography(point.latitude, point.longitude, boundary.geometry);

export async function corroboratePlaceCoordinate(name: string, placeId: string, point: { latitude: number; longitude: number }, anchor: DestinationAnchor, fetcher: typeof fetch): Promise<{ sourceUrl: string; city?: string } | null> {
  try {
    return (await withProviderCache(`place-coordinate:v1:${placeId}:${anchor.countryCode}:${point.latitude}:${point.longitude}`, { source: 'activities', freshForMs: 24 * 3600000, staleForMs: 24 * 3600000 }, async () => {
      const payload = await fetchGeocoderSearch(new URLSearchParams({ q: `${name}, ${anchor.country}`, countrycodes: anchor.countryCode.toLowerCase(), format: 'jsonv2', addressdetails: '1', namedetails: '1', extratags: '1', limit: '5', 'accept-language': 'en' }), fetcher);
      if (!Array.isArray(payload)) throw new Error('Invalid venue response');
      const matches = payload.flatMap(raw => {
        if (raw?.address?.country_code?.toUpperCase() !== anchor.countryCode || !['node','way','relation'].includes(raw.osm_type) || !Number.isInteger(raw.osm_id)) return [];
        if (raw.extratags?.wikidata && raw.extratags.wikidata !== placeId) return [];
        const names = [raw.name, ...Object.values(raw.namedetails ?? {})].filter((value): value is string => typeof value === 'string');
        if (raw.extratags?.wikidata !== placeId && !names.some(value => normalize(value) === normalize(name))) return [];
        const latitude = Number(raw.lat), longitude = Number(raw.lon);
        const north = (latitude - point.latitude) * 111.2, east = (longitude - point.longitude) * 111.2 * Math.cos(point.latitude * Math.PI / 180);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || Math.hypot(north, east) > 0.25) return [];
        const city = [raw.address.city, raw.address.town, raw.address.municipality, raw.address.county].find(value => typeof value === 'string' && value.trim());
        return [{ sourceUrl: `https://www.openstreetmap.org/${raw.osm_type}/${raw.osm_id}`, city: typeof city === 'string' ? city.slice(0, 1000) : undefined }];
      });
      console.info(JSON.stringify({ event: 'place_coordinate_corroboration', placeId, returned: payload.length, accepted: matches.length, sourceUrl: matches.length === 1 ? matches[0].sourceUrl : undefined }));
      if (matches.length !== 1) throw new Error('No unique matching mapped venue');
      return matches[0];
    })).value;
  } catch (error) { console.warn('[TravelMate places] Venue corroboration unavailable:', placeId, error instanceof Error ? error.message : 'Request failed'); return null; }
}
