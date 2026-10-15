import { countries, type TCountryCode } from 'countries-list';

export interface GeocodingPlace {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  population?: number;
}

export interface LocationSuggestion {
  id: number;
  name: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  label: string;
  placeType: string;
  contextLabel: string;
  provider?: 'geonames' | 'openstreetmap' | 'psgc';
  providerId?: string;
  administrativeCode?: string;
  provinceCode?: string;
  geographicProvinceCode?: string;
  administrativeLevel?: 'Region' | 'Province' | 'City' | 'Municipality' | 'Barangay';
  coordinateSource?: string;
  sourceFeatureCode?: string;
  scopeType?: 'country' | 'area' | 'locality' | 'natural';
  parentId?: number;
  canBrowse?: boolean;
  locationPath?: Array<{ id: number; providerId: string; name: string; type: string; countryCode: string; level?: number }>;
  bounds?: { south: number; north: number; west: number; east: number };
}

/** Official catalogue identity can be offered before its point is geocoded. */
export type AdministrativeLocationSuggestion = Omit<LocationSuggestion, 'latitude' | 'longitude'> & {
  latitude?: number;
  longitude?: number;
  coordinateStatus: 'resolved' | 'unresolved';
};
export type LocationCandidate = LocationSuggestion | AdministrativeLocationSuggestion;
export const hasResolvedCoordinates = (place: LocationCandidate): place is LocationSuggestion => Number.isFinite(place.latitude) && Number.isFinite(place.longitude);

export interface ReverseGeocodingResponse {
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
    region?: string;
    country?: string;
    country_code?: string;
  };
}

interface RankedPlace {
  place: GeocodingPlace;
  score: number;
  exactName: boolean;
}

const COUNTRY_FEATURE = /^PCL/;
const ADMIN_FEATURE = /^ADM[1-4]$/;
const POPULATED_FEATURE = /^PPL/;
const ISLAND_FEATURE = /^ISL/;

export function capitalForCountryCode(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) return '';
  return countries[countryCode as TCountryCode]?.capital?.trim() || '';
}

