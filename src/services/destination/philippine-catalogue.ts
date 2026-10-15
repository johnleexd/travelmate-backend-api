import { readFileSync } from 'node:fs';
import { normalizeDestination } from './destination-index.ts';
import { parseDestinationQuery, matchesQualifiers } from './destination-query.ts';
import { fetchGeocoderSearch } from './geocoder-client.ts';
import { rememberResolvedLocation } from './resolved-location-cache.ts';
import type { AdministrativeLocationSuggestion, LocationSuggestion } from './location-search-service.ts';
import { catalogueLocation, catalogueCountry } from './global-catalogue.ts';

type Record = {
  code: string; correspondenceCode: string | null; name: string; displayName?: string; level: 'Region' | 'Province' | 'City' | 'Municipality';
  regionCode: string; provinceCode: string | null; geographicProvinceCode: string | null; aliases: string[];
  latitude?: number; longitude?: number; geocodingId?: number; coordinateSource?: string;
};
const data = JSON.parse(readFileSync(new URL('../../../data/philippines-administrative.json', import.meta.url), 'utf8')) as { sourceUrls: string[]; tableAsOf: string; retrievedAt: string; checkedAgainstRelease: string; records: Record[] };
const namespace = 1_000_000_000_000;
const byCode = new Map(data.records.map(record => [record.code, record]));
const resolved = new Map<number, LocationSuggestion>();
const pending = new Map<number, Promise<LocationSuggestion>>();
export const philippineCatalogueSource = { sourceUrls: data.sourceUrls, tableAsOf: data.tableAsOf, retrievedAt: data.retrievedAt, checkedAgainstRelease: data.checkedAgainstRelease };
export const philippineAdministrativeRecords = data.records;
export const administrativeLocationId = (code: string) => namespace + Number(code);
export function administrativeRecord(id: number): Record | undefined { return byCode.get(String(id - namespace).padStart(10, '0')); }

/** Validate the stable administrative identity before passing its point to downstream providers. */
export async function validateAdministrativeSelection(input: { id: number; countryCode: string; providerId?: string; administrativeCode?: string; provinceCode?: string; geographicProvinceCode?: string; administrativeLevel?: string; latitude: number; longitude: number }, fetcher: typeof fetch = fetch) {
  const selected = await resolveAdministrativeLocation(input.id, input.countryCode, fetcher);
  if (!['City','Municipality'].includes(selected.placeType) || selected.providerId !== input.providerId || selected.administrativeCode !== input.administrativeCode || selected.provinceCode !== input.provinceCode || (input.geographicProvinceCode !== undefined && selected.geographicProvinceCode !== input.geographicProvinceCode) || (input.administrativeLevel !== undefined && selected.administrativeLevel !== input.administrativeLevel) || Math.abs(selected.latitude - input.latitude) > 0.000001 || Math.abs(selected.longitude - input.longitude) > 0.000001) throw Error('The official location ID, province or coordinates do not match. Choose the intended city or municipality again.');
  return selected;
}
const regionName = (record: Record) => byCode.get(record.regionCode)?.name || '';
const names = (record: Record) => [record.name, ...(record.displayName ? [record.displayName] : []), ...record.aliases];

/** Earlier official names stay valid for persisted IDs after a rename. */
export function administrativeLabelMatches(id: number, label: string) {
  const record = administrativeRecord(id); if (!record) return false;
  const parsed = parseDestinationQuery(label);
  return (!parsed.countryCode || parsed.countryCode === 'PH') && names(record).some(name => normalizeDestination(name) === normalizeDestination(parsed.term)) && matchesQualifiers(parsed.qualifiers, [byCode.get(record.provinceCode || record.geographicProvinceCode || '')?.name, regionName(record), 'Philippines'].filter((name): name is string => !!name));
}

