import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LocationSuggestion } from './location-search-service.ts';
import { getCountryDataList } from 'countries-list';

type Row = { id: number; name: string; feature: string; country: string; a1: string; a2: string; a3: string; a4: string; latitude: number; longitude: number; parent_id: number | null };
export type LocationPathPart = { id: number; name: string; type: string; countryCode: string; providerId: string; level?: number };
export interface CataloguePage { locations: LocationSuggestion[]; total: number; nextOffset: number | null; coverage: string; message: string }
let database: DatabaseSync | undefined;
let countryAliases: Map<string, Set<string>> | undefined;
const path = process.env.GLOBAL_LOCATION_CATALOGUE_PATH || fileURLToPath(new URL('../../../.cache/global-locations/catalogue.sqlite', import.meta.url));
const normal = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const expression = (s: string) => `"${normal(s).replaceAll('"', '""')}"*`;
function db() { if (!database && existsSync(path)) { database = new DatabaseSync(path, { readOnly: true }); database.exec('PRAGMA cache_size=-8192;'); database.function('normalized', { deterministic: true }, value => normal(String(value))); } return database; }
export const globalCatalogueAvailable = () => !!db();
export function catalogueCountryCode(name: string): string | undefined {
  if (!db() || !normal(name)) return;
  // Canonical country names/ISO codes take precedence over another country's alias.
  const canonical = db()!.prepare('SELECT code FROM countries WHERE normalized(name)=? OR normalized(code)=?').all(normal(name),normal(name));
  if (canonical.length === 1) return String(canonical[0].code);
  const iso3 = getCountryDataList().filter(value => normal(value.iso3) === normal(name));
  if (iso3.length === 1 && country(iso3[0].iso2) && row(country(iso3[0].iso2)!.id,iso3[0].iso2)) return iso3[0].iso2;
  if (!countryAliases) { countryAliases = new Map(); const add = (alias: string, code: string) => { const key = normal(alias), codes = countryAliases!.get(key) || new Set<string>(); codes.add(code); countryAliases!.set(key, codes); }; for (const c of db()!.prepare('SELECT code,name FROM countries').all()) { add(String(c.code),String(c.code)); add(String(c.name),String(c.code)); } const stored=db()!.prepare('SELECT value FROM metadata WHERE key=?').get('country-aliases'); if(stored) for(const [code,aliases] of Object.entries(JSON.parse(String(stored.value)) as Record<string,string[]>)) for(const alias of aliases) add(alias,code); }
  // ISO alpha-3 and native names come from the existing verified country metadata,
  // and are accepted only for country roots present in the imported catalogue.
  const metadata = getCountryDataList().filter(value => [value.iso3,value.name,value.native,...(value.alias || [])].some(alias => alias && normal(alias) === normal(name)));
  for (const {iso2:code} of metadata) if (country(code) && row(country(code)!.id,code)) {
    const key = normal(name), codes = countryAliases.get(key) || new Set<string>(); codes.add(code); countryAliases.set(key,codes);
  }
  const matches = countryAliases.get(normal(name)); return matches?.size === 1 ? [...matches][0] : undefined;
}
export function globalCatalogueCoverage() { const r = db()?.prepare('SELECT value FROM metadata WHERE key=?').get('source'); return r ? JSON.parse(String(r.value)) : null; }
function row(id: number, country?: string): Row | undefined { const r = db()?.prepare('SELECT * FROM places WHERE id=?').get(id) as Row | undefined; return r && (!country || r.country === country) ? r : undefined; }
function country(code: string) { const c=db()?.prepare('SELECT name,id FROM countries WHERE code=?').get(code) as { name: string; id: number } | undefined; return c ? {...c,name:c.name.trim()} : undefined; }
const isCountry = (r: Row) => /^PCL/.test(r.feature) || country(r.country)?.id === r.id;