function normalize(value: string | undefined): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function uniqueParts(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return parts.filter((part): part is string => {
    const key = normalize(part);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDestinationFeature(featureCode: string): boolean {
  return COUNTRY_FEATURE.test(featureCode) || ADMIN_FEATURE.test(featureCode) || POPULATED_FEATURE.test(featureCode) || ISLAND_FEATURE.test(featureCode) || /^(MT|MTS|VLC|PRK|RESN|RESV|BCH|NATF|CNYN|LK)$/.test(featureCode);
}

function typeWeight(featureCode: string): number {
  if (featureCode === 'PCLI') return 560;
  if (COUNTRY_FEATURE.test(featureCode)) return 500;
  if (featureCode === 'PPLC') return 480;
  if (featureCode === 'PPLA') return 440;
  if (/^PPLA[2-4]$/.test(featureCode)) return 390;
  if (ADMIN_FEATURE.test(featureCode)) return 360 - (Number(featureCode.at(-1)) * 25);
  if (ISLAND_FEATURE.test(featureCode)) return 260;
  if (POPULATED_FEATURE.test(featureCode)) return 220;
  return 0;
}

function placeType(featureCode: string, countryCode?: string): string {
  if (countryCode === 'PH' && featureCode === 'ADM2') return 'Province';
  if (countryCode === 'PH' && featureCode === 'ADM3') return 'Administrative area';
  if (countryCode === 'PH' && featureCode === 'ADM4') return 'Barangay';
  if (COUNTRY_FEATURE.test(featureCode)) return 'Country';
  if (featureCode === 'PPLC') return 'Capital city';
  if (/^PPLA/.test(featureCode)) return 'Administrative capital';
  if (ADMIN_FEATURE.test(featureCode)) return 'Region';
  if (ISLAND_FEATURE.test(featureCode)) return 'Island';
  if (/^(MT|MTS|VLC)$/.test(featureCode)) return 'Mountain';
  if (/^(PRK|RESN|RESV)$/.test(featureCode)) return 'Park or nature reserve';
  if (featureCode === 'BCH') return 'Beach';
  if (featureCode === 'LK') return 'Lake';
  if (featureCode === 'NATF') return 'Waterfall';
  if (featureCode === 'CNYN') return 'Canyon';
  if (featureCode === 'PPLX') return 'Neighborhood';
  if (POPULATED_FEATURE.test(featureCode)) return 'City or locality';
  return 'Destination';
}

function hierarchyMatches(place: GeocodingPlace, query: string): boolean {
  return [place.country, place.country_code, place.admin1, place.admin2, place.admin3, place.admin4].some((value) => normalize(value) === query);
}

function scorePlace(place: GeocodingPlace, primaryQuery: string, providerIndex: number): RankedPlace | null {
  const featureCode = place.feature_code || '';
  if (!isDestinationFeature(featureCode)) return null;
  const name = normalize(place.name);
  const exactName = name === primaryQuery;
  const prefixName = name.startsWith(primaryQuery) || primaryQuery.startsWith(name);
  const hierarchyMatch = hierarchyMatches(place, primaryQuery);
  if (!exactName && !prefixName && !hierarchyMatch) return null;
  let score = typeWeight(featureCode);
  if (exactName) score += 1_000;
  else if (prefixName) score += 600;
  else score += 260;
  if (COUNTRY_FEATURE.test(featureCode) && normalize(place.country) === primaryQuery) score += 900;
  if (hierarchyMatch) score += 80;
  if (place.population && place.population > 0) score += Math.log10(place.population + 1) * 45;
  score += Math.max(0, 50 - providerIndex);
  return { place, score, exactName };
}

function toSuggestion(place: GeocodingPlace): LocationSuggestion {
  const featureCode = place.feature_code || '';
  const country = place.country || place.country_code || '';
  const region = uniqueParts([place.admin2, place.admin1]).join(', ');
  const label = uniqueParts([place.name, region, country]).join(', ');
  const type = placeType(featureCode, place.country_code);
  return { id: place.id, name: place.name, region, country, countryCode: place.country_code || '', latitude: place.latitude, longitude: place.longitude, label, placeType: type, contextLabel: `${type} • ${label}`, provider: 'geonames', providerId: String(place.id) };
}

export async function reverseGeocodeLocation(latitude: number, longitude: number, fetchImplementation: typeof fetch = fetch): Promise<LocationSuggestion | null> {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  const params = new URLSearchParams({ format: 'jsonv2', lat: latitude.toFixed(6), lon: longitude.toFixed(6), zoom: '10', addressdetails: '1' });
  const response = await fetchImplementation(`https://nominatim.openstreetmap.org/reverse?${params}`, { headers: { Accept: 'application/json', 'User-Agent': 'TravelMate/1.0 (travel planning application)' }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return null;
  const result = await response.json() as ReverseGeocodingResponse;
  const address = result.address || {};
  const name = address.city || address.town || address.village || address.municipality || address.county || '';
  const country = address.country || '';
  const countryCode = (address.country_code || '').toUpperCase();
  if (!name || !country || !/^[A-Z]{2}$/.test(countryCode)) return null;
  const region = address.state || address.region || '';
  const label = uniqueParts([name, region, country]).join(', ');
  return { id: -1, name, region, country, countryCode, latitude, longitude, label, placeType: 'Current location', contextLabel: `Current location • ${label}` };
}

export function rankLocationSuggestions(query: string, places: GeocodingPlace[], limit = 8): LocationSuggestion[] {
  const primaryQuery = normalize(query.split(',')[0]);
  if (!primaryQuery) return [];
  const ranked = places.map((place, index) => scorePlace(place, primaryQuery, index)).filter((candidate): candidate is RankedPlace => candidate !== null).sort((left, right) => right.score - left.score);
  const exactCountries = ranked.filter(({ place, exactName }) => exactName && COUNTRY_FEATURE.test(place.feature_code || ''));
  const relevant = exactCountries.length > 0 ? exactCountries : ranked;
  const seen = new Set<string>();
  return relevant.filter(({ place }) => {
    const key = [normalize(place.name), normalize(place.admin1), normalize(place.admin2), normalize(place.admin3), normalize(place.admin4), normalize(place.country), place.feature_code || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit).map(({ place }) => toSuggestion(place));
}

export async function enrichCountrySuggestions(locations: LocationSuggestion[], fetchImplementation: typeof fetch = fetch): Promise<LocationSuggestion[]> {
  const country = locations.find((location) => location.placeType === 'Country');
  if (!country) return locations;
  const capital = capitalForCountryCode(country.countryCode);
  if (!capital) return locations;
  try {
    const params = new URLSearchParams({ name: capital, count: '10', language: 'en', format: 'json', countryCode: country.countryCode });
    const response = await fetchImplementation(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return locations;
    const data = await response.json() as { results?: GeocodingPlace[] };
    const capitalLocations = rankLocationSuggestions(capital, (data.results || []).filter((place) => !COUNTRY_FEATURE.test(place.feature_code || '')), 1).filter((location) => location.countryCode === country.countryCode);
    const existingIds = new Set(locations.map((location) => location.id));
    return [...locations, ...capitalLocations.filter((location) => !existingIds.has(location.id))].slice(0, 8);
  } catch {
    return locations;
  }
}
