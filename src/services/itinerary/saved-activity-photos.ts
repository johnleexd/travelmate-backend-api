import type { DayActivity, DayPlan, ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { prisma } from '../../lib/prisma.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import { activityPhotoSubject, cachedActivityPhoto, fillMissingDayPhotos, type FailedActivityPhoto } from './activity-photo-fallback.ts';
import { storedPhoto } from '../../lib/stored-trip-media.ts';
import { signGroundedPlan, verifyGroundedPlan } from './grounded-plan.ts';
import { fillDayDisplayPhotos } from './activity-display-photos.ts';
import { findGooglePlacePhoto } from './google-place-photos.ts';
import { fillStoredDayPhoto, storedDestinationRepresentative } from './stored-destination-day-photos.ts';

const identity = (activity: DayActivity) => JSON.stringify([activity.id, activity.title, activity.location, activity.place]);
/** Merge only photo fields into the latest record. Concurrent edits always win. */
export function mergeActivityPhotos(latest: ItineraryResponse, before: DayPlan, enriched: DayPlan, failures: FailedActivityPhoto[] = []): ItineraryResponse {
  let changed = false;
  const photos = new Map(before.activities.map((activity, index) => [identity(activity), enriched.activities[index]]));
  const days = latest.days.map(day => {
    if (day.day !== before.day || day.date !== before.date) return day;
    const activities = day.activities.map(activity => {
      const addition = photos.get(identity(activity));
      if (!addition) return activity;
      if (addition.googlePlaceId && addition.googlePlaceId !== activity.googlePlaceId) { changed = true; activity = { ...activity, googlePlaceId: addition.googlePlaceId }; }
      if (!addition.imageUrl || !addition.imageAttribution) return activity;
      const saved = storedPhoto(activity);
      const failed = failures.some(photo => photo.index === before.activities.findIndex(item => identity(item) === identity(activity)) && photo.imageUrl === saved?.imageUrl);
      if (saved && !failed) {
        if (activity.imageUrl === addition.imageUrl && activity.imageAttribution?.provider === 'unsplash' && !activity.imageAttribution.downloadTracked && addition.imageAttribution.downloadTracked) { changed = true; return { ...activity, imageAttribution: addition.imageAttribution }; }
        return activity;
      }
      if (saved && addition.imageUrl === saved.imageUrl) return activity;
      changed = true; return { ...activity, imageUrl: addition.imageUrl, imageAttribution: addition.imageAttribution };
    });
    const sameActivities = day.activities.length === before.activities.length && day.activities.every((activity, index) => identity(activity) === identity(before.activities[index]));
    const candidateCover = storedPhoto(enriched);
    const selectedSource = candidateCover && activities.some(activity => storedPhoto(activity)?.imageUrl === candidateCover.imageUrl);
    const destinationSource = candidateCover?.imageAttribution?.photoType === 'destination' && latest.days.some(sourceDay => storedPhoto(sourceDay)?.imageUrl === candidateCover.imageUrl || sourceDay.activities.some(activity => storedPhoto(activity)?.imageUrl === candidateCover.imageUrl));
    const addedCover = sameActivities && !day.imageUrl?.trim() && (selectedSource || destinationSource) && candidateCover;
    if (addedCover) { changed = true; return { ...day, activities, ...addedCover }; }
    if (!activities.some((activity, index) => activity !== day.activities[index])) return day;
    const oldDayPhoto = storedPhoto(day);
    const replacement = activities.find((activity, index) => activity.imageUrl && (activity.imageUrl !== day.activities[index].imageUrl || activity.imageAttribution !== day.activities[index].imageAttribution) && (!oldDayPhoto || storedPhoto(day.activities[index])?.imageUrl === oldDayPhoto.imageUrl));
    return { ...day, activities, ...(replacement ? { imageUrl: replacement.imageUrl!, imageAttribution: replacement.imageAttribution } : {}) };
  });
  if (!changed) return latest;
  const updated = { ...latest, days };
  // Photo metadata is covered by the existing proof. Never sign arbitrary client data.
  return latest.grounding && verifyGroundedPlan(latest) ? { ...updated, groundingProof: signGroundedPlan(updated) } : updated;
}

/** An ordinary save of a previously opened plan must retain later enrichment. */
export function retainStoredActivityPhotos(incoming: ItineraryResponse, stored: ItineraryResponse): ItineraryResponse {
  if (!Array.isArray(stored?.days)) return incoming;
  let changed = false;
  const matchedIds = new Map(stored.days.flatMap(day => day.activities.flatMap(activity => {
    const subject = activityPhotoSubject(activity, stored.destination);
    return subject && activity.googlePlaceId ? [[JSON.stringify(subject), activity.googlePlaceId] as const] : [];
  })));
  const days = incoming.days.map(day => {
    const previous = stored.days.find(item => item.day === day.day && item.date === day.date);
    if (!previous || !Array.isArray(previous.activities)) return day;
    const savedDayPhoto = storedPhoto(previous);
    if (incoming.destination === stored.destination && !day.imageUrl?.trim() && savedDayPhoto) { changed = true; day = { ...day, ...savedDayPhoto }; }
    const photos = new Map(previous.activities.map(activity => [identity(activity), activity]));
    const activities = day.activities.map(activity => {
      const saved = photos.get(identity(activity));
      const subject = activityPhotoSubject(activity, incoming.destination);
      const googlePlaceId = subject ? matchedIds.get(JSON.stringify(subject)) : undefined;
      if (googlePlaceId && googlePlaceId !== activity.googlePlaceId) { changed = true; activity = { ...activity, googlePlaceId }; }
      const photo = storedPhoto(saved);
      if (!photo || activity.imageUrl === photo.imageUrl && activity.imageAttribution?.downloadTracked) return activity;
      changed = true; return { ...activity, ...photo };
    });
    if (!activities.some((activity, index) => activity !== day.activities[index])) return day;
    const dayPhoto = storedPhoto(day);
    const mirror = activities.find((activity, index) => (activity.imageUrl !== day.activities[index].imageUrl || activity.imageAttribution !== day.activities[index].imageAttribution) && (!dayPhoto || storedPhoto(day.activities[index])?.imageUrl === dayPhoto.imageUrl));
    return { ...day, activities, ...(mirror ? { imageUrl: mirror.imageUrl || '', imageAttribution: mirror.imageAttribution } : {}) };
  });
  if (!changed) return incoming;
  const updated = { ...incoming, days };
  return incoming.grounding && verifyGroundedPlan(incoming) ? { ...updated, groundingProof: signGroundedPlan(updated) } : updated;
}

export function retainSelectedActivityPhotos(plan: ItineraryResponse): ItineraryResponse {
  let result = plan;
  for (const day of plan.days) result = mergeActivityPhotos(result, day, { ...day, activities: day.activities.map(activity => {
    const subject = activityPhotoSubject(activity, plan.destination);
    const googlePlaceId = activity.googlePlaceId || (subject ? findGooglePlacePhoto.matchedPlaceId(subject) : undefined);
    return { ...activity, ...(!activity.imageUrl ? cachedActivityPhoto(activity, plan.destination) : {}), ...(googlePlaceId ? { googlePlaceId } : {}) };
  }) });
  return result;
}

export async function enrichSavedActivityPhotos(userId: string, tripId: string, dayNumber: number, enrich = fillMissingDayPhotos, failures: FailedActivityPhoto[] = [], withGoogle = false, googleFailedIndices: number[] = []) {
  const read = () => prisma.trip.findFirst({ where: { id: tripId, userId } });
  const initial = await read();
  if (!initial) return null;
  const initialPlan = initial.itinerary as unknown as ItineraryResponse;
  const before = Array.isArray(initialPlan?.days) ? initialPlan.days.find(day => day.day === dayNumber && Array.isArray(day.activities)) : undefined;
  if (!before) return null;
  const display = withGoogle ? await fillDayDisplayPhotos(initial.destination, before, AbortSignal.timeout(45000), `trip:${userId}:${tripId}`, failures, undefined, undefined, googleFailedIndices) : { day: await enrich(initial.destination, before, undefined, AbortSignal.timeout(25000), `trip:${userId}:${tripId}`, failures), googlePhotos: {} };
  const excludedUrls = failures.map(failure => failure.imageUrl);
  const enriched = fillStoredDayPhoto(display.day, storedDestinationRepresentative(initialPlan, excludedUrls), excludedUrls);
  // A concurrent edit must also discard transient content for the old identity.
  const matchingPhotos = (day: DayPlan | undefined) => Object.fromEntries(Object.entries(display.googlePhotos).filter(([index]) => day?.activities[Number(index)] && identity(day.activities[Number(index)]) === identity(before.activities[Number(index)])));
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await read(); if (!current) return null;
    const latest = current.itinerary as unknown as ItineraryResponse;
    if (!Array.isArray(latest?.days)) return null;
    if (current.destination !== initial.destination) return { day: latest.days.find(day => day.day === dayNumber), googlePhotos: {}, persisted: false };
    const updated = mergeActivityPhotos(latest, before, enriched, failures);
    if (updated === latest) { const day = latest.days.find(day => day.day === dayNumber); return { day, googlePhotos: matchingPhotos(day), persisted: false }; }
    const result = await prisma.trip.updateMany({ where: { id: tripId, userId, status: current.status, updatedAt: current.updatedAt, itinerary: { equals: current.itinerary as Prisma.InputJsonValue } }, data: { itinerary: updated as unknown as Prisma.InputJsonValue } });
    if (result.count === 1) { const day = updated.days.find(day => day.day === dayNumber); return { day, googlePhotos: matchingPhotos(day), persisted: true }; }
  }
  // Do not overwrite if a newer edit repeatedly wins the compare-and-swap.
  const final = await read();
  const plan = final?.itinerary as unknown as ItineraryResponse;
  const day = plan?.days?.find(day => day.day === dayNumber);
  return day ? { day, googlePhotos: matchingPhotos(day), persisted: false } : null;
}
