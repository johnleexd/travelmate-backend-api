import { countries, type TCountryCode } from 'countries-list';
import { searchGlobalLocations } from './global-location-search.ts';
import { normalizeDestination, countryDestinations } from './destination-index.ts';
import { parseDestinationQuery, matchesQualifiers } from './destination-query.ts';
import { rememberResolvedLocation } from './resolved-location-cache.ts';
import type { LocationSuggestion } from './location-search-service.ts';
import { fetchGeocoderSearch } from './geocoder-client.ts';

export const needsAccommodationArea = (location: Pick<LocationSuggestion, 'placeType'>) => ['Country', 'Region', 'Island'].includes(location.placeType);
export function destinationAreas(location: LocationSuggestion) {
  if (!needsAccommodationArea(location)) return [];
  return countryDestinations(location.countryCode, 300).filter(place => {
    if (!/city|capital|locality|neighborhood/i.test(place.placeType)) return false;
    if (location.placeType === 'Country') return true;
    const box = location.bounds;
    if (box) return place.latitude >= box.south && place.latitude <= box.north && place.longitude >= box.west && place.longitude <= box.east;
    return normalizeDestination(place.region) === normalizeDestination(location.name);
  }).slice(0, 20);
}

export function normalizeResolvedPlaces(payload: unknown, query: string): LocationSuggestion[] {
  if (!Array.isArray(payload)) throw new Error('Location provider returned an invalid response.');
  const parsed = parseDestinationQuery(query);
  return payload.flatMap((item): LocationSuggestion[] => {
    const address = item?.address || {};
    const countryCode = String(address.country_code || '').toUpperCase();
    const latitude = Number(item.lat), longitude = Number(item.lon);
    const name = String(item.namedetails?.['name:en'] || item.name || '').trim();
    if (!countries[countryCode as TCountryCode] || !name || !Number.isInteger(item.place_id) || !Number.isInteger(item.osm_id) || !['node','way','relation'].includes(item.osm_type) || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return [];
    if (parsed.countryCode && countryCode !== parsed.countryCode) return [];
    if (!matchesQualifiers(parsed.qualifiers, Object.values(address) as string[])) return [];
    const aliases = [name, ...Object.values(item.namedetails || {})].filter(value => typeof value === 'string') as string[];
    if (!aliases.some(value => normalizeDestination(value) === normalizeDestination(parsed.term))) return [];
    const kind = item.addresstype || item.type;
    if (!['country','state','region','province','county','state_district','municipality','city','town','village','hamlet','island','suburb','city_district','quarter','neighbourhood'].includes(kind)) return [];
    const placeType = kind === 'country' ? 'Country' : ['state','region','province','county','state_district'].includes(kind) ? 'Region' : kind === 'island' ? 'Island' : 'City or locality';
    const region = [...new Set([address.state, address.region].filter(value => value && normalizeDestination(value) !== normalizeDestination(name)))].join(', ');
    const country = countries[countryCode as TCountryCode].name;
    const label = [...new Set([name, region, country].filter(Boolean))].join(', ');
    const box = Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : [];
    const bounds = box.length === 4 && box.every(Number.isFinite) && box[0] >= -90 && box[1] <= 90 && box[2] >= -180 && box[3] <= 180 && box[0] <= box[1] && box[2] <= box[3] ? { south: box[0], north: box[1], west: box[2], east: box[3] } : undefined;
    return [{ id: -item.place_id, name, region, country, countryCode, latitude, longitude, label, placeType, contextLabel: `${placeType} • ${label}`, provider: 'openstreetmap', providerId: `${item.osm_type}:${item.osm_id}`, ...(bounds ? { bounds } : {}) }];
  });
}

// Explicit user-triggered resolution only. Public Nominatim is never queried
// by autocomplete. Successful results are cached for subsequent suggestions.
const pending = new Map<string, Promise<LocationSuggestion[]>>();
async function searchExplicitly(query: string, fetcher: typeof fetch) {
  const endpoint = process.env.DESTINATION_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
  const key = `${endpoint}:${normalizeDestination(query)}`;
  const existing = pending.get(key); if (existing) return existing;
  const task = (async () => {
    const parsed = parseDestinationQuery(query);
    const normalizedQuery = [parsed.term, ...parsed.qualifiers, parsed.countryCode ? countries[parsed.countryCode as TCountryCode].name : ''].filter(Boolean).join(', ');
    const params = new URLSearchParams({ q: normalizedQuery, format: 'jsonv2', addressdetails: '1', namedetails: '1', limit: '10', 'accept-language': 'en' });
    const locations = normalizeResolvedPlaces(await fetchGeocoderSearch(params, fetcher), query);
    locations.forEach(rememberResolvedLocation);
    return locations;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function resolveDestination(query: string, fetcher: typeof fetch = fetch) {
  const term = normalizeDestination(parseDestinationQuery(query).term);
  let matches: LocationSuggestion[] = [];
  let searchFailed = false;
  try { matches = (await searchGlobalLocations(query, fetcher)).filter(place => normalizeDestination(place.name) === term); }
  catch { searchFailed = true; }
  if (!matches.length) matches = await searchExplicitly(query, fetcher);
  if (!matches.length && searchFailed) throw new Error('Location providers are temporarily unavailable. The destination was not confirmed.');
  const location = matches.length === 1 ? matches[0] : null;
  return { location, candidates: matches, areas: location ? destinationAreas(location) : [], message: matches.length > 1 ? 'Several places match. Choose the intended location before searching stays.' : !matches.length ? 'No validated location found. Check the spelling and include its region and country.' : '' };
}
