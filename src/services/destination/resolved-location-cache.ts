import type { LocationSuggestion } from './location-search-service.ts';
import { normalizeDestination } from './destination-index.ts';
const entries = new Map<string, { location: LocationSuggestion; expires: number }>();
export function rememberResolvedLocation(location: LocationSuggestion) {
  if (entries.size >= 300) entries.delete(entries.keys().next().value!);
  entries.set(`${location.provider || 'geonames'}:${location.providerId || location.id}`, { location, expires: Date.now() + 24 * 3600_000 });
}
export function cachedResolvedLocations(term: string, countryCode?: string) {
  const normalized = normalizeDestination(term);
  for (const [key, entry] of entries) if (entry.expires <= Date.now()) entries.delete(key);
  return [...entries.values()].map(entry => entry.location).filter(place => (!countryCode || place.countryCode === countryCode) && normalizeDestination(place.name).startsWith(normalized));
}
export function resolvedLocationById(id: number, countryCode: string) {
  return cachedResolvedLocations('', countryCode).find(location => location.id === id);
}