export function administrativeCandidate(record: Record): AdministrativeLocationSuggestion {
  const id = administrativeLocationId(record.code), cached = resolved.get(id);
  const province = byCode.get(record.provinceCode || record.geographicProvinceCode || '')?.name;
  const name = record.displayName || record.name;
  const context = record.level === 'Province' || record.level === 'Region' ? '' : province || regionName(record);
  const label = [...new Set([name, context, 'Philippines'].filter(Boolean))].join(', ');
  const independent = record.level === 'City' && !record.provinceCode && !!record.geographicProvinceCode;
  const coordinate = cached || record;
  const parents = [byCode.get(record.regionCode), byCode.get(record.provinceCode || '')].filter((p): p is Record => !!p && p.code !== record.code);
  const locationPath = [...(catalogueCountry('PH')?.locationPath || []), ...[...parents, record].map(p => ({ id: administrativeLocationId(p.code), providerId: p.code, name: p.displayName || p.name, type: p.level, countryCode: 'PH' }))];
  const identity = { locationPath, scopeType: ['Region','Province'].includes(record.level) ? 'area' as const : 'locality' as const, parentId: parents.length ? administrativeLocationId(parents.at(-1)!.code) : undefined, canBrowse: ['Region','Province'].includes(record.level) || !!(record.geocodingId && catalogueLocation(record.geocodingId, 'PH')?.canBrowse) };
  return { id, name, ...identity, region: province || regionName(record), country: 'Philippines', countryCode: 'PH', label, placeType: record.level, contextLabel: `${label} — ${record.level}${independent ? ' (independent city)' : ''}`, provider: 'psgc', providerId: record.code, administrativeCode: record.code, administrativeLevel: record.level, ...(record.provinceCode ? { provinceCode: record.provinceCode } : {}), ...(record.geographicProvinceCode ? { geographicProvinceCode: record.geographicProvinceCode } : {}), ...(coordinate.latitude !== undefined && coordinate.longitude !== undefined ? { latitude: coordinate.latitude, longitude: coordinate.longitude, coordinateSource: coordinate.coordinateSource, coordinateStatus: 'resolved' as const } : { coordinateStatus: 'unresolved' as const }) };
}

export function searchPhilippineCatalogue(query: string): AdministrativeLocationSuggestion[] {
  const parsed = parseDestinationQuery(query);
  if (parsed.countryCode && parsed.countryCode !== 'PH' && normalizeDestination(parsed.term) !== normalizeDestination(query)) return [];
  const term = normalizeDestination(parsed.term);
  if (term.length < 2) return [];
  return data.records.filter(record => names(record).some(name => normalizeDestination(name).includes(term)) && matchesQualifiers(parsed.qualifiers, [record.name, ...record.aliases, byCode.get(record.provinceCode || record.geographicProvinceCode || '')?.name, regionName(record), 'Philippines'].filter((name): name is string => !!name)))
    .sort((a, b) => Number(names(b).some(n => normalizeDestination(n) === term)) - Number(names(a).some(n => normalizeDestination(n) === term)) || Number(a.level !== 'Province') - Number(b.level !== 'Province') || a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code)).map(administrativeCandidate);
}

export function administrativeChildren(parent: Pick<LocationSuggestion, 'id' | 'countryCode' | 'placeType' | 'name'>, query = '', geographic = false): AdministrativeLocationSuggestion[] | null {
  if (parent.countryCode !== 'PH') return null;
  const record = administrativeRecord(parent.id) || data.records.find(record => ['Region','Province'].includes(parent.placeType) && record.level === parent.placeType && names(record).some(name => normalizeDestination(name) === normalizeDestination(parent.name)));
  if (!record && parent.placeType !== 'Country') return null;
  if (record && !['Province', 'Region'].includes(record.level)) return null;
  const normalized = normalizeDestination(query);
  return data.records.filter(item => item.code !== record?.code && (!record || (record.level === 'Province' ? (item.provinceCode === record.code || geographic && item.geographicProvinceCode === record.code) : item.regionCode === record.code)) && (!normalized || names(item).some(n => normalizeDestination(n).includes(normalized)) || normalizeDestination([item.displayName || item.name,byCode.get(item.provinceCode || item.geographicProvinceCode || '')?.name,'Philippines'].filter(Boolean).join(', ')).includes(normalized)))
    .sort((a,b) => (normalized ? Number(names(b).some(n=>normalizeDestination(n)===normalized))-Number(names(a).some(n=>normalizeDestination(n)===normalized)) : parent.placeType === 'Country' ? (geographic ? ['Province','Region','City','Municipality'] : ['City','Region','Province','Municipality']).indexOf(a.level) - (geographic ? ['Province','Region','City','Municipality'] : ['City','Region','Province','Municipality']).indexOf(b.level) : 0) || a.name.localeCompare(b.name,'en') || a.code.localeCompare(b.code)).map(administrativeCandidate);
}

