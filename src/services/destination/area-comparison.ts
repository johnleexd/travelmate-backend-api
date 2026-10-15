import { createAreaCache } from './area-cache.ts';
import { validatedAreaCities } from './destination-areas.ts';
import type { LocationSuggestion, LocationCandidate } from './location-search-service.ts';

export interface AreaInterestProfile {
  cityId: number;
  foodPlaces: number;
  culturePlaces: number;
  naturePlaces: number;
}
export interface AreaComparisonResponse {
  parentId: number;
  countryCode: string;
  profiles: AreaInterestProfile[];
  fetchedAt: string;
  expiresAt: string;
  sourceUrl: string;
  radiusKm: number;
  disclaimer: string;
}
const cache = createAreaCache<AreaComparisonResponse>(100, 6 * 60 * 60_000);
function distance(latitude: number, longitude: number, city: LocationSuggestion) {
  const rad = Math.PI / 180;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin((latitude - city.latitude) * rad / 2) ** 2 + Math.cos(latitude * rad) * Math.cos(city.latitude * rad) * Math.sin((longitude - city.longitude) * rad / 2) ** 2));
}

export async function compareDestinationAreas(parent: LocationCandidate, ids: number[], fetcher: typeof fetch = fetch, hierarchy = false): Promise<AreaComparisonResponse> {
  const cities = await validatedAreaCities(parent, ids, fetcher, hierarchy);
  if (!ids.length || ids.length > 6 || cities.length !== ids.length) throw new Error('Choose up to six verified cities within the selected area.');
  const key = `${parent.countryCode}:${parent.providerId || parent.id}:${[...ids].sort((a,b) => a-b).join(',')}`;
  return cache.get(key, async () => {
    const filters = ['[~"^(amenity|tourism|leisure|natural)$"~"^(restaurant|cafe|food_court|marketplace|museum|gallery|park|nature_reserve|garden|beach|wood|water)$"]', '[historic]'];
    const selectors = cities.flatMap(city => {
      // Bounding-box lookup uses the provider's spatial index. Normalize back
      // to the exact 1 km circle below before reporting any sample counts.
      const lat = 1 / 111.32, lon = Math.min(180, lat / Math.max(0.01, Math.cos(city.latitude * Math.PI / 180)));
      const south = Math.max(-90, city.latitude - lat), north = Math.min(90, city.latitude + lat);
      let west = city.longitude - lon, east = city.longitude + lon;
      const boxes: number[][] = [];
      if (west < -180) { boxes.push([south,west + 360,north,180]); west = -180; }
      if (east > 180) { boxes.push([south,-180,north,east - 360]); east = 180; }
      boxes.push([south,west,north,east]);
      return boxes.flatMap(box => filters.map(filter => `nwr${filter}(${box.join(',')});`));
    }).join('');
    const endpoint = process.env.DESTINATION_AREAS_PLACES_URL || process.env.ACCOMMODATION_PLACES_URL || 'https://overpass-api.de/api/interpreter';
    const response = await fetcher(endpoint, { method: 'POST', body: `[out:json][timeout:20];(${selectors});out center tags 600;`, headers: { 'Content-Type': 'text/plain', 'User-Agent': 'TravelMate/1.0 user-requested area comparison' }, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error('Mapped interest information is temporarily unavailable. Geographic suggestions remain available.');
    const payload = await response.json() as { elements?: Array<{ id?: number; type?: string; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string,string> }> };
    if (!Array.isArray(payload.elements)) throw new Error('The area comparison provider returned invalid data.');
    const elements = payload.elements;
    const profiles = cities.map(city => {
      const profile: AreaInterestProfile = { cityId: city.id, foodPlaces: 0, culturePlaces: 0, naturePlaces: 0 };
      const seen = new Set<string>();
      for (const row of elements.slice(0,600)) {
        const latitude = row.lat ?? row.center?.lat, longitude = row.lon ?? row.center?.lon;
        const tags = row.tags || {};
        if (!Number.isInteger(row.id) || !['node','way','relation'].includes(row.type || '') || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude!) > 90 || Math.abs(longitude!) > 180 || distance(latitude!,longitude!,city) > 1 || tags['addr:country'] && tags['addr:country'].toUpperCase() !== parent.countryCode) continue;
        const record = `${row.type}:${row.id}`; if (seen.has(record)) continue; seen.add(record);
        if (/^(restaurant|cafe|food_court|marketplace)$/.test(tags.amenity || '')) profile.foodPlaces++;
        if (/^(museum|gallery)$/.test(tags.tourism || '') || tags.historic) profile.culturePlaces++;
        if (/^(park|nature_reserve|garden)$/.test(tags.leisure || '') || /^(beach|wood|water)$/.test(tags.natural || '')) profile.naturePlaces++;
      }
      return profile;
    });
    return { parentId: parent.id, countryCode: parent.countryCode, profiles, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(), sourceUrl: 'https://www.openstreetmap.org/copyright', radiusKm: 1, disclaimer: 'Counts are a sample of mapped places within 1 km of each city centre, not complete inventories, ratings or confirmed opening information. Mapping coverage varies. Prices and affordability are not confirmed.' };
  });
}
export const clearAreaComparisonCache = () => cache.clear();
