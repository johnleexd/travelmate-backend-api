import { z } from 'zod';
import { countryForQuery } from './destination-index.ts';
import { searchGlobalLocations } from './global-location-search.ts';
import { hasResolvedCoordinates } from './location-search-service.ts';
import { distanceKm, loadGroundedPlaces, type GroundedPlace } from '../itinerary/grounded-places.ts';
import { loadUnsplashDestinationPhotos } from './unsplash-cover-photos.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import { findDestinationPhoto } from '../itinerary/activity-photo-fallback.ts';

export const destinationPhotoQuerySchema = z.object({
  city: z.string().trim().min(2).max(100),
  country: z.string().trim().max(100).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  region: z.string().trim().max(1000).optional(),
  latitude: z.coerce.number().finite().min(-90).max(90).optional(),
  longitude: z.coerce.number().finite().min(-180).max(180).optional(),
}).refine(value => (value.latitude === undefined) === (value.longitude === undefined));
type PhotoQuery = z.infer<typeof destinationPhotoQuerySchema>;
export interface DestinationCoverPhoto {
  id?: string;
  provider?: 'unsplash';
  src: string;
  kind: 'destination-photo';
  city: string;
  countryCode: string;
  label: string;
  scope: 'destination' | 'country';
  attribution: { creator: string; license: string; licenseUrl?: string; sourceUrl: string; photographerUrl?: string };
}
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Reviewed real photographs from the project's existing Wikimedia image source.
// Their Commons file pages document subject, author, and reuse license.
const reviewedPhotos = [
  { city: 'Manila', countryCode: 'PH', latitude: 14.6042, longitude: 120.9822,
    label: 'Manila Cathedral, Manila, Philippines',
    src: 'https://upload.wikimedia.org/wikipedia/commons/e/ea/The_Manila_Cathedral.jpg',
    attribution: { creator: 'Kuranges', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:The_Manila_Cathedral.jpg' } },
  { city: 'Fukuoka', countryCode: 'JP', latitude: 33.6, longitude: 130.41667,
    label: 'Fukuoka skyline viewed from Fukuoka Tower, Japan',
    src: 'https://upload.wikimedia.org/wikipedia/commons/d/d7/Fukuoka_City_from_Fukuoka_Tower.jpg',
    attribution: { creator: 'そらみみ', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fukuoka_City_from_Fukuoka_Tower.jpg' } },
] as const;

function usablePhoto(place: GroundedPlace): boolean {
  try { return Boolean(place.imageUrl && place.imageAttribution?.creator.trim()
    && /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(place.imageUrl)
    && /\.(jpe?g|png|webp|avif)(?:$|\?)/i.test(place.imageUrl)
    && !/\b(flag|map|logo|drawing|illustration|ai[- ]generated)\b/i.test(decodeURIComponent(place.imageUrl).replace(/_/g, ' ') + ' ' + place.description)
    && !/\.(svg|pdf|eps)(?:\.|$)/i.test(decodeURIComponent(place.imageUrl))
    && /^(CC BY(?:-SA)? [\d.]+|CC0|public domain)$/i.test(place.imageAttribution.license)); } catch { return false; }
}

async function resolvePhotoDestination(input: PhotoQuery, search = searchGlobalLocations) {
  const namedCode = input.country ? countryForQuery(input.country) : undefined;
  const code = input.countryCode || namedCode;
  if (!code || (namedCode && namedCode !== code)) return null;
  const cityName = (value: string) => normalized(value).replace(/^city of /, '').replace(/ city$/, '');
  let matches = (await search(input.city + ', ' + code, fetch, { includeLegacyDuplicates: true, preferBundledExact: true })).filter(hasResolvedCoordinates).filter(place =>
    cityName(place.name) === cityName(input.city) && place.countryCode === code && !['Country','Province','Region','Island','Barangay'].includes(place.placeType)
    && (!input.region || normalized(place.region).replace(/\b(province|prefecture|state|region)\b/g, '').trim() === normalized(input.region).replace(/\b(province|prefecture|state|region)\b/g, '').trim())
    && (input.latitude === undefined || distanceKm(place, { latitude: input.latitude, longitude: input.longitude! }) <= 15));
  // GeoNames' bundled snapshot and its live geocoder can return separate rows
  // for the same city centre. Treat nearby exact-name rows as one identity so
  // provider ordering or availability cannot make a reviewed cover disappear.
  matches = matches.filter((place, index, all) => !all.slice(0, index).some(existing =>
    distanceKm(place, existing) <= 15));
  // A country and nearby point narrow duplicate city names; ambiguity never picks an arbitrary city.
  const official = matches.filter(place => place.provider === 'psgc');
  if (official.length) matches = official;
  if (matches.length !== 1) return null;
  return { city: input.city, region: matches[0].region, country: matches[0].country, countryCode: code, latitude: matches[0].latitude, longitude: matches[0].longitude };
}

/** Read-only cover lookup: never fetches or updates saved trip records. */
export async function resolveDestinationCoverPhoto(
  input: PhotoQuery,
  search = searchGlobalLocations,
  loadPlaces = loadGroundedPlaces,
  findPhoto = findDestinationPhoto,
): Promise<DestinationCoverPhoto | null> {
  const anchor = await resolvePhotoDestination(input, search);
  if (!anchor) return null;
  const code = anchor.countryCode;
  const reviewed = reviewedPhotos.find(photo => normalized(photo.city) === normalized(anchor.city) && photo.countryCode === code && distanceKm(photo, anchor) <= 15);
  if (reviewed) return { ...reviewed, kind: 'destination-photo', scope: 'destination' };

  const cityPhoto = await findPhoto(anchor, AbortSignal.timeout(60000));
  if (cityPhoto) return { src: cityPhoto.imageUrl, kind: 'destination-photo', city: anchor.city, countryCode: code,
    label: 'Destination photo: ' + anchor.city + ', ' + anchor.country, scope: 'destination', attribution: cityPhoto.imageAttribution };

  const places = (await loadPlaces(anchor)).places;
  const photo = places.find(place => normalized(place.city) === normalized(anchor.city) && place.countryCode === code && distanceKm(place, anchor) <= 5 && usablePhoto(place));
  if (photo) return { src: photo.imageUrl!, kind: 'destination-photo', city: anchor.city, countryCode: code,
    label: photo.name + ', ' + anchor.city + ', ' + anchor.country, scope: 'destination', attribution: photo.imageAttribution! };
  return null;
}

export async function loadDestinationCoverPhoto(input: PhotoQuery) {
  const key = 'destination-cover:' + JSON.stringify(input);
  try {
    return (await withProviderCache(key, { source: 'activities', freshForMs: 3600000, staleForMs: 86400000, emptyForMs: 60000 },
      () => resolveDestinationCoverPhoto(input))).value;
  } catch { return null; }
}

/** Cached candidate pool is shared by every saved card for this destination. */
export async function loadDestinationCoverPhotos(input: PhotoQuery): Promise<DestinationCoverPhoto[]> {
  try {
    return (await withProviderCache('destination-cover-pool:' + JSON.stringify(input),
      { source: 'activities', freshForMs: 86400000, staleForMs: 604800000, emptyForMs: 60000 }, async () => {
        const anchor = await resolvePhotoDestination(input);
        if (!anchor) return [];
        const photos = await loadUnsplashDestinationPhotos(anchor);
        if (photos.length) return photos;
        const fallback = await loadDestinationCoverPhoto(input);
        return fallback ? [fallback] : [];
      })).value;
  } catch { return []; }
}