/** Terminology is source-level specific. Unclassified levels remain explicit rather than guessed from population. */
function type(r: Row): string {
  if (isCountry(r)) return 'Country';
  if (r.feature === 'PPLQ') return 'Abandoned settlement';
  if (r.feature === 'PPLX') return 'District / settlement section';
  if (/^PPL/.test(r.feature)) return /^(PPLC|PPLA)/.test(r.feature) ? 'Administrative seat (populated place)' : 'Populated place (type not supplied)';
  const n = Number(r.feature.slice(3));
  if (r.country === 'KR' && n > 1) return /-gun\b/i.test(r.name) ? 'County (Gun)' : /-si\b/i.test(r.name) ? 'City (Si)' : /-gu\b/i.test(r.name) ? 'District (Gu)' : /-eup\b/i.test(r.name) ? 'Town (Eup)' : /-myeon\b/i.test(r.name) ? 'Township (Myeon)' : /-dong\b/i.test(r.name) ? 'Neighbourhood (Dong)' : `Administrative division (level ${n}; local type not supplied)`;
  if (r.country === 'ID' && n === 2) return /^Kota\b/i.test(r.name) ? 'City (Kota)' : /^Kabupaten\b/i.test(r.name) ? 'Regency (Kabupaten)' : 'Regency / city (local type not supplied)';
  if (r.country === 'ID' && n === 4) return /^Kelurahan\b/i.test(r.name) ? 'Urban village (Kelurahan)' : /^Desa\b/i.test(r.name) ? 'Village (Desa)' : 'Village (local type not supplied)';
  if (r.feature === 'PPLQ') return 'Abandoned settlement';
  if (/^municipality of /i.test(r.name)) return 'Municipality';
  if (/^city of /i.test(r.name)) return 'City';
  if (r.country === 'JP' && n > 1) return /\bgun\b/i.test(r.name) ? 'District (Gun)' : /\bshi\b/i.test(r.name) ? 'City (Shi)' : /\bku\b/i.test(r.name) ? 'Ward (Ku)' : /\b(machi|cho)\b/i.test(r.name) ? 'Town (Machi / Chō)' : /\b(mura|son)\b/i.test(r.name) ? 'Village (Mura / Son)' : 'Municipality (local type not supplied)';
  const levels: Record<string, string[]> = { JP: ['Prefecture', 'Municipality'], US: ['State', 'County / equivalent', 'County subdivision'], FR: ['Region', 'Department', 'Arrondissement', 'Commune'], DE: ['State (Land)', 'Administrative region', 'District (Kreis)', 'Municipality (Gemeinde)'], IT: ['Region', 'Province / metropolitan city', 'Municipality (Comune)'], ES: ['Autonomous community', 'Province', 'Municipality'], ID: ['Province', 'Regency / city', 'District (Kecamatan)', 'Village (Desa / Kelurahan)'], KR: ['Province / metropolitan city (Si / Do)', 'City / county / district (Si / Gun / Gu)', 'Town / township / neighbourhood (Eup / Myeon / Dong)'], PH: ['Region', 'Province', 'City / municipality', 'Barangay'] };
  // Source names can identify the more specific term without making an assumption about an entire level.
  if (r.country === 'US' && n === 2 && /\b(parish|borough|city)\b/i.test(r.name)) return /parish/i.test(r.name) ? 'Parish' : /borough/i.test(r.name) ? 'Borough' : 'Independent city';
  return levels[r.country]?.[n - 1] || (n ? `Administrative division (level ${n}; local type not supplied)` : 'Administrative division (level not supplied)');
}
function ancestors(r: Row): Row[] { const parts: Row[] = [], seen = new Set<number>([r.id]); let parent = r.parent_id; while (parent && parts.length < 8 && !seen.has(parent)) { seen.add(parent); const p = row(parent); if (!p) break; parts.push(p); parent = p.parent_id; } return parts.reverse(); }
export function catalogueLocation(id: number, countryCode?: string): LocationSuggestion | undefined {
  const r = row(id, countryCode); if (!r) return;
  const c = country(r.country), parents = ancestors(r), path = [...parents, r].map(p => ({ id: p.id, providerId: String(p.id), name: isCountry(p) ? country(p.country)?.name || p.name : p.name, type: type(p), countryCode: p.country, ...(/^ADM[1-5]$/.test(p.feature) ? { level: Number(p.feature.at(-1)) } : {}) }));
  const name = isCountry(r) ? c?.name || r.name : r.name;
  const areaParents = parents.filter(p => !isCountry(p));
  const fullNames = [...new Set([name, ...areaParents.reverse().map(p => p.name), c?.name || r.country])];
  const canBrowse = !!db()!.prepare('SELECT 1 FROM places WHERE parent_id=? LIMIT 1').get(r.id);
  const scopeType = isCountry(r) ? 'country' : /^PPL/.test(r.feature) || /^(Municipality|City|Town|Village|Urban village|Commune|Ward|Neighbourhood|Barangay|Township)\b/.test(type(r)) || /^(District \((Kecamatan|Gu)\))/.test(type(r)) ? 'locality' : 'area';
  return { id: r.id, name, region: areaParents.map(p => p.name).join(', '), country: c?.name || r.country, countryCode: r.country, latitude: r.latitude, longitude: r.longitude, label: fullNames.join(', '), placeType: type(r), contextLabel: `${fullNames.join(', ')} — ${type(r)}`, provider: 'geonames', providerId: String(r.id), sourceFeatureCode: r.feature, locationPath: path, parentId: r.parent_id || undefined, canBrowse, scopeType, coordinateSource: `https://www.geonames.org/${r.id}/` };
}
function scope(parent: Row): { clause: string; values: SQLInputValue[] } {
  if (isCountry(parent)) return { clause: 'p.country=? AND p.id<>?', values: [parent.country,parent.id] };
  const depth = /^ADM[1-4]$/.test(parent.feature) ? Number(parent.feature.at(-1)) : 0;
  if (depth) { const codes = [parent.a1, parent.a2, parent.a3, parent.a4].slice(0, depth); if (codes.every(c => c && c !== '00')) return { clause: `p.country=? AND ${codes.map((_, i) => `p.a${i + 1}=?`).join(' AND ')} AND p.id<>?`, values: [parent.country, ...codes, parent.id] }; }
  // Missing administrative codes cannot be guessed. Explicit recorded parent IDs
  // still provide verified membership, including deeper descendants.
  return { clause: 'p.country=? AND p.id IN (WITH RECURSIVE descendants(id,depth) AS (SELECT id,1 FROM places WHERE parent_id=? UNION ALL SELECT child.id,descendants.depth+1 FROM places child JOIN descendants ON child.parent_id=descendants.id WHERE descendants.depth<8) SELECT id FROM descendants)', values: [parent.country,parent.id] };
}
function qualifierIds(value: string, scopedCountry?: string): number[] {
  const countryMatch = db()!.prepare('SELECT id,code FROM countries WHERE lower(code)=? OR lower(name)=?').all(value.toLowerCase(), value.toLowerCase()).filter(r=>!scopedCountry||r.code===scopedCountry).map(r => Number(r.id));
  if (countryMatch.length) return countryMatch;
  const matched = db()!.prepare("SELECT p.id FROM names JOIN places p ON p.id=names.rowid WHERE names MATCH ? AND (p.feature LIKE 'ADM%' OR p.feature LIKE 'PCL%')"+(scopedCountry?' AND p.country=?':'')).all(`"${normal(value)}"`,...(scopedCountry?[scopedCountry]:[])).map(r => Number(r.id));
  return [...new Set([...countryMatch, ...matched])];
}
const memberClause = 'p.id IN (WITH RECURSIVE members(id,depth) AS (SELECT value,0 FROM json_each(?) UNION ALL SELECT child.id,members.depth+1 FROM places child JOIN members ON child.parent_id=members.id WHERE members.depth<8) SELECT id FROM members)';
export function catalogueContainsAny(roots: number[], id: number): boolean { return !!db()?.prepare(`SELECT 1 FROM places p WHERE id=? AND ${memberClause}`).get(id,JSON.stringify(roots)); }
export function searchCatalogue(query: string, offset = 0, parentId?: number, excludeId?: number, memberRoots?: number[], hierarchy = false): CataloguePage | null {
  if (!db()) return null;
  const scopedCountry = parentId ? row(parentId)?.country : undefined;
  const wholeCountry = parentId ? undefined : catalogueCountryCode(query);
  const parts = wholeCountry ? [query] : query.split(',').map(s => s.trim()).filter(Boolean);
  const last = parts.at(-1) || '', words = last.split(/\s+/);
  if (!wholeCountry) for (let start = 0; start < words.length; start++) { const code = catalogueCountryCode(words.slice(start).join(' ')); if (!code || scopedCountry && code!==scopedCountry || parts.length === 1 && start === 0) continue; const remainder = words.slice(0, start).join(' '); parts.pop(); if (remainder) parts.push(remainder); parts.push(country(code)?.name || code); break; }
  const [term = '', ...qualifiers] = parts;
  const values: SQLInputValue[] = [], clauses: string[] = [], from = 'places p';
  clauses.push("NOT (p.country='PH' AND p.feature IN ('ADM1','ADM2','ADM3'))");
  const exactCountryId = wholeCountry ? country(wholeCountry)?.id : undefined;
  if (term) { if (!normal(term)) return { locations: [], total: 0, nextOffset: null, coverage: 'imported-catalogue', message: 'Enter a place name.' }; clauses.push(exactCountryId ? '(p.id IN (SELECT rowid FROM names WHERE names MATCH ?) OR p.id=?)' : 'p.id IN (SELECT rowid FROM names WHERE names MATCH ?)'); values.push(expression(term)); if (exactCountryId) values.push(exactCountryId); }
  if (excludeId !== undefined) { clauses.push('p.id<>?'); values.push(excludeId); }
  if (memberRoots !== undefined) { clauses.push(memberClause); values.push(JSON.stringify(memberRoots)); }
  if (parentId) { const p = row(parentId); if (!p) throw Error('The selected parent area is absent from this catalogue.'); const s = scope(p); clauses.push(s.clause); values.push(...s.values); }
  for (const q of qualifiers) {
    const ids = qualifierIds(q,scopedCountry); if (!ids.length) return { locations: [], total: 0, nextOffset: null, coverage: 'imported-catalogue', message: 'No matching parent-area alias is available. Try verified geocoding.' };
    // Each qualifier must identify an actual ancestor, never just a similarly named city or nearby region.
    const countryOnly = ids.length === 1 && row(ids[0]);
    if (countryOnly && isCountry(countryOnly)) { clauses.push('p.country=?'); values.push(countryOnly.country); }
    else { clauses.push('EXISTS (WITH RECURSIVE ancestors(id,depth) AS (SELECT p.parent_id,1 UNION ALL SELECT ancestor.parent_id,ancestors.depth+1 FROM places ancestor JOIN ancestors ON ancestor.id=ancestors.id WHERE ancestors.depth<8) SELECT 1 FROM ancestors JOIN json_each(?) wanted ON wanted.value=ancestors.id)'); values.push(JSON.stringify(ids)); }
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = Number(db()!.prepare(`SELECT count(*) AS n FROM ${from}${where}`).get(...values)?.n || 0);
  // Countries are identified by their source ID, including local-name aliases. Browsing
  // includes every recorded descendant, with capitals/seats and administrative areas
  // first as suggestions; this ordering never excludes smaller settlements.
  const order = !term && hierarchy ? "CASE WHEN p.feature='ADM1' THEN 0 WHEN p.feature LIKE 'ADM%' AND p.parent_id=? THEN 1 WHEN p.feature='PPLC' THEN 2 ELSE 3 END" : term ? "CASE WHEN p.id=? THEN -1 WHEN p.feature LIKE 'ADM%' AND p.parent_id=? THEN -0.5 WHEN normalized(p.name)=? THEN 0 WHEN p.feature LIKE 'PCL%' THEN 1 WHEN p.feature LIKE 'ADM%' THEN 2 ELSE 3 END" : "CASE WHEN p.feature='PPLC' THEN 0 WHEN p.feature LIKE 'PPLA%' THEN 1 WHEN p.feature='ADM1' THEN 2 WHEN p.feature LIKE 'ADM%' AND p.parent_id=? THEN 3 ELSE 4 END";
  const orderingValues: SQLInputValue[] = term ? [exactCountryId || 0, parentId || 0, normal(term)] : [parentId || 0];
  const rows = db()!.prepare(`SELECT p.id FROM ${from}${where} ORDER BY ${order},p.name,p.id LIMIT 20 OFFSET ?`).all(...values, ...orderingValues, offset);
  return { locations: rows.flatMap(r => { const p = catalogueLocation(Number(r.id)); return p ? [p] : []; }), total, nextOffset: offset + 20 < total ? offset + 20 : null, coverage: 'imported-catalogue', message: 'Searching all imported GeoNames records and local-name aliases. Geographic coverage and source administrative levels vary. Missing places can be checked with verified geocoding.' };
}
export function catalogueContains(parentId: number, id: number): boolean { const parent = row(parentId), child = row(id); if (!parent || !child) return false; const s = scope(parent); return !!db()!.prepare(`SELECT 1 FROM places p WHERE id=? AND (${s.clause})`).get(id, ...s.values); }
export function catalogueAliasMatches(id: number, value: string): boolean { return !!normal(value) && !!db()?.prepare('SELECT 1 FROM names WHERE rowid=? AND names MATCH ?').get(id, `"${normal(value)}"`); }
export function catalogueLabelMatches(id: number, label: string): boolean {
  const r = row(id); if (!r) return false;
  const [name, ...qualifiers] = label.split(',').map(s => s.trim()).filter(Boolean);
  const c = country(r.country), parents = ancestors(r);
  return !!name && catalogueAliasMatches(id, name) && qualifiers.every(q => normal(q) === normal(c?.name || '') || normal(q) === normal(r.country) || parents.some(p => catalogueAliasMatches(p.id, q)));
}
export function catalogueCountry(code: string) { const c = country(code); return c ? catalogueLocation(c.id, code) : undefined; }
export function validateCatalogueSelection(input: { id: number; countryCode: string; providerId?: string; latitude: number; longitude: number; locationPath?: LocationPathPart[] }, label?: string) {
  const selected = catalogueLocation(input.id, input.countryCode);
  if (!selected || input.providerId !== undefined && input.providerId !== selected.providerId || Math.abs(selected.latitude - input.latitude) > 0.000001 || Math.abs(selected.longitude - input.longitude) > 0.000001 || input.locationPath && JSON.stringify(input.locationPath.map(p => p.id)) !== JSON.stringify(selected.locationPath?.map(p => p.id)) || label && !catalogueLabelMatches(input.id, label)) throw Error('The selected location ID, parent path or coordinates do not match the source. Choose the intended location again.');
  return selected;
}

/** Country browsing uses every canonical root, including source aliases; never a city shortlist. */
export function searchCatalogueCountries(query = '', offset = 0): CataloguePage {
  if (!db()) throw Error('The global country catalogue is unavailable. Try destination search.');
  const exact = catalogueCountryCode(query);
  const roots = db()!.prepare('SELECT code,id,name FROM countries ORDER BY name,code').all().filter(c => !!catalogueCountry(String(c.code)));
  const aliasCodes = new Set<string>();
  for (const [alias,codes] of countryAliases || []) if (normal(query) && alias.includes(normal(query))) for (const code of codes) aliasCodes.add(code);
  const matches = roots.filter(c => !normal(query) || normal(String(c.name)).includes(normal(query)) || normal(String(c.code)).includes(normal(query)) || String(c.code) === exact || aliasCodes.has(String(c.code)));
  matches.sort((a,b) => Number(String(b.code) === exact)-Number(String(a.code) === exact));
  return { locations: matches.slice(offset,offset+20).flatMap(c=>{const p=catalogueCountry(String(c.code));return p?[p]:[];}),total:matches.length,nextOffset:offset+20<matches.length?offset+20:null,coverage:'imported-catalogue',message:'Browse countries in the available GeoNames source. Coverage of smaller places varies.' };
}