export async function resolveAdministrativeLocation(id: number, countryCode: string, fetcher: typeof fetch = fetch): Promise<LocationSuggestion> {
  const record = countryCode === 'PH' ? administrativeRecord(id) : undefined;
  if (!record) throw Error('Choose a valid official Philippine location.');
  const candidate = administrativeCandidate(record);
  if (candidate.coordinateStatus === 'resolved') return candidate as LocationSuggestion;
  const existing = pending.get(id); if (existing) return existing;
  const task = (async () => {
    const province = byCode.get(record.provinceCode || record.geographicProvinceCode || '')?.name;
    const q = [record.name, province || regionName(record), 'Philippines'].filter(Boolean).join(', ');
    const params = new URLSearchParams({ q, countrycodes: 'ph', format: 'jsonv2', addressdetails: '1', namedetails: '1', extratags: '1', limit: '10', 'accept-language': 'en' });
    const payload = await fetchGeocoderSearch(params, fetcher);
    if (!Array.isArray(payload)) throw Error('The geocoder returned invalid coordinates. Try again.');
    const normalizeName = (name: string) => normalizeDestination(name.replace(/\s*\([^)]*\)\s*$/, '')).replace(/^(city|municipality|province) of /, '').replace(/\b(city|municipality|province)\b/g, '').replace(/\s+/g, ' ').trim();
    const expected = new Set(names(record).map(normalizeName));
    const expectedRegion = new Set(names(byCode.get(record.regionCode)!).map(normalizeName));
    const matches = payload.filter(raw => raw?.address?.country_code === 'ph' && Number.isInteger(raw.osm_id) && raw.osm_id > 0 && ['node','way','relation'].includes(raw.osm_type) && expected.has(normalizeName(raw.name || '')) && (province ? [raw.address.province, raw.address.state_district, raw.address.county, raw.address.state].some(n => typeof n === 'string' && normalizeName(n) === normalizeName(province)) : record.level === 'Region' || [raw.address.region,raw.address.state].some(n => typeof n === 'string' && expectedRegion.has(normalizeName(n)))) && (record.level === 'Province' ? ['province','state_district','county'].includes(raw.addresstype || raw.type) : record.level === 'Region' ? ['state','region'].includes(raw.addresstype || raw.type) : ['city','town','municipality'].includes(raw.addresstype || raw.type)) && Number.isFinite(Number(raw.lat)) && Number.isFinite(Number(raw.lon)) && Math.abs(Number(raw.lat)) <= 90 && Math.abs(Number(raw.lon)) <= 180);
    const unique = [...new Map(matches.map(raw => [`${raw.osm_type}:${raw.osm_id}`, raw])).values()];
    if (unique.length !== 1) throw Error('This official location remains in the catalogue, but its coordinates could not be uniquely verified. Retry or use a more specific verified place search.');
    const raw = unique[0];
    const location = { ...candidate, latitude: Number(raw.lat), longitude: Number(raw.lon), coordinateStatus: 'resolved' as const, coordinateSource: `https://www.openstreetmap.org/${raw.osm_type}/${raw.osm_id}` };
    resolved.set(id, location); rememberResolvedLocation(location); return location;
  })().finally(() => pending.delete(id));
  pending.set(id, task); return task;
}
