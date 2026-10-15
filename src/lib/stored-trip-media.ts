/** Read historical photo shapes without consulting providers or changing the record. */
type RecordValue = Record<string, unknown>;
export type StoredCredit = {
  creator: string; license: string; sourceUrl: string; licenseUrl?: string;
  provider?: 'unsplash'; photoType?: 'place' | 'illustrative' | 'destination' | 'saved';
  photoId?: string; photographerUrl?: string; illustrative?: boolean; match?: 'place' | 'destination' | 'activity';
};
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const string = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined;

export function storedImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'images.unsplash.com' && url.pathname.startsWith('/photo-')) return value;
    return ['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) && url.pathname.startsWith('/wikipedia/commons/') && /\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname) ? value : null;
  } catch { return null; }
}

export function storedPhoto(value: unknown): { imageUrl: string; imageAttribution?: StoredCredit } | null {
  const item = object(value), image = object(item.image), photo = object(item.photo), place = object(item.place);
  const rawUrl = string(item.imageUrl, item.imageURL, item.image_url, item.photoUrl, item.photo_url, item.thumbnailUrl, item.src, item.url,
    item.image, item.photo, image.url, image.src, photo.url, photo.src, place.imageUrl, place.photoUrl);
  const imageUrl = storedImageUrl(rawUrl);
  if (!imageUrl) return null;
  const raw = [item.imageAttribution, item.image_attribution, item.photoAttribution, item.photo_attribution, item.attribution, image.attribution, photo.attribution, place.imageAttribution].map(object).find(credit => Object.keys(credit).length) || {};
  if (!Object.keys(raw).length) return { imageUrl };
  // Preserve complete canonical metadata, including provider download tracking.
  if (typeof raw.creator === 'string' && typeof raw.license === 'string' && typeof raw.sourceUrl === 'string') return { imageUrl, imageAttribution: raw as StoredCredit };
  const license = object(raw.license);
  return { imageUrl, imageAttribution: { ...raw, creator: string(raw.creator, raw.author, raw.photographer, raw.artist) || '',
    license: string(raw.license, raw.licenseName, license.name, license.shortName) || '', sourceUrl: string(raw.sourceUrl, raw.source_url, raw.pageUrl, raw.source, image.sourceUrl, photo.sourceUrl) || '',
    ...(string(raw.licenseUrl, raw.license_url, license.url) ? { licenseUrl: string(raw.licenseUrl, raw.license_url, license.url) } : {}) } as StoredCredit };
}

/** Compatibility mapping is local and limited to photo/name aliases. */
export function mapStoredActivity<T extends RecordValue>(activity: T): T {
  const photo = storedPhoto(activity);
  const title = string(activity.title, activity.name, object(activity.place).name);
  if ((!photo || activity.imageUrl === photo.imageUrl && (!photo.imageAttribution || activity.imageAttribution === photo.imageAttribution)) && (!title || activity.title === title)) return activity;
  return { ...activity, ...(title ? { title } : {}), ...(photo || {}) };
}

/** Convert recognized historical aliases when writing through the current schema. */
export function canonicalStoredMedia<T extends RecordValue>(record: T, activity = false): T {
  const photo = storedPhoto(record);
  const mapped = activity ? mapStoredActivity(record) : { ...record, ...(photo || {}) };
  if (!photo && mapped === record) return record;
  const output = { ...mapped } as RecordValue;
  if (photo) {
    for (const key of ['image', 'imageURL', 'image_url', 'photo', 'photoUrl', 'photo_url', 'thumbnailUrl', 'src', 'url', 'image_attribution', 'photoAttribution', 'photo_attribution', 'attribution']) delete output[key];
    if (photo.imageAttribution) {
      const keys = new Set(['creator', 'license', 'licenseUrl', 'sourceUrl', 'provider', 'photoType', 'photoId', 'photographerUrl', 'photographerUsername', 'illustrative', 'match', 'downloadLocation', 'downloadTracked', 'selectedAt']);
      output.imageAttribution = Object.fromEntries(Object.entries(photo.imageAttribution).filter(([key]) => keys.has(key)));
    }
  }
  if (activity && output.title && !record.title) delete output.name;
  return output as T;
}
