import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { countries, type TCountryCode } from 'countries-list';
import { rankLocationSuggestions, type GeocodingPlace, type LocationSuggestion } from './location-search-service.ts';
import { catalogueLocation, catalogueCountryCode } from './global-catalogue.ts';

type Row = [number, string, number, number, string, string, string, string[], number];
export function normalizeDestination(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const data = JSON.parse(gunzipSync(readFileSync(new URL('../../../data/destinations.json.gz', import.meta.url))).toString('utf8')) as { records: Row[]; fetchedAt: string; source: string };
export const destinationIndexSource = { fetchedAt: data.fetchedAt, sourceUrl: data.source };
const records = data.records.map(row => ({ row, names: [...new Set([row[1], ...row[7]].map(normalizeDestination))] }));
const byCountry = new Map<string, typeof records>();
for (const record of records) { const list = byCountry.get(record.row[5]) || []; list.push(record); byCountry.set(record.row[5], list); }

export function countryForQuery(query: string): string | undefined {
  const full = catalogueCountryCode(query); if (full) return full;
  const name = normalizeDestination(query);
  return Object.entries(countries).find(([code, country]) => [code, country.name, country.native].some(value => normalizeDestination(value) === name))?.[0]
    || records.find(record => /^PCL/.test(record.row[4]) && record.names.includes(name))?.row[5];
}
function place(row: Row): GeocodingPlace {
  return { id: row[0], name: /^PCL/.test(row[4]) ? countries[row[5] as TCountryCode].name : row[1], latitude: row[2], longitude: row[3], feature_code: row[4], country_code: row[5], country: countries[row[5] as TCountryCode].name, admin1: row[6], population: row[8] };
}
export function indexedDestination(id: number, countryCode: string): LocationSuggestion | undefined {
  const full = catalogueLocation(id, countryCode); if (full) return full;
  const record = (byCountry.get(countryCode) || []).find(record => record.row[0] === id);
  return record ? rankLocationSuggestions(place(record.row).name, [place(record.row)], 1)[0] : undefined;
}
export function indexedAdministrativeArea(id: number, countryCode: string): string | undefined {
  const row = (byCountry.get(countryCode) || []).find(record => record.row[0] === id)?.row;
  return row?.[4] === 'ADM1' ? row[6] || row[1] : undefined;
}
export function indexedDestinationNames(id: number, countryCode: string): string[] {
  const names = (byCountry.get(countryCode) || []).find(record => record.row[0] === id)?.names || [];
  const full = catalogueLocation(id, countryCode); return full ? [...names, normalizeDestination(full.name)] : names;
}
export function indexedCities(countryCode: string): Array<LocationSuggestion & { population?: number }> {
  return (byCountry.get(countryCode) || []).filter(record => /^PPL/.test(record.row[4]))
    .sort((a, b) => Number(b.row[4] === 'PPLC') - Number(a.row[4] === 'PPLC') || b.row[8] - a.row[8])
    .flatMap(record => rankLocationSuggestions(place(record.row).name, [place(record.row)], 1).map(location => ({ ...location, ...(record.row[8] > 0 ? { population: record.row[8] } : {}) })));
}
export function deduplicateDestinations(items: LocationSuggestion[]): LocationSuggestion[] {
  const ids = new Set<number>(); const names = new Set<string>();
  return items.filter(item => {
    const key = `${normalizeDestination(item.name)}|${item.countryCode}|${item.placeType === 'Region' ? 'region' : 'place'}|${item.latitude.toFixed(2)}|${item.longitude.toFixed(2)}`;
    if (ids.has(item.id) || names.has(key)) return false;
    ids.add(item.id); names.add(key); return true;
  });
}
export function countryDestinations(code: string, limit = 50): LocationSuggestion[] {
  const all = (byCountry.get(code) || []).map(record => place(record.row));
  const groups = [all.filter(row => /^PCL/.test(row.feature_code || '')), all.filter(row => /^PPL/.test(row.feature_code || '')), all.filter(row => /^ADM/.test(row.feature_code || '')), all.filter(row => !/^(PCL|PPL|ADM)/.test(row.feature_code || ''))];
  const selected: GeocodingPlace[] = [];
  selected.push(...groups[0].splice(0, 1));
  while (selected.length < limit && groups.slice(1).some(group => group.length)) {
    for (const [index, take] of [[1,5], [2,2], [3,2]]) selected.push(...groups[index].splice(0, take));
  }
  return deduplicateDestinations(selected.flatMap(row => rankLocationSuggestions(row.name, [row], 1))).slice(0, limit);
}
export function searchDestinationIndex(query: string, limit = 50): LocationSuggestion[] {
  const [term, qualifier] = query.split(',').map(value => value.trim());
  const code = countryForQuery(term);
  if (code && !qualifier) return countryDestinations(code, limit);
  const countryCode = qualifier ? countryForQuery(qualifier) : undefined;
  const normalized = normalizeDestination(term);
  if (normalized.length < 2) return [];
  const matches = records.filter(record => (!countryCode || record.row[5] === countryCode) && (!qualifier || countryCode || normalizeDestination(record.row[6]) === normalizeDestination(qualifier)) && record.names.some(name => name === normalized || (normalized.length > 2 && name.startsWith(normalized))))
    .sort((a, b) => Number(normalizeDestination(b.row[1]) === normalized) - Number(normalizeDestination(a.row[1]) === normalized) || Number(b.names.includes(normalized)) - Number(a.names.includes(normalized)) || b.row[8] - a.row[8]);
  return deduplicateDestinations(matches.slice(0, limit).flatMap(record => rankLocationSuggestions(place(record.row).name, [place(record.row)], 1)));
}
