import { activityIdentity, tripRevision } from '../itinerary/activity-management.ts';
import { z } from 'zod';
import { coordinateSchema, NavigationError, type NavigationCoordinate } from './navigation-service.ts';
import { countryForQuery } from '../destination/destination-index.ts';
import { fetchGeocoderSearch } from '../destination/geocoder-client.ts';
import { distanceKm, placeMatchesAnchor, loadGroundedPlaces, type GroundedPlace } from '../itinerary/grounded-places.ts';
import { placeEvidenceSchema, destinationAnchorSchema, type DestinationAnchor } from '../itinerary/grounding-schema.ts';
import { verifyGroundedPlan } from '../itinerary/grounded-plan.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { withProviderCache } from '../cache/provider-cache.ts';

export interface MapPhoto { src: string; attribution: { creator: string; license: string; licenseUrl?: string; sourceUrl: string } }
export interface MapPlace extends NavigationCoordinate { id: string; name: string; address: string; sourceUrl: string; photo: MapPhoto | null }
export interface MapRouteOrigin extends NavigationCoordinate { name: string; kind: 'accommodation' | 'destination' }
export interface MapActivity { activityId: string; status: 'planned' | 'completed' | 'skipped' | 'rescheduled'; index: number; title: string; time: string; description: string; place: MapPlace | null; locationStatus: string; durationMinutes?: number; estimatedCost?: number; category?: string; budgetOnly: boolean }
export interface TripMapManifest { revision: string; tripStatus?: string; tripId: string; destination: string; anchor: DestinationAnchor | null; origin: MapRouteOrigin | null; currency?: string; days: { day: number; date: string; theme: string; activities: MapActivity[] }[] }
type Trip = { id: string; destination: string; destinationCity?: string | null; destinationCountry?: string | null; destinationCountryCode?: string | null; latitude?: number | null; longitude?: number | null; currency?: string | null; status?: string; updatedAt?: string | Date; itinerary: unknown };
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 2000) : '';
export const vaguePlace = (name: string) => /^(?:local|nearby|some|a|an|your)\b/i.test(name.trim()) ||
  /^(?:hotel|accommodation|breakfast|lunch|dinner|free time|leisure|transfer|check[ -]?in|check[ -]?out)(?:$|\s+(?:at|in|near|to|from)\b)/i.test(name.trim()) ||
  /^(?:ramen shop|restaurant|cafe|coffee shop|food stop|shopping|explore the city|city walk)$/i.test(name.trim());
