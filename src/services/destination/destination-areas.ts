import { indexedCities, indexedDestination, indexedDestinationNames, indexedAdministrativeArea, destinationIndexSource, normalizeDestination, deduplicateDestinations } from './destination-index.ts';
import { resolvedLocationById, rememberResolvedLocation } from './resolved-location-cache.ts';
import { rankLocationSuggestions, type GeocodingPlace, type LocationSuggestion } from './location-search-service.ts';
import { needsAccommodationArea } from './location-resolution.ts';
import { fetchGeocoderSearch } from './geocoder-client.ts';
import { parsePolygon, pointInGeography, type PolygonGeometry } from './geographic-membership.ts';
import { createAreaCache } from './area-cache.ts';

export interface AreaSuggestion extends LocationSuggestion {
  description: string;
  population?: number;
  membership: 'country-code' | 'administrative-hierarchy' | 'boundary';
}
export interface DestinationAreasResponse {
  parentId: number;
  countryCode: string;
  areas: AreaSuggestion[];
  total: number;
  nextOffset: number | null;
  status: 'ready' | 'empty';
  message: string;
  fetchedAt: string;
  expiresAt: string;
  sourceUrls: string[];
}
type Geography = { parent: LocationSuggestion; method: AreaSuggestion['membership']; region?: string; polygon?: PolygonGeometry; sourceUrls: string[] };
const geographyCache = createAreaCache<Geography>(40);
const cityCache = createAreaCache<Array<LocationSuggestion & { population?: number }>>(100);
const searchCache = createAreaCache<DestinationAreasResponse>(300);

export function selectedAreaParent(id: number, countryCode: string): LocationSuggestion {
  const parent = indexedDestination(id, countryCode) || resolvedLocationById(id, countryCode);
  if (!parent || !needsAccommodationArea(parent)) throw new Error('Select a valid country, region or island again before searching its cities.');
  return parent;
}
const keyFor = (parent: LocationSuggestion) => `${parent.countryCode}:${parent.provider || 'geonames'}:${parent.providerId || parent.id}`;
const bareName = (value: string) => normalizeDestination(value).replace(/\b(island|islands)\b/g, '').trim();

async function geography(parent: LocationSuggestion, fetcher: typeof fetch): Promise<Geography> {
  return geographyCache.get(keyFor(parent), async () => {
    if (parent.placeType === 'Country') return { parent, method: 'country-code', sourceUrls: [destinationIndexSource.sourceUrl] };
    const region = indexedAdministrativeArea(parent.id, parent.countryCode);
    if (parent.placeType === 'Region' && region && indexedCities(parent.countryCode).some(city => normalizeDestination(city.region) === normalizeDestination(region))) return { parent, method: 'administrative-hierarchy', region, sourceUrls: [destinationIndexSource.sourceUrl] };
    const name = parent.name.replace(/\bislands?\b/gi, '').trim();
    const params = new URLSearchParams({ q: `${name}, ${parent.country}`, countrycodes: parent.countryCode.toLowerCase(), format: 'jsonv2', addressdetails: '1', namedetails: '1', polygon_geojson: '1', polygon_threshold: '0.001', limit: '5', 'accept-language': 'en' });
    const payload = await fetchGeocoderSearch(params, fetcher);
    if (!Array.isArray(payload)) throw new Error('The area boundary provider returned invalid data.');
    const expectedNames = new Set([bareName(parent.name), ...indexedDestinationNames(parent.id, parent.countryCode).map(bareName)]);
    const matches = payload.flatMap(raw => {
      if (!raw || raw.address?.country_code?.toUpperCase() !== parent.countryCode) return [];
      const kind = raw.addresstype || raw.type;
      if (parent.placeType === 'Island' ? !['island','archipelago'].includes(kind) : !['state','region','province','county','state_district'].includes(kind)) return [];
      const names = [raw.name, ...Object.values(raw.namedetails || {})].filter((value): value is string => typeof value === 'string');
      if (!names.some(value => expectedNames.has(bareName(value)))) return [];
      const polygon = parsePolygon(raw.geojson); if (!polygon) return [];
      const sameId = parent.provider === 'openstreetmap' && parent.providerId === `${raw.osm_type}:${raw.osm_id}`;
      if (!sameId && !pointInGeography(parent.latitude, parent.longitude, polygon)) return [];
      if (!['relation','way'].includes(raw.osm_type) || !Number.isInteger(raw.osm_id)) return [];
      return [{ polygon, sourceUrl: `https://www.openstreetmap.org/${raw.osm_type}/${raw.osm_id}` }];
    });
    if (matches.length !== 1) throw new Error('A unique boundary for this area could not be verified. Retry area suggestions or choose another destination.');
    return { parent, method: 'boundary', polygon: matches[0].polygon, sourceUrls: [destinationIndexSource.sourceUrl, matches[0].sourceUrl] };
  });
}

export function belongsToArea(city: LocationSuggestion, scope: Geography): boolean {
  if (city.countryCode !== scope.parent.countryCode || !/city|capital|locality|town|village|hamlet/i.test(city.placeType) || !Number.isFinite(city.latitude) || Math.abs(city.latitude) > 90 || !Number.isFinite(city.longitude) || Math.abs(city.longitude) > 180) return false;
  if (scope.method === 'country-code') return true;
  if (scope.method === 'administrative-hierarchy') return normalizeDestination(city.region) === normalizeDestination(scope.region || '');
  return !!scope.polygon && pointInGeography(city.latitude, city.longitude, scope.polygon);
}

