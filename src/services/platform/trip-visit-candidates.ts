import { createHash } from 'node:crypto';
import { storedPhoto, type StoredCredit } from '../../lib/stored-trip-media.ts';
import { placeEvidenceSchema, type PlaceEvidence } from '../itinerary/grounding-schema.ts';
import { verifyGroundedPlan } from '../itinerary/grounded-plan.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { isDailyBudgetEntry, tripNavigationAnchor, vaguePlace, verifiedSavedActivityPlace } from '../navigation/trip-map-service.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function manualPlaceKey(name: string, destination: string): string {
  return `manual:${createHash('sha256').update(JSON.stringify([normalize(name), normalize(destination)])).digest('hex')}`;
}
type Trip = { id: string; destination: string; itinerary: unknown; destinationCity?: string | null; destinationCountry?: string | null; destinationCountryCode?: string | null; latitude?: number | null; longitude?: number | null };
type VisitPlaceReference = Pick<PlaceEvidence, 'provider' | 'placeId' | 'name'> & Partial<PlaceEvidence>;
export type TripVisitCandidate = {
  key: string; fingerprint: string; dayIndex: number; activityIndex: number;
  name: string; destination: string; latitude?: number; longitude?: number;
  place?: VisitPlaceReference; imageUrl?: string; imageAttribution?: StoredCredit;
};

/** Read saved places only. Provider availability and trip completion never gate this list. */
export function buildTripVisitCandidates(trip: Trip): TripVisitCandidate[] {
  const plan = object(trip.itinerary), anchor = tripNavigationAnchor(trip);
  let signed = false;
  try { signed = verifyGroundedPlan(plan as unknown as ItineraryResponse); } catch { /* Historical records may lack a full signed plan. */ }
  const seen = new Set<string>(), output: TripVisitCandidate[] = [];
  (Array.isArray(plan.days) ? plan.days : []).forEach((rawDay, dayIndex) => {
    const day = object(rawDay);
    (Array.isArray(day.activities) ? day.activities : []).forEach((raw, activityIndex) => {
      const activity = object(raw), rawPlace = object(activity.place);
      const verified = verifiedSavedActivityPlace(activity, anchor);
      const parsed = placeEvidenceSchema.safeParse(rawPlace);
      const name = text(rawPlace.name || activity.title || activity.name, 160).replace(/^visit\s+/i, '');
      if (!name || isDailyBudgetEntry(activity) || !verified && (activity.category !== 'activity' && !text(rawPlace.name) || vaguePlace(name) ||
        /^(?:beach walking|walking|sightseeing|museum visit|rest(?: break)?|break|meal break|unplanned time|unscheduled activity|additional activity|placeholder|no verified places)(?:$|\b\s*[—–:-])/i.test(name))) return;
      const coordinate = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
      const latitude = coordinate(rawPlace.latitude, 90), longitude = coordinate(rawPlace.longitude, 180);
      const hasPoint = latitude !== undefined && longitude !== undefined;
      const exactLocation = text(rawPlace.address || activity.location, 120);
      const explicitLocation = text([exactLocation, rawPlace.city, rawPlace.country].filter(value => typeof value === 'string' && value.trim()).reduce<string[]>((parts, value) => {
        const part = value as string; if (!parts.some(existing => normalize(existing).includes(normalize(part)))) parts.push(part); return parts;
      }, []).join(', '), 120);
      const destination = explicitLocation || trip.destination.slice(0, 120);
      // Distinct same-name venues keep distinct points. Without a point/address,
      // retain the saved activity's identity rather than merging uncertain names.
      const fallback = hasPoint ? `${destination}|${latitude.toFixed(6)},${longitude.toFixed(6)}`
        : exactLocation ? destination : `${destination}|trip:${trip.id}|activity:${text(activity.id) || `${dayIndex}:${activityIndex}`}`;
      const verifiedId = verified?.id || (signed && parsed.success && parsed.data.sourceUrl === 'https://www.wikidata.org/wiki/' + parsed.data.placeId ? parsed.data.placeId : undefined);
      const key = verifiedId ? `wikidata:${verifiedId}` : manualPlaceKey(name, fallback);
      if (seen.has(key)) return;
      seen.add(key);
      // Keep historical provider references too, without promoting an incomplete
      // reference to a verified identity used for cross-trip deduplication.
      const reference: VisitPlaceReference | undefined = parsed.success ? parsed.data : rawPlace.provider === 'wikidata' && /^Q\d+$/.test(text(rawPlace.placeId))
        ? { provider: 'wikidata', placeId: text(rawPlace.placeId), name, ...(hasPoint ? { latitude, longitude } : {}),
          ...(text(rawPlace.city) ? { city: text(rawPlace.city) } : {}), ...(text(rawPlace.country) ? { country: text(rawPlace.country) } : {}),
          ...(text(rawPlace.sourceUrl) === 'https://www.wikidata.org/wiki/' + text(rawPlace.placeId) ? { sourceUrl: text(rawPlace.sourceUrl) } : {}) } : undefined;
      const fingerprint = createHash('sha256').update(JSON.stringify([key, dayIndex, activityIndex, activity.id, activity.title, name, destination, latitude, longitude])).digest('hex');
      const photo = storedPhoto(activity);
      output.push({ key, fingerprint, dayIndex, activityIndex, name, destination, ...(hasPoint ? { latitude, longitude } : {}),
        ...(reference ? { place: reference } : {}), ...(photo || {}) });
    });
  });
  return output;
}

export function candidateAlreadyRecorded(candidate: TripVisitCandidate, tripId: string, rows: { placeKey: string; tripId: string | null; name: string; destination: string; latitude: number | null; longitude: number | null }[], candidates: TripVisitCandidate[]) {
  const uniqueName = candidates.filter(item => normalize(item.name) === normalize(candidate.name) && normalize(item.destination) === normalize(candidate.destination)).length === 1;
  return rows.some(row => row.placeKey === candidate.key ||
    // Compatibility with old manual records from this exact trip. A name alone
    // cannot collapse two same-name saved places or displace a different point.
    row.tripId === tripId && normalize(row.name.replace(/^visit\s+/i, '')) === normalize(candidate.name) && normalize(row.destination) === normalize(candidate.destination) &&
    uniqueName &&
    (row.latitude !== null && row.longitude !== null && candidate.latitude !== undefined && candidate.longitude !== undefined
      ? Math.abs(row.latitude - candidate.latitude) < 0.00001 && Math.abs(row.longitude - candidate.longitude) < 0.00001
      : row.latitude === null && row.longitude === null && candidate.latitude === undefined && candidate.longitude === undefined));
}