export function tripNavigationAnchor(trip: Trip): DestinationAnchor | null {
  const plan = record(trip.itinerary), grounding = record(record(plan.grounding).destination);
  const parts = trip.destination.split(',').map(value => value.trim());
  const country = trip.destinationCountry || text(grounding.country) || parts.at(-1);
  const code = trip.destinationCountryCode || text(grounding.countryCode) || countryForQuery(country || '');
  const stored = destinationAnchorSchema.safeParse(grounding);
  // PostgreSQL trip columns round to six decimals; grounding keeps the source point.
  const sameStoredPoint = stored.success && (trip.latitude == null || Math.abs(Number(trip.latitude) - stored.data.latitude) <= 0.00000051) && (trip.longitude == null || Math.abs(Number(trip.longitude) - stored.data.longitude) <= 0.00000051) && code === stored.data.countryCode && (!trip.destinationCity || normalized(trip.destinationCity) === normalized(stored.data.city));
  const candidate = destinationAnchorSchema.safeParse({ ...(sameStoredPoint && stored.success ? stored.data : {}), city: trip.destinationCity || text(grounding.city) || parts[0], country, countryCode: code,
    latitude: sameStoredPoint && stored.success ? stored.data.latitude : trip.latitude == null ? grounding.latitude : Number(trip.latitude), longitude: sameStoredPoint && stored.success ? stored.data.longitude : trip.longitude == null ? grounding.longitude : Number(trip.longitude) });
  if (!candidate.success || countryForQuery(candidate.data.country) !== candidate.data.countryCode ||
    !normalized(trip.destination).startsWith(normalized(candidate.data.city))) return null;
  return candidate.data;
}
export function verifiedSavedActivityPlace(value: unknown, anchor: DestinationAnchor | null): MapPlace | null {
  const parsed = placeEvidenceSchema.safeParse(record(value).place);
  if (!parsed.success || !anchor) return null;
  const place = parsed.data;
  if (!placeMatchesAnchor(place, anchor) ||
    countryForQuery(place.country) !== anchor.countryCode || distanceKm(place, anchor) > 30 ||
    place.sourceUrl !== 'https://www.wikidata.org/wiki/' + place.placeId || vaguePlace(place.name)) return null;
  return { id: place.placeId, name: place.name, address: place.address, latitude: place.latitude, longitude: place.longitude, sourceUrl: place.sourceUrl, photo: null };
}
/** Non-location allowances retain their costs but are not itinerary map stops. */
export function isDailyBudgetEntry(value: unknown): boolean {
  const item = record(value), title = text(item.title), time = text(item.time);
  if (text(record(item.place).placeId) || text(item.location).trim() || /\bat\s+\S/i.test(title)) return false;
  return /^daily\s+(?:meals?|food|transport(?:ation)?)(?:$|\s+(?:in|allowance|budget)\b)/i.test(title) ||
    /\b(?:daily|meals?|food|transport(?:ation)?)\s+(?:budget|allowance)\b/i.test(title) ||
    /^(?:daily allowance|daily budget)$/i.test(time.trim()) && ['food', 'transport', 'misc'].includes(text(item.category)) && /^(?:meals?|food|transport(?:ation)?|daily allowance|daily budget)$/i.test(title.trim());
}
export function buildTripMapManifest(trip: Trip): TripMapManifest {
  const plan = record(trip.itinerary), anchor = tripNavigationAnchor(trip);
  const stay = record(plan.plannedAccommodation || plan.accommodation);
  const stayPoint = coordinateSchema.safeParse({ latitude: Number(stay.latitude), longitude: Number(stay.longitude) });
  const origin = anchor && stayPoint.success && distanceKm(stayPoint.data, anchor) <= 30 && text(stay.name).trim()
    ? { ...stayPoint.data, name: text(stay.name).trim(), kind: 'accommodation' as const }
    : anchor ? { latitude: anchor.latitude, longitude: anchor.longitude, name: anchor.city + ' destination centre', kind: 'destination' as const } : null;
  let signed = false;
  try { signed = verifyGroundedPlan(plan as unknown as ItineraryResponse); } catch { /* Legacy or incomplete plans must reverify photos with the provider. */ }
  const days = Array.isArray(plan.days) ? plan.days.slice(0, 31) : [];
  return { tripId: trip.id, revision: tripRevision(trip), tripStatus: trip.status, destination: trip.destination, anchor, origin, currency: typeof trip.currency === 'string' ? trip.currency : typeof plan.currency === 'string' ? plan.currency : undefined, days: days.flatMap((value, dayIndex) => {
    const day = record(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(day.date)) || !Array.isArray(day.activities)) return [];
    return [{ day: typeof day.day === 'number' ? day.day : dayIndex + 1, date: text(day.date), theme: text(day.theme),
      activities: day.activities.slice(0, 50).map((value, index) => {
        const activity = record(value), budgetOnly = isDailyBudgetEntry(activity), place = budgetOnly ? null : verifiedSavedActivityPlace(activity, anchor);
        if (place && signed) place.photo = exactPhoto(activity as unknown as GroundedPlace);
        return { activityId: activityIdentity(trip.id, text(day.date), index, activity as unknown as import('../../controllers/itinerary-controller.ts').DayActivity), status: ['planned','completed','skipped','rescheduled'].includes(text(activity.status)) ? text(activity.status) as MapActivity['status'] : 'planned', index, title: text(activity.title), time: text(activity.time), description: text(activity.description), place, budgetOnly,
          ...(typeof activity.durationMinutes === 'number' && Number.isFinite(activity.durationMinutes) && activity.durationMinutes > 0 ? { durationMinutes: activity.durationMinutes } : {}),
          ...(typeof activity.estimatedCost === 'number' && Number.isFinite(activity.estimatedCost) && activity.estimatedCost >= 0 ? { estimatedCost: activity.estimatedCost } : {}),
          ...(typeof activity.category === 'string' ? { category: activity.category } : {}),
          locationStatus: place ? 'Verified saved place' : 'Choose an exact place' };
      }) }];
  }) };
}
export const activitySelectionSchema = z.object({
  dayIndex: z.number().int().min(0).max(30), activityIndex: z.number().int().min(0).max(49),
  query: z.string().trim().min(2).max(200).optional(), placeId: z.string().min(1).max(150).optional(),
}).strict().refine(value => !value.placeId || Boolean(value.query));
export type ActivitySelection = z.infer<typeof activitySelectionSchema>;
export function mapActivity(trip: Trip, selection: ActivitySelection) {
  const manifest = buildTripMapManifest(trip), day = manifest.days[selection.dayIndex], activity = day?.activities[selection.activityIndex];
  if (!day || !activity) throw new NavigationError('This saved itinerary activity is unavailable. Reload the trip.', 404);
  return { manifest, day, activity };
}
function verifiedCatalogPlace(place: GroundedPlace, anchor: DestinationAnchor) {
  return place.countryCode === anchor.countryCode && normalized(place.city) === normalized(anchor.city) && distanceKm(place, anchor) <= 30;
}
function exactPhoto(place: Pick<GroundedPlace, 'imageUrl' | 'imageAttribution'>): MapPhoto | null {
  try {
    const src = place.imageUrl, credit = place.imageAttribution;
    if (!src || typeof src !== 'string' || typeof credit?.creator !== 'string' || !credit.creator || typeof credit.license !== 'string' || typeof credit.sourceUrl !== 'string' || !/^(CC BY(?:-SA)? [\d.]+|CC0|public domain)$/i.test(credit.license)) return null;
    const url = new URL(src), name = decodeURIComponent(url.pathname).replace(/_/g, ' ');
    if (url.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) ||
      !url.pathname.startsWith('/wikipedia/commons/') || !/\.(jpe?g|png|webp|avif)(?:$|\?)/i.test(src) ||
      /\.(svg|pdf|eps)(?:\.|$)|\b(flag|logo|map|drawing|illustration|ai[- ]generated)\b/i.test(name) ||
      !credit.sourceUrl.startsWith('https://commons.wikimedia.org/')) return null;
    return { src, attribution: credit };
  } catch { return null; }
}
export async function searchTripActivityPlaces(query: string, anchor: DestinationAnchor, fetcher: typeof fetch = fetch): Promise<MapPlace[]> {
  if (vaguePlace(query)) return [];
  return (await withProviderCache('trip-map-search:' + JSON.stringify([query, anchor]),
    { source: 'activities', freshForMs: 86400000, staleForMs: 604800000 }, async () => {
      const params = new URLSearchParams({ q: query + ', ' + anchor.city + ', ' + anchor.country, format: 'jsonv2', addressdetails: '1', limit: '6', countrycodes: anchor.countryCode.toLowerCase() });
      const payload = await fetchGeocoderSearch(params, fetcher);
      if (!Array.isArray(payload)) throw new NavigationError('Place search is unavailable.');
      return payload.flatMap(value => {
        const item = record(value), address = record(item.address);
        const point = coordinateSchema.safeParse({ latitude: Number(item.lat), longitude: Number(item.lon) });
        const city = text(address.city || address.town || address.village || address.municipality);
        const code = text(address.country_code).toUpperCase();
        const name = text(item.name) || text(item.display_name).split(',')[0];
        const type = text(item.osm_type), id = String(item.osm_id || '');
        if (!point.success || !item.lat || !item.lon || code !== anchor.countryCode ||
          normalized(city) !== normalized(anchor.city) || distanceKm(point.data, anchor) > 30 || !name || vaguePlace(name) ||
          !['node', 'way', 'relation'].includes(type) || !/^\d+$/.test(id)) return [];
        return [{ ...point.data, id: type + ':' + id, name, address: text(item.display_name), sourceUrl: 'https://www.openstreetmap.org/' + type + '/' + id, photo: null }];
      });
    })).value;
}
export async function resolveTripMapActivity(trip: Trip, selection: ActivitySelection, options: { photos?: boolean; search?: typeof searchTripActivityPlaces; catalog?: typeof loadGroundedPlaces } = {}) {
  const { manifest, activity } = mapActivity(trip, selection);
  const anchor = manifest.anchor;
  if (activity.budgetOnly) return { activity, candidates: [] as MapPlace[], message: 'This is a daily budget entry, not a location stop.' };
  if (!anchor) return { activity, candidates: [] as MapPlace[], message: 'This trip needs a verified city, country and destination coordinates before its places can be mapped.' };
  let place = activity.place;
  let candidates: MapPlace[] = [];
  if (selection.query) {
    candidates = await (options.search || searchTripActivityPlaces)(selection.query, anchor);
    // Only an explicit selection can replace a saved place. Never guess among candidates.
    place = selection.placeId ? candidates.find(candidate => candidate.id === selection.placeId) || null : null;
    if (selection.placeId && !place) throw new NavigationError('That place is no longer a verified match. Search again.', 400);
  }
  if (!place && !selection.query && !vaguePlace(activity.title)) {
    // Exact verified catalog names may fill legacy coordinates; a keyword similarity cannot.
    const catalog = await (options.catalog || loadMapReferences)(anchor);
    const exact = catalog.places.filter(candidate => normalized(candidate.name) === normalized(activity.title) && verifiedCatalogPlace(candidate, anchor));
    if (exact.length === 1) place = { id: exact[0].placeId, name: exact[0].name, address: exact[0].address,
      latitude: exact[0].latitude, longitude: exact[0].longitude, sourceUrl: exact[0].sourceUrl, photo: exactPhoto(exact[0]) };
  }
  if (place && options.photos && !place.photo) {
    const catalog = await (options.catalog || loadGroundedPlaces)(anchor);
    const match = catalog.places.find(candidate => candidate.placeId === place!.id && verifiedCatalogPlace(candidate, anchor) && distanceKm(candidate, place!) < .1);
    // OSM searches can use a landmark photo only after an exact name AND close coordinate match.
    const landmark = match || (place.id.includes(':') ? catalog.places.find(candidate =>
      normalized(candidate.name) === normalized(place!.name) && verifiedCatalogPlace(candidate, anchor) && distanceKm(candidate, place!) < .1) : undefined);
    if (landmark) place = { ...place, photo: exactPhoto(landmark) };
  }
  return { activity: { ...activity, place, locationStatus: place ? selection.placeId ? 'Selected for this map session' : 'Verified place' : 'Choose an exact place' },
    candidates, message: place ? '' : candidates.length ? 'Choose a specific venue from these verified matches.' : 'Choose an exact place. Add the full venue name; ambiguous and vague locations are not pinned.' };
}

