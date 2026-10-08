import type { NearbyAccommodation } from './accommodation-places.ts';

type Entity = { labels?: Record<string, { value?: string }>; aliases?: Record<string, Array<{ value?: string }>>; claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> };
const plain = (value: unknown) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 500) : '';
const safeFile = (value: unknown) => typeof value === 'string' && value.length <= 250 && !/[|\n\r]/.test(value) && /\.(jpe?g|png|webp|avif)$/i.test(value) ? value.replace(/^File:/i, '').replaceAll('_', ' ') : undefined;
async function json(host: string, params: Record<string, string>, fetcher: typeof fetch) {
  const response = await fetcher(host + '/w/api.php?' + new URLSearchParams({ format: 'json', ...params }), {
    headers: { 'User-Agent': 'TravelMate/1.0 property-photo-lookup', 'Api-User-Agent': 'TravelMate/1.0 property-photo-lookup' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Property photo service unavailable.');
  return response.json();
}

/** Only exact property-linked files, never hotel-name or destination image searches. */
export async function attachAccommodationPhotos(rows: NearbyAccommodation[], fetcher: typeof fetch = fetch): Promise<NearbyAccommodation[]> {
  const files = new Map<string, string>();
  for (const row of rows) {
    const file = safeFile(row.commonsFile);
    if (file) files.set(row.id, file);
  }
  const ids = [...new Set(rows.filter(row => !files.has(row.id) && row.wikidataId).map(row => row.wikidataId!))];
  if (ids.length) {
    try {
      const data = await json('https://www.wikidata.org', { action: 'wbgetentities', ids: ids.slice(0, 40).join('|'), props: 'claims|labels|aliases' }, fetcher);
      for (const row of rows) {
        if (files.has(row.id) || !row.wikidataId) continue;
        const entity = data.entities?.[row.wikidataId] as Entity | undefined;
        const point = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value as { latitude?: number; longitude?: number } | undefined;
        if (typeof point?.latitude !== 'number' || typeof point.longitude !== 'number' || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
          || Math.abs(point.latitude - row.latitude) > 0.002 || Math.abs(point.longitude - row.longitude) > 0.002) continue;
        const comparable = (value: string) => value.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        const names = [entity?.labels?.en?.value, ...Object.values(entity?.aliases || {}).flat().map(alias => alias.value)].filter((v): v is string => Boolean(v));
        const addresses = entity?.claims?.P6375?.map(claim => (claim.mainsnak?.datavalue?.value as { text?: string })?.text).filter((v): v is string => Boolean(v)) || [];
        if (!names.some(name => comparable(name) === comparable(row.name) || comparable(name) === comparable(row.originalName || '')) || !addresses.some(address => comparable(address) === comparable(row.address))) continue;
        const file = safeFile(entity?.claims?.P18?.find(claim => safeFile(claim.mainsnak?.datavalue?.value))?.mainsnak?.datavalue?.value);
        if (file) files.set(row.id, file);
      }
    } catch { /* Property discovery remains usable without photo providers. */ }
  }
  const images = new Map<string, Pick<NearbyAccommodation, 'imageUrl' | 'imageAttribution'>>();
  const titles = [...new Set([...files.values()].map(file => 'File:' + file))].slice(0, 40);
  if (titles.length) {
    try {
      const data = await json('https://commons.wikimedia.org', { action: 'query', titles: titles.join('|'), prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '640' }, fetcher);
      for (const page of Object.values(data.query?.pages || {}) as Array<{ title?: string; pageid?: number; imageinfo?: Array<{ mime?: string; thumburl?: string; url?: string; extmetadata?: Record<string, { value?: string }> }> }>) {
        const info = page.imageinfo?.[0], meta = info?.extmetadata || {};
        const creator = plain(meta.Artist?.value), license = plain(meta.LicenseShortName?.value);
        const imageUrl = info?.thumburl || info?.url;
        const cc = license.match(/^CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)$/i);
        const publicDomain = /^(CC0(?: 1\.0)?|Public domain)$/i.test(license);
        // Require usable per-file rights; unknown/restricted licenses and non-photos remain placeholders.
        if (!page.title || !Number.isInteger(page.pageid) || !creator || (!cc && !publicDomain)
          || !/^image\/(jpeg|png|webp|avif)$/.test(info?.mime || '')
          || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(imageUrl || '')
          || /\b(map|logo|drawing|illustration|AI-generated|AI generated)\b/i.test(page.title + ' ' + plain(meta.ImageDescription?.value))
          || Boolean(plain(meta.Restrictions?.value))) continue;
        const licenseUrl = cc ? 'https://creativecommons.org/licenses/' + cc[1].toLowerCase() + '/' + cc[2] + '/' : /^CC0(?: 1\.0)?$/i.test(license) ? 'https://creativecommons.org/publicdomain/zero/1.0/' : 'https://creativecommons.org/publicdomain/mark/1.0/';
        images.set(page.title.replaceAll('_', ' '), { imageUrl, imageAttribution: { creator, license, licenseUrl, sourceUrl: 'https://commons.wikimedia.org/?curid=' + page.pageid } });
      }
    } catch { /* Missing attribution or inaccessible images must not block selection. */ }
  }
  return rows.map(({ commonsFile, wikidataId, ...row }) => ({ ...row, ...(files.has(row.id) ? images.get('File:' + files.get(row.id)) : {}) }));
}