async function mappedTowns(scope: Geography, fetcher: typeof fetch): Promise<LocationSuggestion[]> {
  if (!scope.polygon) return [];
  const polygons = scope.polygon.type === 'Polygon' ? [scope.polygon.coordinates] : scope.polygon.coordinates;
  const points = polygons.flatMap(polygon => polygon[0]);
  const box = points.reduce((box, point) => [Math.min(box[0], point[1]), Math.min(box[1], point[0]), Math.max(box[2], point[1]), Math.max(box[3], point[0])], [90, 180, -90, -180]);
  if (box[3] - box[1] > 180) return []; // Never enumerate an almost global dateline box.
  const endpoint = process.env.DESTINATION_AREAS_PLACES_URL || process.env.ACCOMMODATION_PLACES_URL || 'https://overpass-api.de/api/interpreter';
  const response = await fetcher(endpoint, { method: 'POST', body: `[out:json][timeout:20];node[place~"^(city|town|village)$"](${box.join(',')});out body 200;`, headers: { 'Content-Type': 'text/plain', 'User-Agent': 'TravelMate/1.0 selected-area towns' }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error('Mapped town suggestions are temporarily unavailable.');
  const payload = await response.json() as { elements?: Array<{ id?: number; lat?: number; lon?: number; tags?: Record<string,string> }> };
  if (!Array.isArray(payload.elements)) throw new Error('Mapped town provider returned invalid data.');
  return payload.elements.flatMap(raw => {
    const name = raw.tags?.['name:en'] || raw.tags?.name;
    if (!name || !Number.isInteger(raw.id) || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon) || Math.abs(raw.lat!) > 90 || Math.abs(raw.lon!) > 180 || !['city','town','village'].includes(raw.tags?.place || '') || raw.tags?.['addr:country'] && raw.tags['addr:country'].toUpperCase() !== scope.parent.countryCode) return [];
    const city: LocationSuggestion = { id: -raw.id!, name: name.slice(0,100), region: scope.parent.name, country: scope.parent.country, countryCode: scope.parent.countryCode, latitude: raw.lat!, longitude: raw.lon!, label: `${name}, ${scope.parent.name}, ${scope.parent.country}`, placeType: 'City or locality', contextLabel: `Mapped ${raw.tags?.place} within ${scope.parent.label}`, provider: 'openstreetmap', providerId: `node:${raw.id}` };
    return belongsToArea(city, scope) ? [city] : [];
  });
}

async function areaCities(scope: Geography, fetcher: typeof fetch) {
  return cityCache.get(keyFor(scope.parent), async () => {
    let cities: Array<LocationSuggestion & { population?: number }> = indexedCities(scope.parent.countryCode).filter(city => belongsToArea(city, scope));
    if (!cities.length) cities = await mappedTowns(scope, fetcher);
    cities.forEach(rememberResolvedLocation);
    return cities;
  });
}

export async function searchDestinationAreas(parent: LocationSuggestion, query = '', offset = 0, fetcher: typeof fetch = fetch): Promise<DestinationAreasResponse> {
  const normalized = normalizeDestination(query);
  return searchCache.get(`${keyFor(parent)}:${normalized}:${offset}`, async () => {
    const scope = await geography(parent, fetcher);
    let cities = await areaCities(scope, fetcher);
    if (normalized) {
      cities = cities.filter(city => normalizeDestination(`${city.name} ${city.region}`).includes(normalized));
      // Typing uses Open-Meteo/GeoNames only; the parent boundary stays cached.
      // No public Nominatim autocomplete and no unvalidated global fallback.
      if (!cities.length && normalized.length >= 2) {
        const params = new URLSearchParams({ name: query, countryCode: parent.countryCode, count: '100', language: 'en', format: 'json' });
        const response = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('City search provider is temporarily unavailable.');
        const payload = await response.json() as { results?: GeocodingPlace[] };
        cities = (payload.results || []).flatMap(row => rankLocationSuggestions(row.name, [row], 1)).filter(city => belongsToArea(city, scope));
        cities.forEach(rememberResolvedLocation);
      }
    }
    cities = deduplicateDestinations(cities);
    const fetchedAt = new Date().toISOString();
    return { parentId: parent.id, countryCode: parent.countryCode, areas: cities.slice(offset, offset + 20).map(city => ({ ...city, description: `${city.placeType} in ${city.region || city.country}.${'population' in city && city.population ? ` Recorded population: ${city.population.toLocaleString('en')}; census date not supplied.` : ''}`, membership: scope.method })), total: cities.length, nextOffset: offset + 20 < cities.length ? offset + 20 : null, status: cities.length ? 'ready' : 'empty', message: cities.length ? 'Choose a city to search accommodation. Suggestions are a geographic catalogue, not a complete list of every settlement.' : 'No verified cities or towns were found in this area. Try another city name or destination.', fetchedAt, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), sourceUrls: scope.sourceUrls };
  });
}

export async function validatedAreaCities(parent: LocationSuggestion, ids: number[], fetcher: typeof fetch = fetch) {
  const scope = await geography(parent, fetcher);
  return ids.flatMap(id => { const city = indexedDestination(id, parent.countryCode) || resolvedLocationById(id, parent.countryCode); return city && belongsToArea(city, scope) ? [city] : []; });
}
export function clearDestinationAreaCaches() { geographyCache.clear(); cityCache.clear(); searchCache.clear(); }
