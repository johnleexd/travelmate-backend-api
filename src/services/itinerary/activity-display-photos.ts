import type { DayPlan } from '../../controllers/itinerary-controller.ts';
import { storedPhoto } from '../../lib/stored-trip-media.ts';
import { activityPhotoSubject, fillMissingDayPhotos, findItineraryActivityPhoto, type FailedActivityPhoto } from './activity-photo-fallback.ts';
import { findGooglePlacePhoto, type GooglePlacePhoto, type GooglePhotoSubject } from './google-place-photos.ts';

/** Google content lives only in the display response, outside the persisted day. */
export async function fillDayDisplayPhotos(destination: string, day: DayPlan, signal?: AbortSignal, selection?: string, failures: FailedActivityPhoto[] = [], google: (subject: GooglePhotoSubject, storedId?: string, signal?: AbortSignal) => Promise<{ placeId?: string; photo: GooglePlacePhoto | null }> = findGooglePlacePhoto, fallback = findItineraryActivityPhoto, googleFailedIndices: number[] = []) {
  // Production activity imagery uses reusable providers. A billing-blocked Google
  // key must not consume the fallback deadline or interfere with persisted photos.
  if (google === findGooglePlacePhoto) return { day: await fillMissingDayPhotos(destination, day, fallback, signal, selection, failures), googlePhotos: {} };
  const activities = [...day.activities], googlePhotos: Record<number, GooglePlacePhoto> = {};
  const skip = new Set<string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, activities.length) }, async () => {
    while (next < activities.length && !signal?.aborted) {
      const index = next++, activity = activities[index], saved = storedPhoto(activity);
      if (googleFailedIndices.includes(index)) continue;
      if (saved && !failures.some(failure => failure.index === index && failure.imageUrl === saved.imageUrl)) continue;
      const subject = activityPhotoSubject(activity, destination);
      if (!subject) continue;
      const result = await google(subject, activity.googlePlaceId, signal);
      if (result.placeId) activities[index] = { ...activity, googlePlaceId: result.placeId };
      if (result.photo) { googlePhotos[index] = result.photo; skip.add(JSON.stringify(subject)); }
    }
  }));
  const enriched = await fillMissingDayPhotos(destination, { ...day, activities }, (subject, requestSignal) => skip.has(JSON.stringify(subject)) ? Promise.resolve(null) : fallback(subject, requestSignal), signal, selection, failures);
  return { day: enriched, googlePhotos };
}
