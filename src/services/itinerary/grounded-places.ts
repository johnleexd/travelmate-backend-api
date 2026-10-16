import { withProviderCache } from '../cache/provider-cache.ts';
import { reusableWikimediaLicense } from '../../lib/wikimedia-photo-license.ts';
import { nonPhotographicPlaceImage } from '../../lib/place-photo-content.ts';
import type { DestinationAnchor, PlaceEvidence } from './grounding-schema.ts';
import { destinationAnchorSchema, GroundingInputError } from './grounding-schema.ts';
import { searchGlobalLocations } from '../destination/global-location-search.ts';
import { catalogueLocation, validateCatalogueSelection, catalogueAliasMatches } from '../destination/global-catalogue.ts';
import { needsAccommodationArea } from '../destination/location-resolution.ts';
import { hasResolvedCoordinates } from '../destination/location-search-service.ts';
import { administrativeRecord, administrativeLabelMatches, validateAdministrativeSelection } from '../destination/philippine-catalogue.ts';
import { resolveDestination } from '../destination/location-resolution.ts';
import { countries, type TCountryCode } from 'countries-list';
import { MAX_PLACE_DISTANCE_KM, MIN_LOCAL_PLACE_COVERAGE } from './place-search-policy.ts';
import { SUPPORTED_CURRENCIES, hasValidCurrencyPrecision, type CurrencyCode } from '../../schemas/domain.ts';
import { loadPlaceBoundary, containsPlace, corroboratePlaceCoordinate, type PlaceBoundary } from './place-boundaries.ts';
import { verifiedPlaceSnapshot } from './verified-place-snapshots.ts';

