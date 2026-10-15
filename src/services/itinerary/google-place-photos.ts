import { countries } from 'countries-list';

export type GooglePhotoSubject = { name: string; city: string; country: string; countryCode?: string; latitude?: number; longitude?: number };
export type GooglePlacePhoto = { placeId: string; imageUrl: string; googleMapsUri: string; authors: { displayName: string; uri?: string; photoUri?: string }[] };
type Place = { id?: string; displayName?: { text?: string }; location?: { latitude: number; longitude: number }; addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]; photos?: { name?: string; widthPx?: number; heightPx?: number; googleMapsUri?: string; authorAttributions?: GooglePlacePhoto['authors'] }[] };
export const googlePlacesConfigured = () => process.env.GOOGLE_PLACES_PHOTOS_ENABLED?.trim().toLowerCase() === 'true' && Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
const normalize = (value = '') => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const validPoint = (point: { latitude?: number; longitude?: number }) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude!) <= 90 && Math.abs(point.longitude!) <= 180;
export const validGooglePlaceId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{10,255}$/.test(id);
function distance(a: GooglePhotoSubject, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180, h = Math.sin((b.latitude - a.latitude!) * rad / 2) ** 2 + Math.cos(a.latitude! * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude!) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Coordinates corroborate identity; they never override conflicting city/country evidence. */
export function googlePlaceMatches(place: Place, subject: GooglePhotoSubject): boolean {
  if (!validGooglePlaceId(place.id) || normalize(place.displayName?.text) !== normalize(subject.name)) return false;
  const components = place.addressComponents || [];
  const country = components.find(part => part.types?.includes('country'));
  const code = subject.countryCode || Object.entries(countries).find(([, value]) => [value.name, value.native].some(name => normalize(name) === normalize(subject.country)))?.[0];
  if (!country || (code ? country.shortText !== code : normalize(country.longText) !== normalize(subject.country))) return false;
  if (!components.some(part => part.types?.some(type => ['locality', 'postal_town', 'administrative_area_level_2', 'administrative_area_level_3', 'sublocality_level_1'].includes(type)) && [part.longText, part.shortText].some(name => normalize(name) === normalize(subject.city)))) return false;
  return !validPoint(subject) || Boolean(place.location && validPoint(place.location) && distance(subject, place.location) <= 1);
}
function safeUrl(value: unknown, image = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    const allowed = image ? /(^|\.)googleusercontent\.com$/.test(url.hostname) : /^(?:www\.|maps\.)?google\.com$/.test(url.hostname) && /^\/maps(?:\/|$)/.test(url.pathname);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.searchParams.has('key') && allowed ? url.href : undefined;
  } catch { return undefined; }
}
export class GooglePlacesError extends Error {
  httpStatus: number;
  code: string;
  reason: string;
  constructor(httpStatus: number, code: string, reason: string, message: string) { super(message); this.httpStatus = httpStatus; this.code = code; this.reason = reason; }
}
/** Only IDs and operational failures are cached. Photo names, metadata and URLs are request-local. */
export function createGooglePlacePhotoResolver(fetcher: typeof fetch = fetch, options: { key?: () => string; now?: () => number; enabled?: () => boolean } = {}) {
  const apiKey = options.key || (() => process.env.GOOGLE_PLACES_API_KEY?.trim() || '');
  const enabled = options.enabled || (options.key ? () => true : googlePlacesConfigured);
  const now = options.now || Date.now;
  const ids = new Map<string, string>(), failures = new Map<string, number>(), pending = new Map<string, Promise<{ placeId?: string; photo: GooglePlacePhoto | null }>>();
  let cooldown = 0;
  async function json(path: string, fields?: string, body?: unknown, signal?: AbortSignal) {
    const key = apiKey();
    const response = await fetcher(`https://places.googleapis.com/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { 'X-Goog-Api-Key': key, ...(fields ? { 'X-Goog-FieldMask': fields } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = data?.error;
      const reason = error?.details?.find((detail: { reason?: string }) => detail.reason)?.reason || '';
      // Never propagate a raw fetch error, request headers, URL or credentials.
      const clean = String(error?.message || `Google Places HTTP ${response.status}`).split(key).join('[REDACTED]').replace(/AIza[\w-]+/g, '[REDACTED]');
      if ([401, 403, 429].includes(response.status)) cooldown = now() + (response.status === 429 ? 60000 : 300000);
      throw new GooglePlacesError(response.status, String(error?.status || 'REQUEST_FAILED'), String(reason), clean);
    }
    return response.json();
  }
  const fields = 'id,displayName,addressComponents,location,photos';
  async function resolve(subject: GooglePhotoSubject, storedId?: string, signal?: AbortSignal) {
    if (!enabled()) return { photo: null };
    const key = apiKey();
    if (!key) return { photo: null };
    const identity = JSON.stringify(subject);
    let id = validGooglePlaceId(storedId) ? storedId : ids.get(identity);
    if (now() < cooldown || (failures.get(identity) || 0) > now()) return { placeId: id, photo: null };
    let place: Place | undefined;
    if (id) {
      try { place = await json(`places/${encodeURIComponent(id)}`, fields, undefined, signal); }
      catch (error) { if (!(error instanceof GooglePlacesError) || error.httpStatus !== 404) throw error; ids.delete(identity); id = undefined; }
      if (place && !googlePlaceMatches(place, subject)) { ids.delete(identity); id = undefined; place = undefined; }
    }
    if (!place) {
      const data = await json('places:searchText', `places.${fields.split(',').join(',places.')},nextPageToken`, { textQuery: `${subject.name}, ${subject.city}, ${subject.country}`, pageSize: 10, languageCode: 'en', ...(validPoint(subject) ? { locationBias: { circle: { center: { latitude: subject.latitude, longitude: subject.longitude }, radius: 1500 } } } : {}) }, signal);
      const matches = [...new Map<string, Place>((data.places || []).filter((candidate: Place) => googlePlaceMatches(candidate, subject)).map((candidate: Place) => [candidate.id!, candidate] as [string, Place])).values()];
      if (matches.length !== 1 || data.nextPageToken) { failures.set(identity, now() + 60000); return { photo: null }; }
      place = matches[0]; id = place!.id!;
      if (ids.size >= 500) ids.delete(ids.keys().next().value!);
      ids.set(identity, id);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const photo = place!.photos?.find(candidate => typeof candidate.name === 'string' && candidate.name.startsWith(`places/${id}/photos/`) && (candidate.widthPx || 0) >= 320 && (candidate.heightPx || 0) >= 180 && (candidate.widthPx! / candidate.heightPx!) >= 0.5 && (candidate.widthPx! / candidate.heightPx!) <= 3 && safeUrl(candidate.googleMapsUri));
      if (!photo) { failures.set(identity, now() + 60000); return { placeId: id, photo: null }; }
      try {
        const media = await json(`${photo.name}/media?maxWidthPx=960&maxHeightPx=720&skipHttpRedirect=true`, undefined, undefined, signal);
        const imageUrl = safeUrl(media.photoUri, true);
        const authors = (photo.authorAttributions || []).map(author => ({ displayName: author.displayName, uri: safeUrl(author.uri), photoUri: safeUrl(author.photoUri, true) }));
        if (!imageUrl || authors.some(author => !author.displayName?.trim() || !author.uri)) return { placeId: id, photo: null };
        return { placeId: id, photo: { placeId: id!, imageUrl, googleMapsUri: safeUrl(photo.googleMapsUri)!, authors } };
      } catch (error) {
        if (attempt || !(error instanceof GooglePlacesError) || ![400, 404].includes(error.httpStatus)) throw error;
        // Expired names are refreshed once from Details, never retried in a loop.
        place = await json(`places/${encodeURIComponent(id!)}`, fields, undefined, signal);
        if (!place || !googlePlaceMatches(place, subject)) return { photo: null };
      }
    }
    return { placeId: id, photo: null };
  }
  const lookup = (subject: GooglePhotoSubject, storedId?: string, signal?: AbortSignal) => {
    const identity = JSON.stringify([subject, storedId]);
    if (pending.has(identity)) return pending.get(identity)!;
    const task = resolve(subject, storedId, signal).catch(error => {
      if (failures.size >= 500) failures.delete(failures.keys().next().value!);
      failures.set(JSON.stringify(subject), now() + 60000);
      if (error instanceof GooglePlacesError) console.warn(JSON.stringify({ event: 'google_places_photo_error', httpStatus: error.httpStatus, code: error.code, reason: error.reason, message: error.message }));
      return { placeId: validGooglePlaceId(storedId) ? storedId : ids.get(JSON.stringify(subject)), photo: null };
    }).finally(() => pending.delete(identity));
    pending.set(identity, task); return task;
  };
  return Object.assign(lookup, { matchedPlaceId: (subject: GooglePhotoSubject) => ids.get(JSON.stringify(subject)) });
}
export const findGooglePlacePhoto = createGooglePlacePhotoResolver((input, init) => fetch(input, init));
