import type { ImageAttribution } from '../../controllers/itinerary-controller.ts';
import { countryForQuery } from '../destination/destination-index.ts';
import { detail, photographic, referral, requestUnsplash, safeUrl, searchUnsplashPhotos, type UnsplashPhoto } from '../destination/unsplash-cover-photos.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import { distanceKm } from './grounded-places.ts';

export type ActivityPhotoSubject = { name: string; city: string; region?: string; country: string; countryCode?: string; latitude?: number; longitude?: number; kind?: 'destination' | 'generic' };
export type UnsplashActivityPhoto = { imageUrl: string; imageAttribution: ImageAttribution };
/** Stored photos keep the same hotlink, source identity and disclosure contract. */
export function isUnsplashActivityPhoto(value: { imageUrl?: string; imageAttribution?: ImageAttribution }): boolean {
  const credit = value.imageAttribution;
  if (credit?.provider !== 'unsplash' || !/^[\w-]{1,100}$/.test(credit.photoId || '') || !credit.creator?.trim() || credit.license !== 'Unsplash' || credit.licenseUrl !== 'https://unsplash.com/license' || typeof credit.illustrative !== 'boolean' || (credit.illustrative ? !['destination', 'activity'].includes(credit.match || '') : credit.match !== 'place')) return false;
  if (!safeUrl(value.imageUrl, 'images.unsplash.com', /^\/photo-/) || !safeUrl(credit.downloadLocation, 'api.unsplash.com', new RegExp(`^/photos/${credit.photoId}/download$`))) return false;
  for (const [value, pattern] of [[credit.sourceUrl, /^\/photos\//], [credit.photographerUrl, /^\/@/]] as const) {
    const valid = safeUrl(value, 'unsplash.com', pattern); if (!valid) return false;
    const url = new URL(valid);
    if (url.searchParams.get('utm_source') !== 'travelmate' || url.searchParams.get('utm_medium') !== 'referral') return false;
  }
  return true;
}
const normalize = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text: string, name: string) => (` ${normalize(text)} `).includes(` ${normalize(name)} `);
const policy = { source: 'activities' as const, freshForMs: 86400000, staleForMs: 604800000, emptyForMs: 60000 };

/** Query relevance is not identity evidence. Metadata and geography decide. */
const activityTerms = (name: string) => /breakfast|lunch|dinner|meal/i.test(name) ? ['food', 'meal', 'restaurant', 'dining', 'cuisine'] : normalize(name).split(' ').filter(word => !['walk', 'walking', 'stroll', 'visit', 'explore'].includes(word));
export function matchUnsplashActivity(photo: UnsplashPhoto, subject: ActivityPhotoSubject): 'place' | 'destination' | 'activity' | null {
  if (!photographic(photo)) return null;
  const location = photo.location, position = location?.position;
  const evidence = [photo.description, photo.alt_description, location?.name, ...(photo.tags || []).map(tag => tag.title)].filter(Boolean).join(' ');
  const expectedCountry = subject.countryCode || countryForQuery(subject.country);
  const statedCountry = location?.country || location?.name?.split(',').at(-1)?.trim();
  const country = statedCountry ? countryForQuery(statedCountry) : undefined;
  if (country && expectedCountry && country !== expectedCountry) return null;
  let distance: number | undefined;
  if (position?.latitude != null || position?.longitude != null) {
    if (typeof position.latitude !== 'number' || typeof position.longitude !== 'number' || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude) || Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180) return null;
    if (Number.isFinite(subject.latitude) && Number.isFinite(subject.longitude)) distance = distanceKm(position as { latitude: number; longitude: number }, subject as { latitude: number; longitude: number });
  }
  const cityMatches = normalize(location?.city || '') === normalize(subject.city) || contains(location?.name || '', subject.city);
  const countryMatches = Boolean(expectedCountry && country === expectedCountry);
  if (subject.kind === 'generic') {
    // Illustrate the activity without claiming a local venue. Query rank is not proof.
    return activityTerms(subject.name).some(term => contains(evidence, term)) ? 'activity' : null;
  }
  if (contains(evidence, subject.name) && (distance !== undefined ? distance <= 1 : cityMatches && countryMatches)) return 'place';
  // Broader photos can illustrate this destination, never claim attraction identity.
  if (cityMatches && countryMatches && (distance === undefined || distance <= 15)) return 'destination';
  return null;
}
function mapped(photo: UnsplashPhoto, match: 'place' | 'destination' | 'activity'): UnsplashActivityPhoto | null {
  const id = photo.id;
  if (!id || !/^[\w-]{1,100}$/.test(id)) return null;
  const imageUrl = safeUrl(photo.urls?.regular, 'images.unsplash.com', /^\/photo-/);
  const source = safeUrl(photo.links?.html, 'unsplash.com', /^\/photos\//), photographer = safeUrl(photo.user?.links?.html, 'unsplash.com', /^\/@/);
  const download = safeUrl(photo.links?.download_location, 'api.unsplash.com', new RegExp(`^/photos/${id}/download$`));
  if (!imageUrl || imageUrl.length > 1000 || !source || !photographer || !download || !photo.user?.name?.trim() || photo.user.name.length > 200) return null;
  return { imageUrl, imageAttribution: { provider: 'unsplash', photoId: id, creator: photo.user.name, photographerUrl: referral(photographer), ...(photo.user.username ? { photographerUsername: photo.user.username } : {}), license: 'Unsplash', licenseUrl: 'https://unsplash.com/license', sourceUrl: referral(source), downloadLocation: download, illustrative: match !== 'place', match } };
}
export function createUnsplashActivityResolver(fetcher: typeof fetch = fetch, key = () => process.env.UNSPLASH_ACCESS_KEY, request = requestUnsplash) {
  return async (subject: ActivityPhotoSubject, signal?: AbortSignal): Promise<UnsplashActivityPhoto | null> => {
    const access = key(); if (!access || signal?.aborted) return null;
    const identity = JSON.stringify([subject.kind, normalize(subject.name), normalize(subject.city), normalize(subject.region || ''), normalize(subject.country), subject.latitude, subject.longitude]);
    try {
      return (await withProviderCache('unsplash-activity:' + identity, policy, async () => {
        let illustrative: UnsplashActivityPhoto | null = null;
        const queries = subject.kind === 'generic' ? [[subject.name, subject.city, subject.country], [activityTerms(subject.name).join(' ')]] : [[subject.name, subject.city, subject.region, subject.country], [subject.city, subject.region, subject.country]];
        for (const terms of queries) {
          const params = new URLSearchParams({ query: [...new Set(terms.filter(Boolean))].join(' '), orientation: 'landscape', per_page: '6', content_filter: 'high' });
          const result = request === requestUnsplash ? await searchUnsplashPhotos(params, access, fetcher, signal) : await request('https://api.unsplash.com/search/photos?' + params, access, fetcher, signal);
          const candidates: UnsplashPhoto[] = Array.isArray(result.results) ? result.results.filter((p: UnsplashPhoto) => p.id && /^[\w-]{1,100}$/.test(p.id) && photographic(p)) : [];
          // Prefer descriptive matches, inspect multiple full records, never assume
          // the first search hit is the attraction. Bound API use on demo quotas.
          candidates.sort((a, b) => Number(contains([b.description, b.alt_description].join(' '), subject.name)) - Number(contains([a.description, a.alt_description].join(' '), subject.name)));
          for (const summary of candidates.slice(0, 3)) {
            if (signal?.aborted) return illustrative;
            const photo = request === requestUnsplash ? await detail(summary.id!, access, fetcher, signal) : await request('https://api.unsplash.com/photos/' + summary.id, access, fetcher, signal);
            if (photo.id !== summary.id) continue;
            const match = matchUnsplashActivity(photo, subject);
            if (!match) { console.info(JSON.stringify({ event: 'unsplash_activity_rejected', photoId: summary.id, reason: 'place-or-destination-metadata-unconfirmed' })); continue; }
            const selected = mapped(photo, match);
            if (selected && match === 'place') return selected;
            illustrative ||= selected;
          }
          if (illustrative) return illustrative;
        }
        return null;
      })).value;
    } catch (error) { console.warn('[TravelMate activity Unsplash]', error instanceof Error ? error.message : 'Lookup failed'); return null; }
  };
}
export const findUnsplashActivityPhoto = createUnsplashActivityResolver((input, init) => fetch(input, init));

/** Track actual selection, not search/render. Persistent flag permits outage retry. */
export async function selectUnsplashActivityPhoto(photo: UnsplashActivityPhoto, selection: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<UnsplashActivityPhoto> {
  const credit = photo.imageAttribution;
  if (credit.provider !== 'unsplash' || !credit.photoId) return photo;
  let tracked = false;
  try {
    tracked = (await withProviderCache('unsplash-activity-selection:' + JSON.stringify([selection, credit.photoId]), policy, async () => {
      const url = safeUrl(credit.downloadLocation, 'api.unsplash.com', new RegExp(`^/photos/${credit.photoId}/download$`));
      if (!url || !process.env.UNSPLASH_ACCESS_KEY) throw new Error('Selection tracking unavailable.');
      await requestUnsplash(url, process.env.UNSPLASH_ACCESS_KEY, fetcher, signal); return true;
    })).value;
  } catch { /* Metadata is retained; controlled saved enrichment retries tracking. */ }
  return { ...photo, imageAttribution: { ...credit, downloadTracked: tracked, selectedAt: credit.selectedAt || new Date().toISOString() } };
}