type Claim = { rank?: string; mainsnak?: { datavalue?: { value?: any } }; qualifiers?: Record<string, Array<{ datavalue?: { value?: any } }>> };
type Entity = { labels?: Record<string, { value: string }>; aliases?: Record<string, Array<{ value: string }>>; descriptions?: Record<string, { value: string }>; claims?: Record<string, Claim[]> };
export interface GroundedPlace extends PlaceEvidence {
  description: string;
  imageUrl?: string;
  imageAttribution?: { creator: string; license: string; licenseUrl?: string; sourceUrl: string };
  openingWindows?: Array<{ weekdays: number[]; startMinutes: number; endMinutes: number }>;
  admission?: { amount:number; currency:CurrencyCode; sourceUrl:string; fetchedAt:string };
}
export interface PlaceCoverage {
  outcome: 'ready' | 'limited' | 'empty' | 'partial' | 'provider-failure';
  requested: number; articles: number; uniqueCandidates: number; accepted: number;
  providerFailures: number; requests: number; truncated: boolean;
  inScope?: number; nearby?: number;
}
export interface PlaceSearchOptions {
  tripDays?: number;
  forceRefresh?: boolean;
  diagnostics?: (coverage: PlaceCoverage) => void;
}
export const permittedPlaceCandidates = (places: GroundedPlace[], includeNearby = false) => places.filter(place => includeNearby || place.locationScope !== 'nearby');
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const values = (entity: Entity | undefined, property: string): any[] => (entity?.claims?.[property] ?? []).filter(claim => claim.rank !== 'deprecated').flatMap(claim => claim.mainsnak?.datavalue ? [claim.mainsnak.datavalue.value] : []);
const ids = (entity: Entity | undefined, property: string): string[] => values(entity, property).flatMap(value => /^Q\d+$/.test(value?.id) ? [value.id] : []);
/** Present-day membership excludes ended/future relationships, then follows Wikidata's preferred rank. */
function currentRelationshipIds(entity: Entity | undefined, property: 'P131' | 'P17', today = new Date().toISOString().slice(0, 10)): string[] {
  const bound = (value: any, end: boolean) => {
    const match = typeof value?.time === 'string' && value.time.match(/^\+(\d{4})-(\d{2})-(\d{2})T/);
    if (!match) return undefined;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    // Imprecise dates describe a whole year/month, not an invented exact day.
    const m = month || (end ? 12 : 1);
    const d = day || (end ? new Date(Date.UTC(year, m, 0)).getUTCDate() : 1);
    return `${match[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const active = (entity?.claims?.[property] ?? []).filter(claim => {
    if (claim.rank === 'deprecated') return false;
    const starts = (claim.qualifiers?.P580 ?? []).map(snak => bound(snak.datavalue?.value, false));
    const ends = (claim.qualifiers?.P582 ?? []).map(snak => bound(snak.datavalue?.value, true));
    return !starts.some(start => start && start > today) && !ends.some(end => end && end < today);
  });
  const selected = active.some(claim => claim.rank === 'preferred') ? active.filter(claim => claim.rank === 'preferred') : active;
  return selected.flatMap(claim => {
    const id = claim.mainsnak?.datavalue?.value?.id;
    return /^Q\d+$/.test(id) ? [id] : [];
  });
}
const strip = (value: string = '') => value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

// A location coordinate does not make a company, website or whole city a venue.
const physicalAttraction = /\b(?:museum|garden|park|temple|church|mosque|cathedral|basilica|castle|fortress|palace|tower|bridge|monument|beach|market|square|library|gallery|theatre|theater|aquarium|zoo|abbey|monastery|pagoda|hyanggyo|seowon|statue|Buddharupa)(?:s)?\b|\b(?:historic(?:al)? (?:site|building|landmark|ruin|district)|archaeological site|tourist attraction|remarkable tree)\b/i;
const nonVenueType = /\b(?:company|corporation|enterprise|software|application|website|online marketplace|e-commerce|painting|portrait|manuscript|book|document|print|bell|reliquary|collection|woodblock)\b|^(?:capital|city|town|village|municipality|country|province|prefecture|state|region|district|metropolis|megacity|metropolitan area|administrative division|human settlement|populated place)(?:$| of\b| in\b)/i;
export function physicalAttractionDescription(description: string, types: string[]) {
  // Preserve the existing portable-object exclusion even when its label mentions a museum.
  if (types.some(type => /\b(?:painting|portrait|manuscript|book|document|print|bell|reliquary|collection|woodblock)\b/i.test(type))) return '';
  const physicalType = types.find(type => !nonVenueType.test(type) && physicalAttraction.test(type));
  if (types.some(type => nonVenueType.test(type)) && !physicalType) return '';
  return physicalAttraction.test(description) ? description : physicalType ?? '';
}

/** Ambiguous ticket classes, unknown currencies and missing fees stay unpriced. */
export function admissionReference(entity:Entity, entities:Record<string,Entity>, placeId:string, fetchedAt:string):GroundedPlace['admission'] {
  const today=fetchedAt.slice(0,10), active=(entity?.claims?.P2555 || []).filter(claim=>{
    if(claim.rank==='deprecated' || Object.keys(claim.qualifiers || {}).some(key=>!['P580','P582','P585'].includes(key)))return false;
    const bound=(property:string)=>claim.qualifiers?.[property]?.[0]?.datavalue?.value?.time?.slice(1,11);
    const since=bound('P580'),until=bound('P582'),asOf=bound('P585');
    return (!since || since<=today) && (!until || until>=today) && (!asOf || asOf<=today);
  });
  const selected=active.some(claim=>claim.rank==='preferred')?active.filter(claim=>claim.rank==='preferred'):active;
  const fees=selected.flatMap(claim=>{
    const value=claim.mainsnak?.datavalue?.value,amount=Number(value?.amount),id=typeof value?.unit==='string'?value.unit.match(/\/Q\d+$/)?.[0].slice(1):undefined;
    const codes=id?values(entities[id],'P498'):[];
    const currency=codes.length===1 && SUPPORTED_CURRENCIES.includes(codes[0])?codes[0] as CurrencyCode:undefined;
    return currency && Number.isFinite(amount) && amount>=0 && amount<=1_000_000_000 && hasValidCurrencyPrecision(amount,currency)?[{amount,currency,sourceUrl:`https://www.wikidata.org/wiki/${placeId}#P2555`,fetchedAt}]:[];
  });
  const unique=new Map(fees.map(fee=>[`${fee.currency}:${fee.amount}`,fee]));return unique.size===1?[...unique.values()][0]:undefined;
}

export function openingDetails(entity: Entity, entities: Record<string, Entity>) {
  const windows: NonNullable<GroundedPlace['openingWindows']> = [];
  const descriptions: string[] = [];
  const label = (id: unknown) => typeof id === 'string' ? entities[id]?.labels?.en?.value ?? '' : '';
  const minutes = (value: string) => {
    const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return undefined;
    let hour = Number(match[1]); const minute = Number(match[2] ?? 0);
    if (match[3]) { if (hour < 1 || hour > 12) return undefined; hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0); }
    return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
  };
  for (const claim of (entity.claims?.P3025 ?? []).filter(value => value.rank !== 'deprecated')) {
    const days = label(claim.mainsnak?.datavalue?.value?.id);
    const start = label(claim.qualifiers?.P8626?.[0]?.datavalue?.value?.id);
    const end = label(claim.qualifiers?.P8627?.[0]?.datavalue?.value?.id);
    if (days) descriptions.push(`${days}: ${start || 'opening time not available'}–${end || 'closing time not available'}`);
    const weekdays = /^all days of the week$|^every day$/i.test(days) ? [0,1,2,3,4,5,6]
      : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].flatMap((name, index) => days.toLowerCase() === name.toLowerCase() ? [index] : []);
    const startMinutes = minutes(start), endMinutes = minutes(end);
    // Seasonal/holiday/part-specific schedules require confirmation, not guessed interpretation.
    if (weekdays.length && startMinutes !== undefined && endMinutes !== undefined && endMinutes > startMinutes
      && Object.keys(claim.qualifiers ?? {}).every(key => ['P8626','P8627'].includes(key))) windows.push({ weekdays, startMinutes, endMinutes });
  }
  const address = values(entity, 'P6375').find(value => value?.language === 'en')?.text ?? values(entity, 'P6375').find(value => typeof value?.text === 'string')?.text;
  return { openingHours: descriptions.length ? `${windows.length ? '' : 'Opening hours need confirmation. '}${descriptions.join('; ')} (Wikidata reference; seasonal/holiday exceptions and current hours need confirmation)`.slice(0, 1000) : 'Opening hours need confirmation', address: typeof address === 'string' ? address.slice(0, 1000) : 'Not available', openingWindows: windows.length ? windows : undefined };
}

