import { countryForQuery } from './destination-index.ts';
import { distanceKm } from '../itinerary/grounded-places.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import type { DestinationCoverPhoto } from './destination-cover-photo.ts';

export interface PhotoDestination {
  city: string; country: string; countryCode: string; latitude: number; longitude: number;
}
export interface UnsplashPhoto {
  id?: string; asset_type?: string; description?: string | null; alt_description?: string | null;
  urls?: { regular?: string };
  user?: { name?: string; username?: string; links?: { html?: string } };
  tags?: Array<{ title?: string }>;
  links?: { html?: string; download_location?: string };
  location?: { name?: string | null; city?: string | null; country?: string | null;
    position?: { latitude?: number | null; longitude?: number | null } };
}
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const policy = { source: 'activities' as const, freshForMs: 86_400_000, staleForMs: 604_800_000 };
const photoId = /^[\w-]{1,100}$/;
const downloadLinks = new Map<string, string>();

export function safeUrl(value: string | undefined, host: string, path: RegExp): string | null {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && path.test(url.pathname) ? value! : null;
  } catch { return null; }
}
export function referral(value: string) {
  const url = new URL(value);
  url.searchParams.set('utm_source', 'travelmate');
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}
export function photographic(photo: UnsplashPhoto) {
  return (!photo.asset_type || photo.asset_type === 'photo') &&
    !/\b(flag|flags|map|logo|drawing|illustration|render|ai[- ]generated)\b/i.test([photo.description, photo.alt_description].join(' '));
}
/** Search keywords alone are insufficient: verify the photographer's location metadata. */
export function verifiedUnsplashPhoto(value: unknown, destination: PhotoDestination): DestinationCoverPhoto | null {
  if (!value || typeof value !== 'object') return null;
  const photo = value as UnsplashPhoto;
  const location = photo.location;
  if (!photo.id || !photoId.test(photo.id) || !photographic(photo) || !location) return null;
  const city = location.city?.trim() || location.name?.split(',')[0]?.trim();
  if (!city || normalized(city) !== normalized(destination.city)) return null;
  const country = location.country?.trim() || location.name?.split(',').at(-1)?.trim();
  if (!country || countryForQuery(country) !== destination.countryCode) return null;
  const point = location.position;
  if (point?.latitude != null || point?.longitude != null) {
    if (typeof point.latitude !== 'number' || typeof point.longitude !== 'number' ||
      !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180 || distanceKm(point as { latitude: number; longitude: number }, destination) > 15) return null;
  }
  const src = safeUrl(photo.urls?.regular, 'images.unsplash.com', /^\/photo-/);
  const source = safeUrl(photo.links?.html, 'unsplash.com', /^\/photos\//);
  const photographer = safeUrl(photo.user?.links?.html, 'unsplash.com', /^\/@/);
  if (!src || !source || !photographer || !photo.user?.name?.trim()) return null;
  return { id: photo.id, provider: 'unsplash', src, kind: 'destination-photo', city: destination.city,
    countryCode: destination.countryCode, scope: 'destination', label: destination.city + ', ' + destination.country,
    attribution: { creator: photo.user.name, license: 'Unsplash', sourceUrl: referral(source), photographerUrl: referral(photographer) } };
}
/** Covers and activities share pacing and the provider's rate-limit budget. */
export function createUnsplashRequestClient(intervalMs = 250, now = Date.now) {
  let queue: Promise<unknown> = Promise.resolve(), last = 0, cooldown = 0;
  return (url: string, key: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<any> => {
    const task = queue.catch(() => undefined).then(async () => {
      if (!safeUrl(url, 'api.unsplash.com', /^\/(?:search\/photos|photos\/[\w-]+(?:\/download)?)$/)) throw new Error('Invalid Unsplash API endpoint.');
      if (signal?.aborted) throw signal.reason;
      if (cooldown > now()) throw new Error('Unsplash is cooling down.');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, last + intervalMs - now()))); last = now();
      let response: Response;
      try {
        response = await fetcher(url, { headers: { Authorization: 'Client-ID ' + key, 'Accept-Version': 'v1' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(12000) });
      } catch (error) {
        if (!signal?.aborted) cooldown = now() + 60000;
        throw error;
      }
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || response.status === 429 || response.status === 403) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - now()) / 1000 : 3600;
        cooldown = now() + Math.max(60000, Number.isFinite(seconds) ? seconds * 1000 : 3600000);
      } else if (response.status >= 500) cooldown = now() + 60000;
      console.info(JSON.stringify({ event: 'unsplash_request', endpoint: new URL(url).pathname, status: response.status, remaining }));
      if (!response.ok) throw new Error(`Unsplash unavailable (HTTP ${response.status}).`);
      return response.json();
    });
    queue = task.catch(() => undefined); return task;
  };
}
export const requestUnsplash = createUnsplashRequestClient();
const request = requestUnsplash;
export async function searchUnsplashPhotos(params: URLSearchParams, key: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ results?: UnsplashPhoto[] }> {
  const canonical = new URLSearchParams(params);
  canonical.set('query', canonical.get('query')?.trim().replace(/\s+/g, ' ').toLowerCase() || '');
  canonical.sort();
  const results = (await withProviderCache('unsplash-search:' + canonical, { ...policy, emptyForMs: 60000 }, async () => {
    const data = await request('https://api.unsplash.com/search/photos?' + canonical, key, fetcher, signal);
    if (!Array.isArray(data.results)) throw new Error('Invalid Unsplash search response.');
    return data.results as UnsplashPhoto[];
  })).value;
  return { results };
}
export async function detail(id: string, key: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<UnsplashPhoto> {
  if (!photoId.test(id)) throw new Error('Invalid Unsplash photo identity.');
  return (await withProviderCache('unsplash-photo:' + id, policy, () => request('https://api.unsplash.com/photos/' + id, key, fetcher, signal))).value;
}
export async function loadUnsplashDestinationPhotos(destination: PhotoDestination, fetcher: typeof fetch = fetch, key = process.env.UNSPLASH_ACCESS_KEY): Promise<DestinationCoverPhoto[]> {
  if (!key) return [];
  try {
    return (await withProviderCache('unsplash-covers:' + JSON.stringify(destination), policy, async () => {
      const query = new URLSearchParams({ query: destination.city + ' ' + destination.country, orientation: 'landscape', per_page: '8' });
      const result = await searchUnsplashPhotos(query, key, fetcher);
      const candidates = Array.isArray(result.results) ? result.results.slice(0, 8).filter(photo => photo.id && photoId.test(photo.id) && photographic(photo)) : [];
      const photos = await Promise.all(candidates.map(async photo => {
        try {
          const full = await detail(photo.id!, key, fetcher);
          const verified = verifiedUnsplashPhoto(full, destination);
          const download = safeUrl(full.links?.download_location, 'api.unsplash.com', new RegExp('^/photos/' + photo.id + '/download$'));
          if (!verified || !download) return null;
          if (downloadLinks.size >= 1000) downloadLinks.delete(downloadLinks.keys().next().value!);
          downloadLinks.set(photo.id!, download);
          return verified;
        } catch { return null; }
      }));
      return photos.filter((photo): photo is DestinationCoverPhoto => Boolean(photo));
    })).value;
  } catch { return []; }
}
/** Unsplash requires a download event when a photo is selected for a cover, not on each render. */
export async function trackUnsplashCoverSelection(userId: string, tripId: string, id: string, fetcher: typeof fetch = fetch, key = process.env.UNSPLASH_ACCESS_KEY): Promise<boolean> {
  if (!key || !photoId.test(id)) return false;
  try {
    return (await withProviderCache('unsplash-cover-selection:' + JSON.stringify([userId, tripId, id]), policy, async () => {
      let url = downloadLinks.get(id);
      if (!url) {
        const photo = await detail(id, key, fetcher);
        url = safeUrl(photo.links?.download_location, 'api.unsplash.com', new RegExp('^/photos/' + id + '/download$')) || undefined;
      }
      if (!url) throw new Error('Photo download tracking unavailable.');
      await request(url, key, fetcher);
      return true;
    })).value;
  } catch { return false; }
}