/** Fill exact catalog matches once per destination; never bulk-geocode a saved day. */
export async function loadTripMapManifest(trip: Trip, catalog = loadMapReferences) {
  const manifest = buildTripMapManifest(trip), anchor = manifest.anchor;
  if (!anchor || !manifest.days.some(day => day.activities.some(activity => !activity.budgetOnly && !activity.place && !vaguePlace(activity.title)))) return manifest;
  const { places } = await catalog(anchor);
  for (const day of manifest.days) for (const activity of day.activities) {
    if (activity.budgetOnly || activity.place || vaguePlace(activity.title)) continue;
    const exact = places.filter(place => normalized(place.name) === normalized(activity.title) && verifiedCatalogPlace(place, anchor));
    if (exact.length !== 1) continue;
    const place = exact[0];
    activity.place = { id: place.placeId, name: place.name, address: place.address, latitude: place.latitude, longitude: place.longitude, sourceUrl: place.sourceUrl, photo: exactPhoto(place) };
    activity.locationStatus = 'Verified place';
  }
  return manifest;
}

/** A failed shared catalog lookup gets a short negative cache in this feature only. */
async function loadMapReferences(anchor: DestinationAnchor) {
  return (await withProviderCache('trip-map-reference-status:' + JSON.stringify(anchor),
    { source: 'activities', freshForMs: 300000, staleForMs: 300000 }, () => loadGroundedPlaces(anchor))).value;
}
