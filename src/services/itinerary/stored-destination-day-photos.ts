import type { DayPlan, ImageAttribution, ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { storedPhoto } from '../../lib/stored-trip-media.ts';
import { reusableWikimediaLicense } from '../../lib/wikimedia-photo-license.ts';
import { isUnsplashActivityPhoto } from './unsplash-activity-photos.ts';

type Photo = { imageUrl: string; imageAttribution: ImageAttribution };
const normalized = (value = '') => value.normalize('NFKC').trim().toLowerCase();
function reusable(value: unknown): Photo | null {
  const photo = storedPhoto(value), credit = photo?.imageAttribution;
  if (!photo || !credit?.creator?.trim()) return null;
  if (credit.provider === 'unsplash') return isUnsplashActivityPhoto(photo) ? photo as Photo : null;
  return /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(photo.imageUrl) && reusableWikimediaLicense(credit.license, credit.licenseUrl) ? photo as Photo : null;
}
/** Reuse only this plan's existing licensed photos, never a different trip/city. */
export function storedDestinationRepresentative(plan: ItineraryResponse, excludedUrls: string[] = []): Photo | null {
  const city = plan.grounding?.destination.city || plan.destination.split(',')[0].trim();
  const country = plan.grounding?.destination.country || plan.destination.split(',').at(-1)?.trim();
  for (const day of plan.days) for (const activity of day.activities) {
    if (activity.category === 'accommodation') continue;
    if (activity.place && (normalized(activity.place.city) !== normalized(city) || country && normalized(activity.place.country) !== normalized(country))) continue;
    const photo = reusable(activity);
    if (photo && !excludedUrls.includes(photo.imageUrl)) return photo;
  }
  for (const day of plan.days) {
    const photo = reusable(day);
    if (photo && !excludedUrls.includes(photo.imageUrl)) return photo;
  }
  return null;
}
/** A day with no attraction photo can show a honestly labeled destination photo. */
export function fillStoredDayPhoto(day: DayPlan, representative: Photo | null, excludedUrls: string[] = []): DayPlan {
  if (day.imageUrl?.trim()) return day;
  const own = day.activities.filter(activity => activity.category !== 'accommodation').map(reusable).find(photo => photo && !excludedUrls.includes(photo.imageUrl));
  if (own) return { ...day, ...own };
  if (!representative || excludedUrls.includes(representative.imageUrl)) return day;
  return { ...day, imageUrl: representative.imageUrl, imageAttribution: { ...representative.imageAttribution, photoType: 'destination', illustrative: true, match: 'destination' } };
}
export function fillStoredDestinationDayPhotos(plan: ItineraryResponse): ItineraryResponse {
  const representative = storedDestinationRepresentative(plan);
  const days = plan.days.map(day => fillStoredDayPhoto(day, representative));
  return days.some((day, index) => day !== plan.days[index]) ? { ...plan, days } : plan;
}