export async function validateDestinationAnchor(destination: string, value: unknown, latitude: unknown, longitude: unknown, fetcher: typeof fetch = fetch) {
  const parsed = destinationAnchorSchema.safeParse(value);
  if (!parsed.success) throw new GroundingInputError('Select a destination city/locality with country and coordinates before generating.');
  const anchor = parsed.data;
  if (latitude !== anchor.latitude || longitude !== anchor.longitude) throw new GroundingInputError('Destination coordinates do not match the selected place.');
  if (!normalized(destination).startsWith(normalized(anchor.city))) throw new GroundingInputError('Destination text does not match the selected city.');
  if (anchor.provider === 'psgc' || anchor.administrativeCode || anchor.id && administrativeRecord(anchor.id)) {
    if (!anchor.id || anchor.countryCode !== 'PH') throw new GroundingInputError('Select the official Philippine location again.');
    let selected;
    try { selected = await validateAdministrativeSelection({ ...anchor, id: anchor.id }, fetcher); }
    catch (error) { throw new GroundingInputError(error instanceof Error ? error.message : 'Choose the intended official location again.'); }
    if (!administrativeLabelMatches(anchor.id, `${anchor.city}, Philippines`) || !administrativeLabelMatches(anchor.id, destination)) throw new GroundingInputError('The selected place name or province does not match its official ID.');
    return { ...anchor, city: selected.name, country: selected.country };
  }
  if (anchor.id && catalogueLocation(anchor.id, anchor.countryCode)) {
    let selected;
    try { selected = validateCatalogueSelection({ ...anchor, id: anchor.id }, destination); } catch (error) { throw new GroundingInputError((error as Error).message); }
    if (needsAccommodationArea(selected) || !catalogueAliasMatches(selected.id, anchor.city)) throw new GroundingInputError('Choose a specific city, municipality, town or village within this administrative area.');
    return { ...anchor, city: selected.name, region: selected.region, country: selected.country, id: selected.id, provider: selected.provider, providerId: selected.providerId, placeType: selected.placeType, sourceFeatureCode: selected.sourceFeatureCode, scopeType: selected.scopeType, locationPath: selected.locationPath, parentId: selected.parentId, canBrowse: selected.canBrowse, coordinateSource: selected.coordinateSource };
  }
  let matches = (await searchGlobalLocations(`${anchor.city}, ${anchor.country}`, fetcher, { includeLegacyDuplicates: true })).filter(hasResolvedCoordinates);
  let match = matches.find(place => normalized(place.name) === normalized(anchor.city) && place.countryCode === anchor.countryCode && distanceKm(place, anchor) < 0.5);
  if (!match) {
    matches = (await resolveDestination(destination, fetcher)).candidates.flatMap(place => hasResolvedCoordinates(place) ? [place] : []);
    match = matches.find(place => normalized(place.name) === normalized(anchor.city) && place.countryCode === anchor.countryCode && distanceKm(place, anchor) < 0.5);
  }
  if (!match || match.placeType === 'Country') throw new GroundingInputError('Choose a specific city/locality from destination search; its country and coordinates could not be validated.');
  return { ...anchor, city: match.name, country: match.country };
}

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearby places retain their real locality, plus signed selected-city/boundary evidence. */
export function placeMatchesAnchor(place: PlaceEvidence, anchor: DestinationAnchor): boolean {
  if (place.countryCode !== anchor.countryCode || normalized(place.country) !== normalized(anchor.country) || distanceKm(place, anchor) > MAX_PLACE_DISTANCE_KM) return false;
  if (place.locationScope === 'nearby') return normalized(place.selectedCity ?? '') === normalized(anchor.city)
    && normalized(place.city) !== normalized(anchor.city) && /^https:\/\/www\.openstreetmap\.org\/(relation|way)\/\d+$/.test(place.membershipSourceUrl ?? '')
    && place.distanceFromDestinationKm !== undefined && Math.abs(place.distanceFromDestinationKm - distanceKm(place, anchor)) < 0.02;
  return normalized(place.city) === normalized(anchor.city);
}

