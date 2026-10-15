import { countries, type TCountryCode } from 'countries-list';
import type { DayActivity, DayPlan, ImageAttribution } from '../../controllers/itinerary-controller.ts';
import { findUnsplashActivityPhoto, selectUnsplashActivityPhoto } from './unsplash-activity-photos.ts';
import { reusableWikimediaLicense } from '../../lib/wikimedia-photo-license.ts';
import { nonPhotographicPlaceImage } from '../../lib/place-photo-content.ts';
import { mapStoredActivity, storedPhoto } from '../../lib/stored-trip-media.ts';
import { fillStoredDestinationDayPhotos } from './stored-destination-day-photos.ts';

export type PlacePhoto = { imageUrl: string; imageAttribution: ImageAttribution };
/** Existing activity photos require reusable rights; hotels use their own path. */
export function reusableStoredActivityPhoto(activity: Pick<DayActivity, 'imageUrl' | 'imageAttribution'>): boolean {
  if (!activity.imageUrl) return false;
  const credit = activity.imageAttribution;
  if (nonPhotographicPlaceImage(activity.imageUrl, credit?.creator)) return false;
  if (credit?.provider === 'unsplash') return Boolean(/^https:\/\/images\.unsplash\.com\/photo-/.test(activity.imageUrl)
    && credit.license === 'Unsplash' && credit.creator?.trim() && /^[\w-]{1,100}$/.test(credit.photoId || '')
    && /^https:\/\/unsplash\.com\/photos\//.test(credit.sourceUrl) && /^https:\/\/unsplash\.com\/@/.test(credit.photographerUrl || ''));
  if (!/^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(activity.imageUrl)) return false;
  return Boolean(credit?.creator?.trim() && /^https:\/\/commons\.wikimedia\.org\//.test(credit.sourceUrl)
    && reusableWikimediaLicense(credit.license, credit.licenseUrl));
}
export type Subject = { name: string; city: string; country: string; countryCode?: string; placeId?: string; latitude?: number; longitude?: number; kind?: 'destination' | 'generic'; region?: string };
const selectedPhotos = new Map<string, { photo: PlacePhoto; until: number }>();
const subjectKey = (subject: Subject) => JSON.stringify([subject.kind, subject.placeId, subject.name.toLowerCase(), subject.city.toLowerCase(), subject.region?.toLowerCase(), subject.country.toLowerCase(), subject.latitude, subject.longitude]);
/** Reuse a preview selection on save without another provider request. */
export function cachedActivityPhoto(activity: DayActivity, destination: string): PlacePhoto | null {
  const subject = activityPhotoSubject(activity, destination);
  const cached = subject ? selectedPhotos.get(subjectKey(subject)) : undefined;
  return cached && cached.until > Date.now() ? cached.photo : null;
}
type WikiPage = { pageid?: number; title?: string; pageimage?: string; thumbnail?: { source?: string; width?: number; height?: number }; extract?: string; redirects?: Array<{ title: string }>; langlinks?: Array<{ lang: string; '*': string }>; pageprops?: { wikibase_item?: string; disambiguation?: string }; coordinates?: Array<{ lat: number; lon: number }>; imageinfo?: Array<{ url?: string; thumburl?: string; mime?: string; extmetadata?: Record<string, { value?: string }> }> };
const normalize = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const text = (s = '') => s.replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&(?:amp|quot|apos|nbsp|lt|gt);/g, value => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' })[value]!).replace(/\s+/g, ' ').trim();
const includes = (haystack: string, needle: string) => (` ${normalize(haystack)} `).includes(` ${normalize(needle)} `);
const point = (s: { latitude?: number; longitude?: number }) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude) && Math.abs(s.latitude!) <= 90 && Math.abs(s.longitude!) <= 180;
function close(s: Subject, p: { lat: number; lon: number }) {
  if (!point({ latitude: p.lat, longitude: p.lon })) return false;
  const rad = Math.PI / 180, a = Math.sin((p.lat - s.latitude!) * rad / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(s.latitude! * rad) * Math.sin((p.lon - s.longitude!) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= (s.kind === 'destination' ? 15 : 1);
}
export function activityPhotoSubject(activity: DayActivity, destination: string): Subject | null {
  // Daily budget allowances have no named venue. Never search them as visits.
  if (activity.category === 'accommodation') return null;
  if (/^daily\s+(allowance|budget)$/i.test(activity.time)) return null;
  const parts = destination.split(',').map(part => part.trim());
  const name = activity.place?.name || activity.title.replace(/^(?:visit|explore|tour|lunch at|dinner at|breakfast at)\s+/i, '').trim();
  const city = activity.place?.city || parts[0], country = activity.place?.country || (parts.length > 1 ? parts.at(-1)! : '');
  if (typeof name !== 'string' || typeof city !== 'string' || typeof country !== 'string' || !name || name.length > 160 || !city || city.length > 160 || !country || country.length > 160 || normalize(name) === normalize(city)) return null;
  const generic = !activity.place && /^(?:(?:breakfast|lunch|dinner|meal)(?: break)?|(?:beach|park|city|nature) (?:walk|walking|stroll)|walking|hiking|shopping|swimming|relaxing|free time|rest|park|museum|temple|church|beach)$/i.test(name);
  return { name, ...(generic ? { kind: 'generic' as const } : {}), city, region: parts.length > 2 ? parts.slice(1, -1).join(', ') : undefined, country, countryCode: activity.place?.countryCode, placeId: activity.place?.placeId, latitude: activity.place?.latitude, longitude: activity.place?.longitude };
}

/** Factory isolates deterministic tests; production shares one bounded cache and request queue. */
export function createActivityPhotoResolver(fetcher: typeof fetch = fetch, options: { intervalMs?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? Math.max(1100, Number(process.env.WIKIMEDIA_PHOTO_INTERVAL_MS) || 6100);
  const cache = new Map<string, { until: number; photo: PlacePhoto | null }>(), pending = new Map<string, Promise<PlacePhoto | null>>();
  const responses = new Map<string, { until: number; data: any }>(), requests = new Map<string, Promise<any>>();
  let tail: Promise<unknown> = Promise.resolve(), lastRequest = 0;
  let gatewayCooldown = 0;
  const cooldowns = new Map<string, number>();
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const json = (host: string, params: Record<string, string>, signal?: AbortSignal, entityId?: string): Promise<any> => {
    const key = JSON.stringify([host, entityId, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
    const cached = responses.get(key);
    if (cached && cached.until > now()) return Promise.resolve(cached.data);
    if (requests.has(key)) return requests.get(key)!;
    const task = tail.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw signal.reason;
      if (now() < Math.max(gatewayCooldown, cooldowns.get(host) || 0)) throw new Error('Wikimedia photo lookup is cooling down.');
      await sleep(Math.max(0, lastRequest + interval - now()), signal);
      lastRequest = now();
      // Known entities use Wikidata's documented, cacheable Linked Data interface.
      // Keep Action API maxlag, shared pacing and HTTP backoff for all providers.
      const response = await fetcher(entityId ? `${host}/wiki/Special:EntityData/${entityId}.json` : `${host}/w/api.php?${new URLSearchParams({ action: 'query', format: 'json', maxlag: '5', ...params })}`, {
        headers: { 'User-Agent': process.env.WIKIMEDIA_USER_AGENT || `TravelMate/1.0 (${(process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0]}; activity photo lookup)`, 'Api-User-Agent': 'TravelMate/1.0 activity-photo-fallback' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      });
      console.info(JSON.stringify({ event: 'activity_photo_request', provider: host, action: entityId ? 'entity-data' : params.action || 'query', entityId, generator: params.generator, status: response.status }));
      if (!response.ok) {
        const retry = response.headers.get('retry-after'), seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.max(0, (Date.parse(retry) - now()) / 1000) : 60;
        if (response.status === 429 || response.status === 503) cooldowns.set(host, now() + Math.max(5000, Number.isFinite(seconds) ? seconds * 1000 : 60000));
        if (response.status === 429) gatewayCooldown = cooldowns.get(host)!;
        throw new Error(`Wikimedia photo lookup HTTP ${response.status}`);
      }
      const data = await response.json();
      if (data.error) {
        if (['maxlag', 'ratelimited'].includes(data.error.code)) {
          const retry = response.headers.get('retry-after'), seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - now()) / 1000 : 60;
          cooldowns.set(host, now() + Math.max(5000, Number.isFinite(seconds) ? seconds * 1000 : 60000));
        }
        throw new Error(`Wikimedia photo lookup ${data.error.code || 'API error'}`);
      }
      if (responses.size >= 500) responses.delete(responses.keys().next().value!);
      responses.set(key, { data, until: now() + 3600000 });
      return data;
    });
    tail = task.catch(() => undefined);
    const shared = task.finally(() => requests.delete(key)); requests.set(key, shared); return shared;
  };
  const pages = (data: any): WikiPage[] => Object.values(data.query?.pages || {});
  const reject = (subject: Subject, file: string | undefined, reason: string) => { console.info(JSON.stringify({ event: 'activity_photo_rejected', place: subject.name, file, reason })); return null; };
  async function photo(page: WikiPage, s: Subject, names: string[], articleVerified: boolean): Promise<PlacePhoto | null> {
    const info = page.imageinfo?.[0], meta = info?.extmetadata || {};
    if (!info) return reject(s, page.title, 'missing-source-file-or-imageinfo');
    const description = `${page.title || ''} ${text(meta.ImageDescription?.value)} ${text(meta.ObjectName?.value)} ${s.kind === 'destination' ? text(meta.Categories?.value).replaceAll('_', ' ') : ''}`;
    // A numbered filename on an identity-verified article can be the exact local
    // name followed by a photo sequence number, e.g. <local place name>1.jpg.
    const numberedName = normalize((page.title || '').replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/[\d_ -]+$/, ''));
    if (!names.some(name => includes(description, name) || articleVerified && normalize(name) === numberedName)) return reject(s, page.title, 'exact-place-name-not-in-file-evidence');
    const content = `${description} ${text(meta.Categories?.value).replaceAll('_', ' ')}`;
    if (nonPhotographicPlaceImage(content + ' ' + text(meta.Medium?.value), text(meta.Artist?.value))) return reject(s, page.title, 'non-place-photograph');
    const coords = page.coordinates?.[0];
    if (coords && point(s) && !close(s, coords)) return reject(s, page.title, 'conflicting-file-coordinates');
    if (!articleVerified && !(coords && point(s) && close(s, coords)) && !(includes(description, s.city) && includes(description, s.country))) return reject(s, page.title, 'file-location-unconfirmed');
    if (s.kind === 'destination' && !articleVerified && !(coords && point(s) && close(s, coords) && includes(description, s.city) && includes(description, s.country))) return reject(s, page.title, 'destination-file-location-unconfirmed');
    const creator = text(meta.Artist?.value), license = text(meta.LicenseShortName?.value);
    const licenseUrl = reusableWikimediaLicense(license, meta.LicenseUrl?.value);
    const imageUrl = [info?.thumburl, info?.url].find(url => typeof url === 'string' && url.length <= 1000 && /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(url));
    if (!creator || creator.length > 200 || !licenseUrl) return reject(s, page.title, 'missing-or-oversized-creator-or-unsupported-license');
    if (meta.Restrictions?.value?.trim() || /^(?:true|1)$/i.test(meta.NonFree?.value || '')) return reject(s, page.title, 'restricted-or-nonfree-file');
    if (!/^image\/(?:jpeg|png|webp|avif)$/.test(info?.mime || '') || !imageUrl || !Number.isInteger(page.pageid) || page.pageid! < 1) return reject(s, page.title, 'invalid-photo-file');
    return { imageUrl, imageAttribution: { creator, license, licenseUrl, sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}` } };
  }
  async function lookup(s: Subject, signal?: AbortSignal): Promise<PlacePhoto | null> {
    const languages = s.countryCode && countries[s.countryCode as TCountryCode]?.languages || [];
    const langs = [...new Set(['en', ...languages.filter(lang => /^[a-z]{2,3}$/.test(lang))])].slice(0, 2);
    let names = [s.name];
    let articleFailure = false;
    const wikidataId = /^Q\d+$/.test(s.placeId || '') ? s.placeId : undefined;
    const sitelinks: Record<string, { title?: string }> = {};
    let entityFiles: string[] = [];
    let entityLocationVerified = false;
    const fileProps = { prop: 'imageinfo|coordinates', iiprop: 'url|mime|extmetadata', iiurlwidth: '960', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|ImageDescription|ObjectName|Categories|Medium|Restrictions|NonFree', colimit: 'max', coprimary: 'all' };
    if (wikidataId) {
      try {
      const data = await json('https://www.wikidata.org', {}, signal, wikidataId);
      const entity = data.entities?.[s.placeId!];
      const labels: string[] = langs.flatMap(lang => [entity?.labels?.[lang]?.value, ...(entity?.aliases?.[lang] || []).map((alias: any) => alias.value)]).filter(label => typeof label === 'string');
      const coords = (entity?.claims?.P625 || []).filter((claim: any) => claim.rank !== 'deprecated').map((claim: any) => claim.mainsnak?.datavalue?.value).filter((value: any) => value?.globe === 'http://www.wikidata.org/entity/Q2' && point(value));
      const locationMatches = !point(s) || !coords.length || coords.some((p: any) => close(s, { lat: p.latitude, lon: p.longitude }));
      if (coords.length && point(s) && !locationMatches) return reject(s, wikidataId, 'entity-location-conflicts-with-attraction');
      if (labels.some(label => normalize(label) === normalize(s.name)) && locationMatches) {
        names = [...new Set([s.name, ...labels])].slice(0, 8); Object.assign(sitelinks, entity?.sitelinks);
        // P18 is usable only with exact identity AND matching Earth coordinates;
        // a university-wide image must not bypass campus verification.
        if (point(s) && coords.some((p: any) => close(s, { lat: p.latitude, lon: p.longitude }))) {
          entityLocationVerified = true;
          entityFiles = (entity?.claims?.P18 || []).filter((claim: any) => claim.rank !== 'deprecated').map((claim: any) => claim.mainsnak?.datavalue?.value).filter((value: any) => typeof value === 'string').slice(0, 2);
        }
      } else reject(s, wikidataId, 'entity-name-or-coordinates-conflict');
      } catch (error) { articleFailure = true; console.warn('[TravelMate activity photos] Optional aliases unavailable:', error instanceof Error ? error.message : 'Request failed'); }
    }
    // A named, coordinate-verified P18 file can be checked directly in Commons.
    // This avoids spending the deadline on articles before inspecting its license.
    if (entityFiles.length) for (const file of pages(await json('https://commons.wikimedia.org', { ...fileProps, titles: entityFiles.map(name => `File:${name}`).join('|') }, signal))) { const result = await photo(file, s, names, true); if (result) return result; }
    // A known entity's real sitelinks take priority over a nonexistent English
    // article. Otherwise the paced English requests can exhaust the photo budget
    // before the correctly matched local-language article is ever checked.
    const languageOrder = wikidataId ? [...langs.filter(lang => sitelinks[`${lang}wiki`]), ...langs.filter(lang => !sitelinks[`${lang}wiki`])] : langs;
    for (const lang of languageOrder) {
      try {
      const host = `https://${lang}.wikipedia.org`, title = sitelinks[`${lang}wiki`]?.title || (s.kind === 'destination' && s.region && lang === 'en' ? `${s.name}|${s.name}, ${s.region}` : s.name);
      const props = { prop: 'pageimages|coordinates|pageprops|extracts|redirects|langlinks', piprop: 'thumbnail|name', pithumbsize: '960', pilicense: 'free', coprimary: 'primary', colimit: 'max', exintro: '1', explaintext: '1', exchars: '1000', redirects: '1', rdnamespace: '0', rdlimit: '10', lllang: langs.find(value => value !== lang) || 'en', lllimit: '1' };
      const directData = await json(host, { ...props, titles: title }, signal);
      for (const redirect of directData.query?.redirects || []) if (normalize(redirect.from || '') === normalize(title) && typeof redirect.to === 'string') names.push(redirect.to);
      const direct = pages(directData);
      // A city can share its name with a company. Search if its direct article
      // fails verification; do not accept the company's logo as a city cover.
      for (const search of [false, true]) {
      const candidates = search ? pages(await json(host, { ...props, generator: 'search', gsrsearch: `"${s.name.replaceAll('"', '')}" ${s.region || ''} ${s.city} ${s.country}${point(s) ? ` nearcoord:${s.kind === 'destination' ? 15 : 1}km,${s.latitude},${s.longitude}` : ''}`, gsrnamespace: '0', gsrlimit: '3' }, signal)) : direct;
      const verified = candidates.filter(page => {
        if (page.pageprops?.disambiguation !== undefined || !page.title || !Number.isInteger(page.pageid) || page.pageid! < 1) return false;
        if (wikidataId && page.pageprops?.wikibase_item && page.pageprops.wikibase_item !== wikidataId) { reject(s, page.title, 'different-place-entity'); return false; }
        const articleName = (page.title || '').replace(/\s*\([^)]*\)$/, '');
        const nameMatch = names.some(name => normalize(s.kind === 'destination' ? articleName.split(',')[0] : articleName) === normalize(name));
        const identityMatch = Boolean(wikidataId && sitelinks[`${lang}wiki`] && page.pageprops?.wikibase_item === wikidataId);
        const coords = page.coordinates?.[0];
        if (!(nameMatch || identityMatch) || (coords && point(s) && !close(s, coords)) || !(identityMatch && entityLocationVerified || coords && point(s) && close(s, coords) || includes(page.extract || '', s.city) && includes(page.extract || '', s.country))) { reject(s, page.title, 'article-identity-or-location-unconfirmed'); return false; }
        if (s.kind === 'destination' && !(coords && point(s) && close(s, coords) && includes(page.extract || '', s.country))) { reject(s, page.title, 'destination-article-location-unconfirmed'); return false; }
        return true;
      });
      if (new Set(verified.map(page => page.pageid)).size > 1) return reject(s, s.name, 'ambiguous-matching-articles');
      for (const page of verified) {
        names = [...new Set([...names, ...(page.redirects || []).map(entry => entry.title), ...(page.langlinks || []).map(entry => entry['*'])])].slice(0, 24);
        for (const link of page.langlinks || []) if (langs.includes(link.lang) && typeof link['*'] === 'string') sitelinks[`${link.lang}wiki`] = { title: link['*'] };
        // A placeholder SVG/logo is not a photo and needs no Commons image request.
        if (!page.pageimage || !/\.(?:jpe?g|png|webp|avif)$/i.test(page.pageimage)) continue;
        const files = pages(await json('https://commons.wikimedia.org', { ...fileProps, titles: `File:${page.pageimage}` }, signal));
        for (const file of files) {
          const result = await photo(file, s, names, true);
          if (!result) continue;
          // Only use the PageImages thumbnail after the selected file's rights
          // and identity are verified. Never accept an unrelated thumbnail URL.
          const thumbnail = page.thumbnail?.source;
          if (thumbnail && thumbnail.length <= 1000 && /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(thumbnail)) {
            try {
              const filename = decodeURIComponent(new URL(thumbnail).pathname).split('/').some(part => normalize(part) === normalize(page.pageimage!));
              if (filename) return { ...result, imageUrl: thumbnail };
            } catch { /* The ImageInfo thumbnail remains usable. */ }
          }
          return result;
        }
      }
      if (verified.length) break;
      }
      } catch (error) { articleFailure = true; console.warn('[TravelMate activity photos] Article lookup unavailable:', error instanceof Error ? error.message : 'Request failed'); }
    }
    // Search files only with the exact subject; location alone can never qualify a photo.
    const localNames = names.filter(name => normalize(name) !== normalize(s.name)).slice(0, 3);
    const query = `"${s.name.replaceAll('"', '')}" ${s.city} ${s.country} ${s.region || ''}`;
    const data = await json('https://commons.wikimedia.org', { ...fileProps, generator: 'search', gsrsearch: `${localNames.length ? `(${query} OR ${localNames.map(name => `"${name.replaceAll('"', '')}"`).join(' OR ')})` : query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '6' }, signal);
    for (const file of pages(data)) { const result = await photo(file, s, names, false); if (result) return result; }
    if (articleFailure) throw new Error('Article photo evidence was unavailable.');
    return null;
  }
  return async (subject: Subject, signal?: AbortSignal): Promise<PlacePhoto | null> => {
    const key = JSON.stringify([subject.kind, subject.region, subject.placeId, normalize(subject.name), normalize(subject.city), normalize(subject.country), subject.countryCode, subject.latitude, subject.longitude]);
    const cached = cache.get(key); if (cached && cached.until > now()) { console.info(JSON.stringify({ event: 'activity_photo_cache_hit', place: subject.name, matched: Boolean(cached.photo) })); return cached.photo; }
    if (pending.has(key)) return pending.get(key)!;
    const task = (async () => {
      let result: PlacePhoto | null = null, failed = false;
      try { result = await lookup(subject, signal); } catch (error) { failed = true; console.warn('[TravelMate activity photos]', error instanceof Error ? error.message : 'Lookup interrupted'); }
      if (cache.size >= 500) cache.delete(cache.keys().next().value!);
      cache.set(key, { until: now() + (failed ? 60000 : result ? 24 * 3600000 : 3600000), photo: result });
      return result;
    })().finally(() => pending.delete(key));
    pending.set(key, task); return task;
  };
}

export const findActivityPhoto = createActivityPhotoResolver((input, init) => fetch(input, init));
/** Shares the activity resolver's provider queue/cache, with city-cover geography. */
export const findDestinationPhoto = (destination: Omit<Subject, 'name' | 'kind'>, signal?: AbortSignal) => findActivityPhoto({ ...destination, name: destination.city, kind: 'destination' }, signal);
export function createItineraryActivityPhotoResolver(wikipedia = findActivityPhoto, unsplash = findUnsplashActivityPhoto, wikiBudgetMs = 16000) {
  return async (subject: Subject, signal?: AbortSignal): Promise<PlacePhoto | null> => {
    const wikiSignal = AbortSignal.any([AbortSignal.timeout(wikiBudgetMs), ...(signal ? [signal] : [])]);
    let exact: PlacePhoto | null = null;
    try { if (subject.kind !== 'generic') exact = await wikipedia(subject, wikiSignal); } catch { /* Reserve the remaining time for the existing fallback. */ }
    if (exact) return exact;
    if (signal?.aborted) return null;
    const fallback = await unsplash(subject, signal);
    return fallback ? { ...fallback, imageAttribution: { ...fallback.imageAttribution, illustrative: true, match: fallback.imageAttribution.match === 'place' ? 'activity' : fallback.imageAttribution.match } } : null;
  };
}
export const findItineraryActivityPhoto = createItineraryActivityPhotoResolver();
const findGeneratedActivityPhoto = createItineraryActivityPhotoResolver(undefined, undefined, 16000);
export type FailedActivityPhoto = { index: number; imageUrl: string };
export async function fillMissingDayPhotos(destination: string, day: DayPlan, resolver = findItineraryActivityPhoto, signal?: AbortSignal, selection?: string, failures: FailedActivityPhoto[] = []): Promise<DayPlan> {
  const activities = [...day.activities];
  let next = 0;
  // Two bounded workers share the provider queue. A slow/empty first activity
  // must not consume the entire day's lookup deadline before the second starts.
  await Promise.all(Array.from({ length: Math.min(2, activities.length) }, async () => {
    while (next < activities.length) {
      const index = next++, activity = day.activities[index];
      if (signal?.aborted) continue;
      if (activity.category === 'accommodation') continue;
      const saved = storedPhoto(activity);
      const failed = failures.some(photo => photo.index === index && photo.imageUrl === saved?.imageUrl);
      if (saved && !failed) {
        if (selection && activity.imageAttribution?.provider === 'unsplash' && !activity.imageAttribution.downloadTracked) activities[index] = { ...activity, ...await selectUnsplashActivityPhoto({ imageUrl: saved.imageUrl, imageAttribution: activity.imageAttribution }, selection, signal) };
        continue;
      }
      const subject = activityPhotoSubject(mapStoredActivity(activity as unknown as Record<string, unknown>) as unknown as DayActivity, destination);
      let result: PlacePhoto | null = null;
      try { result = subject ? await resolver(subject, signal) : null; } catch { /* A failed lookup never clears a saved activity or photo. */ }
      if (result && (!failed || result.imageUrl !== saved?.imageUrl)) {
        const selected = selection ? await selectUnsplashActivityPhoto(result, selection, signal) : result;
        const photo = { ...selected, imageAttribution: { ...selected.imageAttribution, photoType: selected.imageAttribution.illustrative ? 'illustrative' as const : 'place' as const } };
        activities[index] = { ...activity, ...photo };
        if (subject) {
          if (selectedPhotos.size >= 500) selectedPhotos.delete(selectedPhotos.keys().next().value!);
          selectedPhotos.set(subjectKey(subject), { photo, until: Date.now() + 86400000 });
        }
      }
    }
  }));
  const first = activities.find(activity => activity.imageUrl && activity.imageAttribution);
  const changed = activities.some((activity, index) => activity !== day.activities[index]);
  return { ...day, activities, ...(!day.imageUrl && first && changed ? { imageUrl: first.imageUrl!, imageAttribution: first.imageAttribution } : {}) };
}

/** Photo work has its own deadline; provider failures cannot fail generation. */
export async function fillGeneratedTripPhotos(plan: import('../../controllers/itinerary-controller.ts').ItineraryResponse, signal?: AbortSignal, resolver = findGeneratedActivityPhoto, budgetMs = 25000, selection?: string) {
  // Optional bulk enrichment remains bounded for callers of this helper.
  // Production generation returns catalog photos and enriches missing ones later.
  // A Google key blocked by billing must not disable non-Google enrichment.
  const deadline = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(signal ? [signal] : [])]);
  const days = [...plan.days]; let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, days.length) }, async () => {
    while (next < days.length && !deadline.aborted) {
      const index = next++;
      let abort: (() => void) | undefined;
      try {
        days[index] = await Promise.race([fillMissingDayPhotos(plan.destination, days[index], resolver, deadline, selection), new Promise<DayPlan>(resolve => {
          abort = () => resolve(plan.days[index]);
          if (deadline.aborted) abort(); else deadline.addEventListener('abort', abort, { once: true });
        })]);
      } catch { /* Keep the complete usable itinerary. */ }
      finally { if (abort) deadline.removeEventListener('abort', abort); }
    }
  }));
  return fillStoredDestinationDayPhotos({ ...plan, days });
}
