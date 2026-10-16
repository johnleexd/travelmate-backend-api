import { indexedCities, indexedDestination, indexedDestinationNames, indexedAdministrativeArea, destinationIndexSource, normalizeDestination, deduplicateDestinations } from './destination-index.ts';
import { resolvedLocationById, rememberResolvedLocation } from './resolved-location-cache.ts';
import { rankLocationSuggestions, hasResolvedCoordinates, type GeocodingPlace, type LocationSuggestion, type LocationCandidate, type AdministrativeLocationSuggestion } from './location-search-service.ts';
import { administrativeRecord, administrativeCandidate, administrativeChildren, philippineCatalogueSource, resolveAdministrativeLocation } from './philippine-catalogue.ts';
import { needsAccommodationArea } from './location-resolution.ts';
import { fetchGeocoderSearch } from './geocoder-client.ts';
import { parsePolygon, pointInGeography, type PolygonGeometry } from './geographic-membership.ts';
import { createAreaCache } from './area-cache.ts';
import { catalogueLocation, catalogueContains, catalogueContainsAny, searchCatalogue, globalCatalogueCoverage } from './global-catalogue.ts';
import { isDestinationLocality } from '../../lib/location-scope.ts';

export interface AreaSuggestion extends AdministrativeLocationSuggestion {
  description: string;
  population?: number;
  membership: 'country-code' | 'administrative-hierarchy' | 'boundary' | 'official-administrative' | 'geographic-association';
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
  coverage?: 'complete-administrative' | 'partial-geographic' | 'imported-catalogue';
  catalogueAsOf?: string;
}
type Geography = { parent: LocationSuggestion; method: AreaSuggestion['membership']; region?: string; polygon?: PolygonGeometry; sourceUrls: string[] };
const geographyCache = createAreaCache<Geography>(40);
const cityCache = createAreaCache<Array<LocationSuggestion & { population?: number }>>(100);
const searchCache = createAreaCache<DestinationAreasResponse>(300);
class AreaBoundaryCoverageError extends Error {}

export function selectedAreaParent(id: number, countryCode: string): LocationCandidate {
  const official = countryCode === 'PH' ? administrativeRecord(id) : undefined;
  const parent = official ? administrativeCandidate(official) : indexedDestination(id, countryCode) || resolvedLocationById(id, countryCode);
  if (!parent || !(needsAccommodationArea(parent) || parent.canBrowse || isDestinationLocality(parent))) throw new Error('Select a valid parent area again before browsing its places.');
  return parent;
}
const keyFor = (parent: LocationCandidate) => `${parent.countryCode}:${parent.provider || 'geonames'}:${parent.providerId || parent.id}`;
const bareName = (value: string) => normalizeDestination(value).replace(/\b(island|islands)\b/g, '').trim();