/** Geographic proximity alone never proves city/country identity. */
export function entityBelongsToDestination(id: string, entities: Record<string, Entity>, anchor: DestinationAnchor): boolean {
  let frontier = [id];
  const visited = new Set<string>();
  let cityMatch = false, countryMatch = false, conflictingCountry = false;
  for (let depth = 0; depth <= 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      if (visited.has(current)) continue;
      visited.add(current);
      const entity = entities[current];
      const names = [entity?.labels?.en?.value ?? '', ...(entity?.aliases?.en ?? []).map(alias => alias.value)];
      if (depth > 0 && names.some(name => normalized(name) === normalized(anchor.city))) cityMatch = true;
      for (const country of currentRelationshipIds(entity, 'P17')) {
        const codes = values(entities[country], 'P297');
        if (codes.includes(anchor.countryCode)) countryMatch = true;
        else if (codes.length) conflictingCountry = true;
      }
      next.push(...currentRelationshipIds(entity, 'P131'));
    }
    frontier = next;
  }
  return cityMatch && countryMatch && !conflictingCountry;
}

function conflictingCountry(id: string, entities: Record<string, Entity>, countryCode: string): boolean {
  let frontier = [id]; const seen = new Set<string>();
  for (let depth = 0; depth <= 4; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      if (seen.has(current)) continue;
      seen.add(current);
      if (currentRelationshipIds(entities[current], 'P17').some(country => values(entities[country], 'P297').some(code => code !== countryCode))) return true;
      next.push(...currentRelationshipIds(entities[current], 'P131'));
    }
    frontier = next;
  }
  return false;
}

