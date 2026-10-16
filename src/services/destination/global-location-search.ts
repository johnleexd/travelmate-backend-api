import { countryForQuery, countryDestinations, deduplicateDestinations, searchDestinationIndex, availableCountry } from './destination-index.ts';
import { rankLocationSuggestions, type GeocodingPlace, type LocationCandidate } from './location-search-service.ts';
import { searchPhilippineCatalogue, philippineAdministrativeRecords, administrativeCandidate } from './philippine-catalogue.ts';
import { parseDestinationQuery, matchesQualifiers } from './destination-query.ts';
import { cachedResolvedLocations } from './resolved-location-cache.ts';
import { createAreaCache } from './area-cache.ts';
import { searchCatalogue, catalogueLocation } from './global-catalogue.ts';
import { searchDestinationAreas } from './destination-areas.ts';

export interface LocationSearchPage { locations: LocationCandidate[]; total: number; nextOffset: number | null; coverage: string; message: string; countryScope?: LocationCandidate }
interface LegacySearchOptions { includeLegacyDuplicates?: boolean; preferBundledExact?: boolean }
export async function searchGlobalLocationsPage(query: string, offset = 0, fetcher: typeof fetch = fetch, countryCode?: string): Promise<LocationSearchPage> {
  const code = countryForQuery(query), exactCountry = code ? availableCountry(code) : undefined;
  const country = exactCountry || (countryCode ? availableCountry(countryCode) : undefined);
  if (countryCode && !country) throw Error('Choose a verified country before searching within it.');
  if (country) {
    // Exact country names/aliases request its contents, rather than name matches worldwide.
    // Subsequent text searches use the same verified root and full paged source.
    const includeCountry = Boolean(exactCountry) || !query.trim();
    const prefix = includeCountry ? 1 : 0;
    const page = await searchDestinationAreas(country, exactCountry ? '' : query, Math.max(0, offset - prefix), fetcher);
    const locations = [...(includeCountry && offset === 0 ? [country] : []), ...page.areas].slice(0,20);
    const total = prefix + page.total;
    return { locations, total, nextOffset: offset + 20 < total ? offset + 20 : null, coverage: page.coverage || 'partial-provider', message: page.message, countryScope: country };
  }
  const official = searchPhilippineCatalogue(query);
  const natural: LocationCandidate[] = searchDestinationIndex(query).filter(p=>!catalogueLocation(p.id,p.countryCode) && ['Island','Mountain','Park or nature reserve','Beach','Lake','Waterfall','Canyon'].includes(p.placeType)).map(p=>({...p,provider:'geonames' as const,providerId:String(p.id),scopeType:'natural' as const}));
  const page = searchCatalogue(query, Math.max(0, offset - official.length));
  if (!page) { const locations = await searchLegacyLocations(query, fetcher); return { locations: locations.slice(offset, offset + 20), total: locations.length, nextOffset: offset + 20 < locations.length ? offset + 20 : null, coverage: 'partial-provider', message: 'The full GeoNames catalogue is unavailable. These limited provider results are not complete coverage. Use verified geocoding for missing places.' }; }
  const locations = [...official.slice(offset, offset + 20), ...page.locations, ...(offset + 20 > official.length + page.total ? natural.slice(Math.max(0,offset-official.length-page.total)) : [])].slice(0, 20);
  const total = official.length + page.total + natural.length;
  return { ...page, locations, total, nextOffset: offset + 20 < total ? offset + 20 : null };
}

const providerCaches = new WeakMap<typeof fetch, ReturnType<typeof createAreaCache<GeocodingPlace[]>>>();
function providerCache(fetcher: typeof fetch) { let cache = providerCaches.get(fetcher); if (!cache) { cache = createAreaCache<GeocodingPlace[]>(300); providerCaches.set(fetcher, cache); } return cache; }

export async function searchGlobalLocations(query: string, fetchImplementation: typeof fetch = fetch, options: LegacySearchOptions = {}): Promise<LocationCandidate[]> {
  // Compatibility adapter for photo/legacy resolver callers. Interactive search uses the paged full-catalogue API above.
  return searchLegacyLocations(query, fetchImplementation, options);
}
async function searchLegacyLocations(query: string, fetchImplementation: typeof fetch = fetch, options: LegacySearchOptions = {}): Promise<LocationCandidate[]> {
  const wholeCountry = countryForQuery(query.trim());
  if (wholeCountry) return wholeCountry === 'PH' ? [...countryDestinations('PH').filter(place => !/capital|locality|region/i.test(place.placeType)), ...philippineAdministrativeRecords.filter(record => ['Province','Region','City'].includes(record.level)).map(administrativeCandidate)] : countryDestinations(wholeCountry);
  const parsed = parseDestinationQuery(query);
  const { term, qualifiers, countryCode: code } = parsed;
  const indexed = deduplicateDestinations([...cachedResolvedLocations(term, code), ...searchDestinationIndex(code ? `${term}, ${code}` : term)])
    .filter(place => matchesQualifiers(qualifiers, [place.label, place.region]));
  const official = searchPhilippineCatalogue(query);
  if (official.length) {
    const clean = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(city|province|municipality) of /, '').replace(/\b(city|province|municipality)\b/g, '').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    const retained = options.includeLegacyDuplicates ? indexed : indexed.filter(place => place.countryCode !== 'PH' || !/capital|locality|region/i.test(place.placeType) || !official.some(candidate => clean(candidate.name) === clean(place.name)));
    return [...official, ...retained.filter(place => !official.some(candidate => candidate.id === place.id))];
  }
  // Search the full available provider even when a curated indexed match exists.
  try {
    // Keep the qualifier together; searching each comma part independently
    // previously mixed a requested city with unrelated country matches.
    const params = new URLSearchParams({ name: term, count: '100', language: 'en', format: 'json', ...(code ? { countryCode: code } : {}) });
    const rows = await providerCache(fetchImplementation).get(params.toString(), async () => {
      const response = await fetchImplementation(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Geocoding unavailable (${response.status}).`);
      const data = await response.json() as { results?: GeocodingPlace[] };
      return data.results || [];
    });
    const places = rows.filter(place => (!code || place.country_code === code) && matchesQualifiers(qualifiers, [place.admin1, place.admin2, place.admin3, place.admin4, place.country]) && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) && Math.abs(place.latitude) <= 90 && Math.abs(place.longitude) <= 180);
    const ranked = rankLocationSuggestions(term, places, 50);
    const providerCountry = ranked.find(place => place.placeType === 'Country' && place.name.toLowerCase() === query.toLowerCase());
    if (providerCountry) return deduplicateDestinations([...ranked.filter(place => place.countryCode === providerCountry.countryCode), ...countryDestinations(providerCountry.countryCode)]).slice(0, 50);
    // Identity-sensitive callers can use the bundled GeoNames snapshot for
    // exact-name matches while retaining live results for names absent there.
    // This prevents a provider's distant same-name row from making a known
    // destination ambiguous when its verified bundled record is available.
    const exactIndexed = indexed.filter(place => normalizePlaceName(place.name) === normalizePlaceName(term));
    const live = options.preferBundledExact && exactIndexed.length
      ? ranked.filter(place => normalizePlaceName(place.name) !== normalizePlaceName(term))
      : ranked;
    return deduplicateDestinations([...indexed, ...live]).slice(0, 50);
  } catch {
    if (indexed.length) return indexed;
    throw new Error('Location search is temporarily unavailable.');
  }
}

const normalizePlaceName = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