async function geography(parent: LocationSuggestion, fetcher: typeof fetch): Promise<Geography> {
  return geographyCache.get(keyFor(parent), async () => {
    if (parent.placeType === 'Country') return { parent, method: 'country-code', sourceUrls: [destinationIndexSource.sourceUrl], coverage: 'partial-geographic' };
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
    if (matches.length !== 1) throw new AreaBoundaryCoverageError('No unique boundary is available for this area, so cities within it cannot be verified. Search for a specific city or town in the Destination field.');
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
  const fallback = process.env.ACCOMMODATION_PLACES_FALLBACK_URL || (endpoint === 'https://overpass-api.de/api/interpreter' ? 'https://lz4.overpass-api.de/api/interpreter' : '');
  const endpoints = [...new Set([endpoint, ...(fallback ? [fallback] : [])])];
  type TownPayload = { remark?: string; elements: Array<{ id?: number; lat?: number; lon?: number; tags?: Record<string,string> }> };
  let payload: TownPayload | undefined;
  let failure: unknown;
  for (const url of endpoints) {
    try {
      // Keep both attempts plus boundary resolution within the browser's 40s budget.
      // An island may cross a border. Restrict untagged towns to the selected
      // country's mapped administrative area as well as the verified polygon.
      const body = new URLSearchParams({data:`[out:json][timeout:8];area["ISO3166-1"="${scope.parent.countryCode}"][admin_level=2]->.country;node(area.country)[place~"^(city|town|village)$"](${box.join(',')});out body 200;`});
      const response = await fetcher(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TravelMate/1.0 selected-area towns' }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 429 || response.status === 406) {
        // Do not evade the provider's request limits through its other instance.
        failure = new Error('Mapped town provider request limit reached. Try again shortly.');
        break;
      }
      if (!response.ok) throw new Error('Mapped town suggestions are temporarily unavailable. Retry area suggestions or search for a specific city or town in the Destination field.');
      const result = await response.json() as TownPayload;
      if (!result || !Array.isArray(result.elements)) throw new Error('Mapped town provider returned invalid data.');
      if (result.remark) throw new Error('Mapped town provider could not complete the search. Retry area suggestions or search for a specific city or town in the Destination field.');
      payload = result;
      break;
    } catch (error) { failure = error; }
  }
  if (!payload) {
    if (failure instanceof Error && failure.message.startsWith('Mapped town')) throw failure;
    throw new Error('Mapped town suggestions are temporarily unavailable. Retry area suggestions or search for a specific city or town in the Destination field.',{cause:failure});
  }
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

export async function searchDestinationAreas(parent: LocationCandidate, query = '', offset = 0, fetcher: typeof fetch = fetch, hierarchy = false): Promise<DestinationAreasResponse> {
  const official = administrativeChildren(parent, query, hierarchy);
  const sourceId = administrativeRecord(parent.id)?.geocodingId || parent.id;
  const catalogParent = catalogueLocation(sourceId, parent.countryCode);
  // Official matches must not mask lower-level records in the global provider.
  // Unfiltered official browsing retains its administrative list; typing searches
  // both catalogues within the same verified parent, with one combined page cursor.
  const memberRoots = official && administrativeRecord(parent.id) ? administrativeChildren(parent, '', hierarchy)!.filter(p=>p.scopeType==='locality').flatMap(p=>{const id=administrativeRecord(p.id)?.geocodingId;return id?[id]:[];}) : undefined;
  const supplement = query.trim() && official && catalogParent ? searchCatalogue(query, Math.max(0,offset-official.length),sourceId,undefined,memberRoots,hierarchy) : null;
  if (supplement && official) {
    const areas = [...official.slice(offset,offset+20).map(place=>({...place,description:place.contextLabel,membership:hierarchy && parent.placeType==='Province' && place.provinceCode!==parent.administrativeCode && place.geographicProvinceCode===parent.administrativeCode?'geographic-association' as const:'official-administrative' as const})),...supplement.locations.map(place=>({...place,coordinateStatus:'resolved' as const,description:place.contextLabel,membership:'administrative-hierarchy' as const}))].slice(0,20);
    const total=official.length+supplement.total,fetchedAt=new Date().toISOString();
    return {parentId:parent.id,countryCode:parent.countryCode,areas,total,nextOffset:offset+20<total?offset+20:null,status:total?'ready':'empty',message:'Searching the full official city/municipality catalogue and available GeoNames lower-level places within this area. Village and barangay coverage is partial; missing places can be checked with verified geocoding.',fetchedAt,expiresAt:new Date(Date.now()+24*3600_000).toISOString(),sourceUrls:[...philippineCatalogueSource.sourceUrls,'https://download.geonames.org/export/dump/'],coverage:'imported-catalogue',catalogueAsOf:philippineCatalogueSource.checkedAgainstRelease};
  }
  if (official && (official.length || !query)) {
    const fetchedAt = new Date().toISOString();
    return { parentId: parent.id, countryCode: parent.countryCode, areas: official.slice(offset, offset + 20).map(place => ({ ...place, description: `${place.contextLabel}. ${place.coordinateStatus === 'resolved' ? 'Coordinates verified through geocoding.' : 'Coordinates will be verified when you select this place.'}`, membership: hierarchy && parent.placeType === 'Province' && place.provinceCode !== parent.administrativeCode && place.geographicProvinceCode === parent.administrativeCode ? 'geographic-association' as const : 'official-administrative' as const })), total: official.length, nextOffset: offset + 20 < official.length ? offset + 20 : null, status: official.length ? 'ready' : 'empty', message: official.length ? `Search covers the full PSA PSGC catalogue for this administrative area. Choose a city or municipality; hotel availability does not affect selection.${parent.placeType === 'Province' ? ' Independent cities are labeled separately; their geographic province association does not change their official PSGC assignment.' : ''}` : 'No city or municipality matches in this official administrative area. Check the spelling or try its official name or alias.', fetchedAt, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), sourceUrls: philippineCatalogueSource.sourceUrls, coverage: 'complete-administrative', catalogueAsOf: philippineCatalogueSource.checkedAgainstRelease };
  }
  const page = catalogParent ? searchCatalogue(query, offset, sourceId,undefined,memberRoots,hierarchy) : null;
  if (page) { const fetchedAt = new Date().toISOString(); return { parentId: parent.id, countryCode: parent.countryCode, areas: page.locations.map(place => ({ ...place, coordinateStatus: 'resolved' as const, description: `${place.contextLabel}. Hotels and photos are optional.`, membership: 'administrative-hierarchy' as const })), total: page.total, nextOffset: page.nextOffset, status: page.total ? 'ready' : 'empty', message: `${query ? 'Searching' : 'Browsing'} all recorded places within this selected area. Coverage and lower levels vary by country. Use verified geocoding for a missing place.`, fetchedAt, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), sourceUrls: ['https://download.geonames.org/export/dump/'], coverage: 'imported-catalogue', catalogueAsOf: globalCatalogueCoverage()?.archiveModifiedAt }; }
  if (!hasResolvedCoordinates(parent)) throw Error('Resolve this area before searching within its boundary.');
  const normalized = normalizeDestination(query);
  return searchCache.get(`${keyFor(parent)}:${normalized}:${offset}`, async () => {
    let scope: Geography;
    try { scope = await geography(parent, fetcher); }
    catch (error) {
      if (!(error instanceof AreaBoundaryCoverageError)) throw error;
      const fetchedAt = new Date().toISOString();
      return { parentId: parent.id, countryCode: parent.countryCode, areas: [], total: 0, nextOffset: null, status: 'empty', message: error.message, fetchedAt, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), sourceUrls: [destinationIndexSource.sourceUrl], coverage: 'partial-geographic' };
    }
    let cities = await areaCities(scope, fetcher);
    let providerNotice = '';
    if (normalized) {
      const local = cities.filter(city => normalizeDestination(`${city.name} ${city.region}`).includes(normalized));
      // Typing uses Open-Meteo/GeoNames only; the parent boundary stays cached.
      // No public Nominatim autocomplete and no unvalidated global fallback.
      if (normalized.length >= 2) {
        const params = new URLSearchParams({ name: query, countryCode: parent.countryCode, count: '100', language: 'en', format: 'json' });
        try {
          const response = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error('City search provider is temporarily unavailable.');
          const payload = await response.json() as { results?: GeocodingPlace[] };
          cities = deduplicateDestinations([...local, ...(payload.results || []).flatMap(row => rankLocationSuggestions(row.name, [row], 1)).filter(city => belongsToArea(city, scope))]);
          cities.forEach(rememberResolvedLocation);
        } catch (error) { if (!local.length) throw error; cities = local; providerNotice = 'Live city search is temporarily unavailable; showing verified catalogue matches. '; }
      } else cities = local;
    }
    cities = deduplicateDestinations(cities);
    const fetchedAt = new Date().toISOString();
    return { parentId: parent.id, countryCode: parent.countryCode, areas: cities.slice(offset, offset + 20).map(city => ({ ...city, coordinateStatus: 'resolved' as const, description: `${city.placeType} in ${city.region || city.country}. Administrative classification may need confirmation.`, membership: scope.method })), total: cities.length, nextOffset: offset + 20 < cities.length ? offset + 20 : null, status: cities.length ? 'ready' : 'empty', message: cities.length ? providerNotice + 'Geographic coverage is incomplete. Typing checks the available live provider as well as the catalogue, within the verified area. For other places, use verified search in the Destination field. Hotel availability does not determine which places you may select.' : 'No verified matches were found in the available coverage. This does not mean the place does not exist. Try a full place name in the Destination field for verified search.', fetchedAt, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), sourceUrls: scope.sourceUrls, coverage: 'partial-geographic' };
  });
}