export async function retrieveGroundedPlaces(anchor: DestinationAnchor, fetcher: typeof fetch = fetch, signal?: AbortSignal, includePhotos = true, options: PlaceSearchOptions = {}): Promise<GroundedPlace[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  const boundedFetcher: typeof fetch = (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal });
  const requested = Math.max(MIN_LOCAL_PLACE_COVERAGE, Math.min(31, Math.max(1, options.tripDays ?? 1)) * 3);
  let discoveryRequests = 0, rawArticles = 0, providerFailures = 0, truncated = false;
  const throttledHosts = new Set<string>();
  const json = async (host: string, parameters: Record<string, string>, photoSignal?: AbortSignal) => {
    if (throttledHosts.has(host)) throw new Error('Provider rate limit: retry on a later lookup.');
    const started = Date.now();
    const response = await fetcher(`${host}/w/api.php?${new URLSearchParams({ format: 'json', ...parameters })}`, {
      headers: { 'User-Agent': 'TravelMate/1.0 (destination reference lookup)', 'Api-User-Agent': 'TravelMate/1.0' }, signal: photoSignal || requestSignal,
    });
    console.info(JSON.stringify({ event: 'place_reference_request', provider: host, action: parameters.action, generator: parameters.generator, status: response.status, durationMs: Date.now() - started }));
    if (response.status === 429) throttledHosts.add(host);
    if (!response.ok) throw new Error(`Destination reference provider unavailable (HTTP ${response.status}).`);
    const result = await response.json() as any;
    if (result.error) throw new Error(`Destination reference provider rejected the lookup (${String(result.error.code).slice(0, 80)}).`);
    return result;
  };
  const entities: Record<string, Entity> = {};
  const pages: Array<{ title: string; pageid: number; coordinates?: Array<{ lat: number; lon: number }>; pageprops?: { wikibase_item?: string } }> = [];
  let discoveryFailed = false;
  const addPages = (data: any) => {
    for (const page of Object.values(data.query?.pages ?? {}) as typeof pages) {
      rawArticles++;
      const existing = pages.find(other => page.pageprops?.wikibase_item ? other.pageprops?.wikibase_item === page.pageprops.wikibase_item : other.title === page.title);
      if (existing) {
        if (!existing.coordinates?.length && page.coordinates?.length) existing.coordinates = page.coordinates;
        if (!existing.pageprops?.wikibase_item && page.pageprops?.wikibase_item) existing.pageprops = page.pageprops;
      } else if (pages.length < 1500) pages.push(page);
      else truncated = true;
    }
  };
  // Follow property and generator continuation together. Both can be present.
  const discover = async (host: string, parameters: Record<string, string>) => {
    let continuation: Record<string, string> = {};
    const seen = new Set<string>();
    for (let page = 0; page < 3 && discoveryRequests < 16; page++) {
      discoveryRequests++;
      try {
        const data = await json(host, { ...parameters, ...continuation });
        addPages(data);
        if (!data.continue) return;
        continuation = Object.fromEntries(Object.entries(data.continue).map(([key, value]) => [key, String(value)]));
        const identity = JSON.stringify(continuation);
        if (seen.has(identity)) { truncated = true; return; }
        seen.add(identity);
      } catch (error) {
        discoveryFailed = true; providerFailures++;
        console.warn(JSON.stringify({ event: 'place_discovery_failure', provider: new URL(host).host, generator: parameters.generator, error: error instanceof Error ? error.name : 'RequestError' }));
        return;
      }
    }
    truncated = true;
  };
  await discover('https://en.wikipedia.org', {
    action: 'query', generator: 'geosearch', ggscoord: `${anchor.latitude}|${anchor.longitude}`, ggsradius: '10000', ggslimit: '500', ggsnamespace: '0',
    // Coordinates otherwise defaults to ten results, even when the generator returns many more pages.
    prop: 'coordinates|pageprops', coprimary: 'primary', colimit: 'max', ppprop: 'wikibase_item',
  });
  const attemptedEntities = new Set<string>();
  const hydrate = async () => {
    let frontier = pages.flatMap(page => /^Q\d+$/.test(page.pageprops?.wikibase_item ?? '') ? [page.pageprops!.wikibase_item!] : []);
    const visited = new Set<string>();
    for (let depth = 0; depth <= 5 && frontier.length; depth++) {
      const current = [...new Set(frontier)].filter(id => !visited.has(id));
      current.forEach(id => visited.add(id));
      const missing = current.filter(id => !entities[id] && !attemptedEntities.has(id));
      // A single request at a time avoids bursting the public reference API.
      // Failed IDs are not fetched again for every additional category query.
      for (let offset = 0; offset < missing.length; offset += 50) {
        const batch = missing.slice(offset, offset + 50);
        batch.forEach(id => attemptedEntities.add(id));
        try { Object.assign(entities, (await json('https://www.wikidata.org', { action: 'wbgetentities', ids: batch.join('|'), props: 'labels|aliases|descriptions|claims', languages: 'en' })).entities ?? {}); }
        catch { discoveryFailed = true; providerFailures++; }
      }
      frontier = current.flatMap(id => [...(entities[id]?.claims?.P2555 ?? []).flatMap(claim=>{const unit=claim.mainsnak?.datavalue?.value?.unit;const match=typeof unit==='string'?unit.match(/Q\d+$/):undefined;return match?[match[0]]:[];}), ...currentRelationshipIds(entities[id], 'P131'), ...currentRelationshipIds(entities[id], 'P17'), ...(depth === 0 ? ids(entities[id], 'P31') : []), ...ids(entities[id], 'P3025'), ...(entities[id]?.claims?.P3025 ?? []).flatMap(claim => Object.values(claim.qualifiers ?? {}).flatMap(snaks => snaks.flatMap(snak => /^Q\d+$/.test(snak.datavalue?.value?.id) ? [snak.datavalue!.value.id] : [])))]);
    }
  };
  await hydrate();
  const fetchedAt = new Date().toISOString();
  const rejected = new Map<string, string>();
  const boundaries: PlaceBoundary[] = [];
  const coordinateEvidence = new Map<string, { sourceUrl: string; city?: string }>();
  const siteDescription = (entity: Entity | undefined) => {
    const description = entity?.descriptions?.en?.value ?? '';
    const types = ids(entity, 'P31').map(type => entities[type]?.labels?.en?.value ?? '').filter(Boolean);
    return physicalAttractionDescription(description, types);
  };
  const collect = () => pages.flatMap(page => {
    const id = page.pageprops?.wikibase_item;
    const point = page.coordinates?.[0];
    const reject = (reason: string) => { rejected.set(id ?? page.title, reason); return []; };
    if (!id || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) return reject('missing-id-or-invalid-coordinates');
    const coordinate = { latitude: point.lat, longitude: point.lon };
    const entity = entities[id];
    const description = siteDescription(entity);
    if (distanceKm(anchor, coordinate) > MAX_PLACE_DISTANCE_KM) return reject('outside-supported-radius');
    if (!description) return reject('not-a-supported-attraction');
    if (/former|demolished|destroyed|proposed|defunct|no longer exists/i.test(entity?.descriptions?.en?.value ?? description) || values(entity, 'P576').length) return reject('no-longer-existing-or-proposed');
    if (conflictingCountry(id, entities, anchor.countryCode)) return reject('conflicting-country-evidence');
    const referencePoints = values(entity, 'P625').filter(value => Number.isFinite(value?.latitude) && Number.isFinite(value?.longitude) && value?.globe?.endsWith('/Q2'));
    const corroboration = coordinateEvidence.get(id);
    if (referencePoints.length && !referencePoints.some(point => distanceKm(coordinate, point) < 1) && !corroboration) return reject('conflicting-coordinate-evidence');
    const boundary = boundaries.find(candidate => containsPlace(candidate, coordinate));
    const local = entityBelongsToDestination(id, entities, anchor);
    const selectedBoundary = boundaries.find(candidate => candidate.city === anchor.city);
    // A named municipality is optional for a nearby site, but country and precise
    // coordinates must agree across sources and the city polygon must exclude it.
    const countryVerified = currentRelationshipIds(entity, 'P17').some(country => values(entities[country], 'P297').includes(anchor.countryCode));
    const corroboratedNearby = !boundary && selectedBoundary && !containsPlace(selectedBoundary, coordinate) && (countryVerified || corroboration)
      && (corroboration || referencePoints.some(point => Number.isFinite(point.precision) && point.precision <= 0.001 && distanceKm(coordinate, point) < 0.25));
    if (!local && !boundary && !corroboratedNearby) return reject('city-or-country-membership-unverified');
    if (local && boundaries[0]?.city === anchor.city && !containsPlace(boundaries[0], coordinate)) return reject('conflicting-city-boundary-evidence');
    // A district polygon inside the selected city must not relabel a place
    // whose administrative ancestry already verifies that selected city.
    const city = local ? anchor.city : boundary?.city ?? (corroboratedNearby ? corroboration?.city ?? 'Locality unconfirmed' : anchor.city);
    const locationScope = city === anchor.city ? 'city' as const : 'nearby' as const;
    rejected.delete(id);
    const name = entity.labels?.en?.value || page.title;
    return [{ provider: 'wikidata' as const, placeId: id, name, description: description.slice(0, 600), ...coordinate,
      city, country: anchor.country, countryCode: anchor.countryCode,
      ...(boundary || corroboratedNearby ? { locationScope, selectedCity: anchor.city, distanceFromDestinationKm: Math.round(distanceKm(anchor, coordinate) * 100) / 100, membershipSourceUrl: (boundary ?? selectedBoundary)!.sourceUrl } : {}),
      ...(corroboration ? { coordinateSourceUrl: corroboration.sourceUrl } : {}),
      ...(admissionReference(entity,entities,id,fetchedAt) ? { admission: admissionReference(entity,entities,id,fetchedAt) } : {}), sourceUrl: `https://www.wikidata.org/wiki/${id}`, fetchedAt, ...openingDetails(entity, entities),
      file: values(entity, 'P18').find(value => typeof value === 'string') as string | undefined }];
  });
  let places = collect();
  if (places.length < requested) {
    // GeoSearch's 10 km maximum and English-only coverage can omit local attractions.
    // CirrusSearch is bounded to 30 km; every result still passes the same membership checks.
    const languages = ['en', ...(countries[anchor.countryCode as TCountryCode]?.languages ?? []).filter(language => /^[a-z]{2,3}$/.test(language) && language !== 'en').slice(0, 2)];
    for (const language of languages) {
      await discover(`https://${language}.wikipedia.org`, { action: 'query', generator: 'search', gsrsearch: `nearcoord:${MAX_PLACE_DISTANCE_KM}km,${anchor.latitude},${anchor.longitude}`, gsrlimit: '100', gsrnamespace: '0', prop: 'coordinates|pageprops', coprimary: 'primary', colimit: 'max', ppprop: 'wikibase_item' });
    }
    await hydrate();
    places = collect();
  }
  if (places.length < requested) {
    // Category searches can retrieve relevant records beyond a crowded first page.
    for (const categories of ['museum OR gallery OR library OR monument', 'park OR garden OR market OR square', 'temple OR mosque OR church OR castle OR palace OR fortress']) {
      await discover('https://en.wikipedia.org', { action: 'query', generator: 'search', gsrsearch: `nearcoord:${MAX_PLACE_DISTANCE_KM}km,${anchor.latitude},${anchor.longitude} (${categories})`, gsrlimit: '100', gsrnamespace: '0', prop: 'coordinates|pageprops', coprimary: 'primary', colimit: 'max', ppprop: 'wikibase_item' });
      if (discoveryRequests >= 16) break;
    }
    await hydrate();
    places = collect();
  }
  // Resolve missing administrative chains using one selected-city polygon, not radius alone.
  if (pages.some(page => siteDescription(entities[page.pageprops?.wikibase_item ?? '']) && !entityBelongsToDestination(page.pageprops?.wikibase_item ?? '', entities, anchor))) {
    const selected = await loadPlaceBoundary(anchor, boundedFetcher);
    if (selected) boundaries.push(selected);
    // Bound the extra requests to six evidenced neighboring municipalities, never provinces.
    const candidates = new Map<string, number>();
    for (const page of pages) {
      const entity = entities[page.pageprops?.wikibase_item ?? ''];
      const point = page.coordinates?.[0];
      if (!siteDescription(entity) || !point || distanceKm(anchor, { latitude: point.lat, longitude: point.lon }) > MAX_PLACE_DISTANCE_KM) continue;
      for (const id of currentRelationshipIds(entity, 'P131')) {
        const admin = entities[id], name = admin?.labels?.en?.value;
        if (name && normalized(name) !== normalized(anchor.city) && /city|county|town|municipality|district|administrative division/i.test(`${name} ${admin?.descriptions?.en?.value ?? ''}`)
          && !/^(?:province|state|region)\b/i.test(admin?.descriptions?.en?.value ?? '') && !/\b(?:province|state|region)\b/i.test(name) && values(admin, 'P625').length) candidates.set(id, (candidates.get(id) ?? 0) + 1);
      }
    }
    for (const [id] of [...candidates].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      const admin = entities[id], point = values(admin, 'P625')[0];
      const boundary = await loadPlaceBoundary({ ...anchor, city: admin.labels!.en!.value, latitude: point.latitude, longitude: point.longitude }, boundedFetcher, id);
      if (boundary) boundaries.push(boundary);
    }
    places = collect();
  }
  // A bounded exact-venue lookup can resolve missing/conflicting metadata. It
  // never accepts a geocoder's unrelated result or changes the source coordinate.
  const checked = new Set<string>();
  for (const page of pages) {
    const id = page.pageprops?.wikibase_item, point = page.coordinates?.[0];
    if (!id || !point || checked.has(id) || checked.size >= 8 || !['conflicting-coordinate-evidence', 'city-or-country-membership-unverified'].includes(rejected.get(id) ?? '')) continue;
    checked.add(id);
    const result = await corroboratePlaceCoordinate(entities[id]?.labels?.en?.value || page.title, id, { latitude: point.lat, longitude: point.lon }, anchor, boundedFetcher);
    if (result) coordinateEvidence.set(id, result);
  }
  if (coordinateEvidence.size) places = collect();
  // Merge a component only when the source explicitly links it to a catalog site.
  // Proximity alone must not discard an independently referenced attraction.
  const complexes = places.filter(place => /temple|castle|palace|museum|park|garden/i.test(place.description));
  places = places.filter(place => {
    const parents = [...ids(entities[place.placeId], 'P361'), ...ids(entities[place.placeId], 'P276')];
    const parent = complexes.find(candidate => candidate.placeId !== place.placeId && parents.includes(candidate.placeId));
    if (!parent) return true;
    rejected.set(place.placeId, `part-of-visit:${parent.placeId}`); return false;
  });
    const accepted = new Set(places.map(place => place.placeId)).size;
  const inScope = permittedPlaceCandidates(places).length;
  const coverage: PlaceCoverage = { outcome: discoveryFailed ? accepted ? 'partial' : 'provider-failure' : !accepted ? 'empty' : inScope < requested ? 'limited' : 'ready', requested, articles: rawArticles, uniqueCandidates: pages.length, accepted, inScope, nearby: accepted - inScope, providerFailures, requests: discoveryRequests, truncated };
  options.diagnostics?.(coverage);
  console.info(JSON.stringify({ event: 'place_catalog_validation', city: anchor.city, countryCode: anchor.countryCode, ...coverage, rejected: [...rejected].map(([placeId, reason]) => ({ placeId, reason })), discoveryFailed }));
  if (!places.length && discoveryFailed) throw new Error('Place discovery was incomplete because a provider request failed.');
  if (!includePhotos) {
    const seen = new Set<string>();
    return places.filter(place => !seen.has(place.placeId) && !!seen.add(place.placeId)).map(({ file: _file, ...place }) => place);
  }
  const files = [...new Set(places.flatMap(place => place.file ? [`File:${place.file}`] : []))];
  const images = new Map<string, { imageUrl: string; imageAttribution: GroundedPlace['imageAttribution'] }>();
  const photoRejected: Array<{ file: string; reason: string }> = [];
  if (files.length) {
    try {
      const photoSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(7000)]);
      for (let offset = 0; offset < files.length; offset += 50) {
        const data = await json('https://commons.wikimedia.org', { action: 'query', titles: files.slice(offset, offset + 50).join('|'), prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1200' }, photoSignal);
        for (const page of Object.values(data.query?.pages ?? {}) as any[]) {
          const info = page.imageinfo?.[0];
          const metadata = info?.extmetadata ?? {};
          const license = strip(metadata.LicenseShortName?.value);
          const licenseUrl = reusableWikimediaLicense(license, metadata.LicenseUrl?.value);
          const creator = strip(metadata.Artist?.value);
          const imageUrl = info?.thumburl || info?.url;
          // No unattributed images, local artwork, maps, or AI illustrations.
          const reason = !info ? 'missing-imageinfo' : !creator || creator.length > 200 ? 'missing-or-oversized-creator' : !licenseUrl || metadata.Restrictions?.value?.trim() || /^(true|1)$/i.test(metadata.NonFree?.value || '') ? 'unsupported-license'
            : !/^image\/(jpeg|png|webp|avif)$/.test(info?.mime ?? '') ? 'unsupported-image-format'
            : !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(imageUrl ?? '') ? 'invalid-image-host'
            : nonPhotographicPlaceImage(`${page.title} ${strip(metadata.ImageDescription?.value)} ${strip(metadata.ObjectName?.value)} ${strip(metadata.Categories?.value)} ${strip(metadata.Medium?.value)}`, creator) ? 'non-photographic-content' : undefined;
          if (reason) { photoRejected.push({ file: page.title, reason }); continue; }
          images.set(page.title.replaceAll('_', ' ').normalize('NFC'), { imageUrl, imageAttribution: { creator, license, licenseUrl: licenseUrl!,
            sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}` } });
        }
      }
    } catch (error) { console.warn('[TravelMate places] Exact-place photo metadata failed:', error instanceof Error ? error.message : 'Request failed'); }
  }
  console.info(JSON.stringify({ event: 'place_photo_mapping', city: anchor.city, requestedFiles: files.length, acceptedFiles: images.size, rejected: photoRejected,
    placesWithoutP18: [...new Set(places.filter(place => !place.file).map(place => place.placeId))] }));
  const used = new Set<string>(), idsSeen = new Set<string>();
  return places.filter(place => !idsSeen.has(place.placeId) && !!idsSeen.add(place.placeId)).map(({ file, ...place }) => {
    const image = file ? images.get(`File:${file}`.replaceAll('_', ' ').normalize('NFC')) : undefined;
    if (!image || used.has(image.imageUrl)) return place;
    used.add(image.imageUrl);
    return { ...place, ...image };
  });
}

export async function loadGroundedPlaces(anchor: DestinationAnchor, signal?: AbortSignal, includePhotos = true, options: PlaceSearchOptions = {}) {
  const target = Math.max(MIN_LOCAL_PLACE_COVERAGE, Math.min(31, Math.max(1, options.tripDays ?? 1)) * 3);
  const key = `grounded-places:v12:${includePhotos ? 'photos' : 'places'}:${anchor.countryCode}:${normalized(anchor.city)}:${anchor.latitude.toFixed(5)}:${anchor.longitude.toFixed(5)}:${target}`;
  try {
    const result = await withProviderCache(key, { source: 'activities', freshForMs: 6 * 3600000, staleForMs: 24 * 3600000, emptyForMs: 60_000,
      isEmpty: value => { const entry = value as { coverage: PlaceCoverage }; return entry.coverage.accepted === 0 || entry.coverage.providerFailures > 0; } }, async () => {
      let coverage: PlaceCoverage | undefined;
      const places = await retrieveGroundedPlaces(anchor, fetch, signal, includePhotos, { ...options, diagnostics: value => { coverage = value; options.diagnostics?.(value); } });
      return { places, coverage: coverage! };
    }, Date.now(), options.forceRefresh);
    console.info(JSON.stringify({ event: 'place_catalog_cache', city: anchor.city, status: result.freshness.status, ...result.value.coverage }));
    const snapshot = verifiedPlaceSnapshot(anchor);
    const knownIds = new Set(result.value.places.map(place => place.placeId));
    const combined = [...result.value.places, ...snapshot.filter(place => !knownIds.has(place.placeId))];
    if (result.value.places.length < target && combined.length > result.value.places.length) {
      console.info(JSON.stringify({ event: 'place_catalog_reviewed_supplement', city: anchor.city, countryCode: anchor.countryCode, live: result.value.places.length, reviewed: combined.length - result.value.places.length, accepted: combined.length, requested: target }));
      return { places: combined, status: 'stale-cache' as const, coverage: { ...result.value.coverage, outcome: combined.length >= target ? 'ready' as const : 'limited' as const, uniqueCandidates: Math.max(result.value.coverage.uniqueCandidates, combined.length), accepted: combined.length, inScope: combined.length, nearby: 0 } };
    }
    return { ...result.value, status: result.freshness.status };
  } catch {
    const snapshot = verifiedPlaceSnapshot(anchor);
    if (snapshot.length) {
      console.info(JSON.stringify({ event: 'place_catalog_reviewed_fallback', city: anchor.city, countryCode: anchor.countryCode, accepted: snapshot.length, requested: target }));
      return { places: snapshot, status: 'stale-cache' as const, coverage: { outcome: snapshot.length >= target ? 'ready' as const : 'limited' as const, requested: target, articles: snapshot.length, uniqueCandidates: snapshot.length, accepted: snapshot.length, inScope: snapshot.length, nearby: 0, providerFailures: 1, requests: 0, truncated: false } };
    }
    return { places: [] as GroundedPlace[], status: 'unavailable' as const, coverage: { outcome: 'provider-failure' as const, requested: target, articles: 0, uniqueCandidates: 0, accepted: 0, providerFailures: 1, requests: 0, truncated: false } };
  }
}
