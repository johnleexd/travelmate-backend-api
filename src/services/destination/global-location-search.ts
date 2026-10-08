import { countryForQuery, countryDestinations, deduplicateDestinations, searchDestinationIndex } from './destination-index.ts';
import { rankLocationSuggestions, type GeocodingPlace } from './location-search-service.ts';
import { parseDestinationQuery, matchesQualifiers } from './destination-query.ts';
import { cachedResolvedLocations } from './resolved-location-cache.ts';

export async function searchGlobalLocations(query: string, fetchImplementation: typeof fetch = fetch) {
  const wholeCountry = countryForQuery(query.trim());
  if (wholeCountry) return countryDestinations(wholeCountry);
  const parsed = parseDestinationQuery(query);
  const { term, qualifiers, countryCode: code } = parsed;
  const indexed = deduplicateDestinations([...cachedResolvedLocations(term, code), ...searchDestinationIndex(code ? `${term}, ${code}` : term)])
    .filter(place => matchesQualifiers(qualifiers, [place.label, place.region]));
  // The worldwide index handles both country browsing and known direct names
  // immediately. Query the live provider only for names outside the catalogue.
  if (indexed.length) return indexed;
  try {
    // Keep the qualifier together; searching each comma part independently
    // previously mixed a requested city with unrelated country matches.
    const params = new URLSearchParams({ name: term, count: '100', language: 'en', format: 'json', ...(code ? { countryCode: code } : {}) });
    const response = await fetchImplementation(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Geocoding unavailable.');
    const data = await response.json() as { results?: GeocodingPlace[] };
    const places = (data.results || []).filter(place => (!code || place.country_code === code) && matchesQualifiers(qualifiers, [place.admin1, place.admin2, place.admin3, place.admin4, place.country]) && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) && Math.abs(place.latitude) <= 90 && Math.abs(place.longitude) <= 180);
    const ranked = rankLocationSuggestions(term, places, 50);
    const providerCountry = ranked.find(place => place.placeType === 'Country' && place.name.toLowerCase() === query.toLowerCase());
    if (providerCountry) return deduplicateDestinations([...ranked.filter(place => place.countryCode === providerCountry.countryCode), ...countryDestinations(providerCountry.countryCode)]).slice(0, 50);
    return deduplicateDestinations([...indexed, ...ranked]).slice(0, 50);
  } catch {
    if (indexed.length) return indexed;
    throw new Error('Location search is temporarily unavailable.');
  }
}