export async function validatedAreaCities(parent: LocationCandidate, ids: number[], fetcher: typeof fetch = fetch, hierarchy = false) {
  const official = administrativeChildren(parent, '', hierarchy);
  const sourceId = administrativeRecord(parent.id)?.geocodingId || parent.id;
  if (official) {
    const memberRoots=administrativeRecord(parent.id)?official.filter(p=>p.scopeType==='locality').flatMap(p=>{const id=administrativeRecord(p.id)?.geocodingId;return id?[id]:[];}):undefined;
    return Promise.all(ids.map(id=>{const selected=official.find(place=>place.id===id&&place.scopeType==='locality');if(selected)return resolveAdministrativeLocation(selected.id,'PH',fetcher);const p=catalogueLocation(id,parent.countryCode);if(p&&p.scopeType==='locality'&&catalogueContains(sourceId,id)&&(memberRoots===undefined||catalogueContainsAny(memberRoots,id)))return p;throw Error('Choose up to six localities within this selected administrative area.');}));
  }
  if (catalogueLocation(sourceId, parent.countryCode)) {
    const selected = ids.flatMap(id => { const p = catalogueLocation(id, parent.countryCode); return p && catalogueContains(sourceId, id) && p.scopeType === 'locality' ? [p] : []; });
    if (selected.length !== ids.length) throw Error('Choose up to six localities within this selected administrative area.');
    return selected;
  }
  if (!hasResolvedCoordinates(parent)) throw Error('Resolve this area before comparing places.');
  const scope = await geography(parent, fetcher);
  return ids.flatMap(id => { const city = indexedDestination(id, parent.countryCode) || resolvedLocationById(id, parent.countryCode); return city && belongsToArea(city, scope) ? [city] : []; });
}
export function clearDestinationAreaCaches() { geographyCache.clear(); cityCache.clear(); searchCache.clear(); }
