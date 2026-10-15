import { createHash } from 'node:crypto';
import { accommodationDistanceKm } from '../destination/accommodation-places.ts';
import { currencyFractionDigits, hasValidCurrencyPrecision, normalizeCurrency } from '../../schemas/domain.ts';
import { accommodationQuoteSchema, occupancySchema, sealQuote, type AccommodationQuote, type ProviderAccommodation, type PropertyPhoto, type QuoteTicket, type RoomOccupancy } from './hotel-quote.ts';

type Json = Record<string, any>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const list = (v: unknown): any[] => Array.isArray(v) ? v : [];
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
export const isLatinContent = (s: string) => !/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{M}\p{S}]/u.test(s);
export type HotelSearchInput = { destination: string; latitude: number; longitude: number; countryCode?: string; checkInDate: string; checkOutDate: string; currency: string; occupancy: RoomOccupancy };
export class HotelQuoteError extends Error {
  readonly status: 'changed' | 'sold-out' | 'provider-error' | 'expired';
  constructor(message: string, status: 'changed' | 'sold-out' | 'provider-error' | 'expired' = 'provider-error') { super(message); this.status = status; }
}
export function rapidConfigured(env: NodeJS.ProcessEnv = process.env) { return Boolean(env.RAPID_API_KEY && env.RAPID_API_SECRET && !env.RAPID_API_KEY.startsWith('your_') && !env.RAPID_API_SECRET.startsWith('your_')); }
export function occupancyKey(room: RoomOccupancy[number]) { return String(room.adults) + (room.childAges.length ? '-' + room.childAges.join(',') : ''); }

function safePhotoUrl(url: unknown): string | undefined {
  try { const parsed = new URL(str(url)); return parsed.protocol === 'https:' && ['images.trvl-media.com', 'a.travel-assets.com'].includes(parsed.hostname) && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return; }
}
export function rapidPhotos(content: Json, env: NodeJS.ProcessEnv): PropertyPhoto[] {
  // Account-specific contractual permission and required credit text are prerequisites.
  if (env.RAPID_CONTENT_RIGHTS_CONFIRMED !== 'true' || !env.RAPID_PHOTO_ATTRIBUTION_TEXT) return [];
  return list(content.images).slice(0, 5).flatMap(image => {
    const versions = obj(obj(image).links);
    const chosen = obj(versions['1000px'] || versions['350px'] || versions['70px']);
    const url = safePhotoUrl(chosen.href);
    return url ? [{ reference: String(content.property_id) + ':' + new URL(url).pathname, url, caption: str(image.caption).slice(0, 300), attribution: {
      creator: env.RAPID_PHOTO_ATTRIBUTION_TEXT!.slice(0, 500), license: 'Provider-authorized photo',
      sourceUrl: url, ...(env.RAPID_PHOTO_TERMS_URL?.startsWith('https://') ? { licenseUrl: env.RAPID_PHOTO_TERMS_URL } : {}),
    } }] : [];
  });
}
function quotedAmount(raw: unknown) {
  const v = obj(raw), value = Number(v.value), currency = str(v.currency);
  if (v.value === undefined || v.value === '' || !Number.isFinite(value) || value < 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error('Missing quoted amount.');
  return { amount: value, currency };
}
function sumMoney(rows: Array<{ amount: number; currency: string }>) {
  const currency = rows[0]?.currency;
  if (!currency || rows.some(v => v.currency !== currency)) throw new Error('Mixed quote currencies.');
  const factor = 10 ** currencyFractionDigits(normalizeCurrency(currency));
  if (rows.some(v => !hasValidCurrencyPrecision(v.amount, normalizeCurrency(currency)))) throw new Error('Invalid quote precision.');
  return { amount: rows.reduce((sum, v) => sum + Math.round(v.amount * factor), 0) / factor, currency };
}
export function rapidQuote(rate: Json, room: Json, propertyId: string, input: HotelSearchInput, photos: PropertyPhoto[], checkedAt: string, isLive: boolean): AccommodationQuote | undefined {
  try {
    const pricing = input.occupancy.map(occupancy => obj(obj(rate.occupancy_pricing)[occupancyKey(occupancy)]));
    if (pricing.some(p => !Object.keys(p).length)) return;
    // Always use the provider's full-stay property-inclusive total for each actual room occupancy.
    const original = sumMoney(pricing.map(p => quotedAmount(obj(obj(p.totals).property_inclusive).billable_currency)));
    const approximate = sumMoney(pricing.map(p => quotedAmount(obj(obj(p.totals).property_inclusive).request_currency)));
    const fees = pricing.map(p => obj(obj(p.totals).property_fees).billable_currency).filter(Boolean).map(quotedAmount);
    const payableAtProperty = [...new Set(fees.map(f => f.currency))].map(currency => sumMoney(fees.filter(f => f.currency === currency)));
    const parts = pricing.flatMap(p => [...list(p.nightly).flatMap(list), ...list(p.stay)]).map(obj)
      .filter(p => p.value !== undefined && p.currency && p.type).map(p => ({ ...quotedAmount(p), label: str(p.type).replaceAll('_', ' ') }));
    const priceBreakdown = [...new Set(parts.map(p => p.label + ':' + p.currency))].map(key => {
      const values = parts.filter(p => p.label + ':' + p.currency === key);
      return { label: values[0].label, ...sumMoney(values) };
    });
    const nights = (Date.parse(input.checkOutDate) - Date.parse(input.checkInDate)) / 86400000;
    const factor = 10 ** currencyFractionDigits(normalizeCurrency(original.currency));
    return accommodationQuoteSchema.parse({
      provider: 'expedia-rapid', propertyId, roomId: str(room.id), offerId: str(rate.id), roomType: str(room.room_name),
      checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, occupancy: input.occupancy,
      currency: original.currency, total: original.amount, nightlyAverage: Math.round(original.amount / nights * factor) / factor,
      taxesAndFeesIncluded: true, payableAtProperty, priceBreakdown, ...(approximate.currency !== original.currency ? { approximateTotal: approximate } : {}),
      checkedAt, isLive, photoReferences: photos.map(p => p.reference),
    });
  } catch { return; }
}
export class RapidHotelProvider {
  readonly isLive: boolean;
  readonly baseUrl: string;
  private env: NodeJS.ProcessEnv;
  private fetcher: typeof fetch;
  constructor(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
    this.env = env; this.fetcher = fetcher;
    if (!rapidConfigured(env)) throw new HotelQuoteError('Room quotes are not configured.');
    this.isLive = env.RAPID_ENV === 'production';
    this.baseUrl = this.isLive ? 'https://api.ean.com' : 'https://test.ean.com';
  }
  private async request(endpoint: string) {
    // Accept only relative provider paths, including tokenized price-check links.
    if (!endpoint.startsWith('/v3/') || endpoint.startsWith('//') || endpoint.includes('\\')) throw new HotelQuoteError('Invalid provider quote link.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHash('sha512').update(this.env.RAPID_API_KEY! + this.env.RAPID_API_SECRET! + timestamp).digest('hex');
    let response: Response;
    try { response = await this.fetcher(this.baseUrl + endpoint, { headers: { Authorization: 'EAN APIKey=' + this.env.RAPID_API_KEY + ',Signature=' + signature + ',timestamp=' + timestamp, Accept: 'application/json', 'User-Agent': 'TravelMate/1.0' }, cache: 'no-store', signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw new HotelQuoteError('Room provider is temporarily unavailable. Retry accommodations.'); }
    if (!response.ok) throw new HotelQuoteError(response.status === 503 ? 'Room quote expired. Refresh accommodations.' : 'Room provider is temporarily unavailable. Retry accommodations.', response.status === 503 ? 'expired' : 'provider-error');
    try { return await response.json(); } catch { throw new HotelQuoteError('Room provider returned an unreadable response. Retry accommodations.'); }
  }
  async search(input: HotelSearchInput, userId: string, options: { suggestionsOnly?: boolean } = {}): Promise<ProviderAccommodation[]> {
    if (!options.suggestionsOnly) occupancySchema.parse(input.occupancy);
    const regionQuery = new URLSearchParams({ language: 'en-US', area: '3,' + input.latitude + ',' + input.longitude, type: 'city', limit: '3', include: 'property_ids', supply_source: 'expedia', ...(input.countryCode ? { country_code: input.countryCode } : {}) });
    const regions = await this.request('/v3/regions?' + regionQuery);
    const propertyIds = [...new Set(list(regions).flatMap(r => list(r.property_ids)).map(str).filter(id => /^\d+$/.test(id)))].slice(0, 40);
    if (!propertyIds.length) return [];
    const contentQuery = new URLSearchParams({ language: 'en-US', supply_source: 'expedia' });
    propertyIds.forEach(id => contentQuery.append('property_id', id));
    const payload = obj(await this.request('/v3/properties/content?' + contentQuery));
    let properties: ProviderAccommodation[] = propertyIds.flatMap(id => {
      const c = obj(payload[id]), coordinates = obj(obj(c.location).coordinates), address = obj(c.address);
      const latitude = Number(coordinates.latitude), longitude = Number(coordinates.longitude), name = str(c.name);
      // Join content, imagery and shopping ONLY on exact provider IDs, never map-name guesses.
      if (str(c.property_id) !== id || !name || typeof coordinates.latitude !== 'number' || typeof coordinates.longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (input.countryCode && address.country_code !== input.countryCode)) return [];
      const distanceKm = accommodationDistanceKm(input.latitude, input.longitude, latitude, longitude);
      if (distanceKm > 30) return [];
      const english = isLatinContent(name);
      return [{ id: 'rapid:' + id, propertyId: id, name: name.slice(0,150), originalName: name.slice(0,150), nameSource: english ? 'provider-english' as const : 'unavailable' as const,
        address: [address.line_1, address.line_2, address.city, address.state_province_name, address.postal_code, address.country_code].map(str).filter(v => v && isLatinContent(v)).join(', ').slice(0,300) || 'Address unavailable',
        type: isLatinContent(str(obj(c.category).name)) ? str(obj(c.category).name) || 'Accommodation' : 'Accommodation', latitude, longitude, distanceKm: Math.round(distanceKm * 10) / 10,
        ...(Number(obj(obj(c.ratings).property).rating) > 0 ? { rating: Number(obj(obj(c.ratings).property).rating) } : {}),
        amenities: Object.values(obj(c.amenities)).map(v => str(obj(v).name)).filter(v => Boolean(v) && isLatinContent(v)).slice(0,12), photos: rapidPhotos(c, this.env), availability: 'price-unavailable' as const,
      }];
    });
    const { localizePropertyNames } = await import('../destination/accommodation-localization.ts');
    properties = (await localizePropertyNames(properties, this.env, this.fetcher)).map(p => ({ ...p, name: p.nameSource === 'unavailable' ? 'Accommodation name unavailable in English' : p.name }));
    if (options.suggestionsOnly) return properties;
    const query = new URLSearchParams({ checkin: input.checkInDate, checkout: input.checkOutDate, currency: input.currency, country_code: this.env.RAPID_POINT_OF_SALE_COUNTRY || 'PH', language: 'en-US', rate_plan_count: '3', sales_channel: 'website', sales_environment: 'hotel_only', include: 'unavailable_reason' });
    properties.forEach(p => query.append('property_id', p.propertyId));
    input.occupancy.forEach(room => query.append('occupancy', occupancyKey(room)));
    if (!properties.length) return [];
    const checkedAt = new Date().toISOString();
    let shopping: any[];
    try { shopping = list(await this.request('/v3/properties/availability?' + query)); }
    catch { return properties.map(p => ({ ...p, availability: 'provider-error' })); }
    return properties.flatMap((property): ProviderAccommodation[] => {
      const response = obj(shopping.find(p => str(p.property_id) === property.propertyId));
      const reason = str(obj(response.unavailable_reason).code);
      if (reason) return [{ ...property, availability: ['no_inventory_available', 'partial_inventory_available'].includes(reason) ? 'sold-out' : 'unavailable' }];
      const choices: ProviderAccommodation[] = [];
      for (const room of list(response.rooms).map(obj)) for (const rate of list(room.rates).map(obj)) {
        const quote = rapidQuote(rate, room, property.propertyId, input, property.photos, checkedAt, this.isLive);
        const bedGroup = Object.values(obj(rate.bed_groups)).map(obj).find(group => obj(obj(group.links).price_check).href);
        const link = str(obj(obj(bedGroup?.links).price_check).href);
        // Missing a price-check link means no confirmable quote, even if a price was present.
        if (!quote || !link.startsWith('/v3/properties/' + property.propertyId + '/rooms/') || new URL(link, this.baseUrl).pathname !== '/v3/properties/' + property.propertyId + '/rooms/' + encodeURIComponent(quote.roomId) + '/rates/' + encodeURIComponent(quote.offerId)) continue;
        const selected = { ...property, id: property.id + ':' + quote.roomId + ':' + quote.offerId, quote, availability: 'available' as const };
        choices.push({ ...selected, quoteToken: sealQuote({ userId, expiresAt: Date.now() + 10 * 60_000, destination: input.destination, latitude: input.latitude, longitude: input.longitude, property: selected, priceCheckPath: link }) });
      }
      return choices.length ? choices.slice(0, 3) : [property];
    });
  }
  async revalidate(ticket: QuoteTicket) {
    const quote = ticket.property.quote!;
    const expected = '/v3/properties/' + quote.propertyId + '/rooms/' + encodeURIComponent(quote.roomId) + '/rates/' + encodeURIComponent(quote.offerId);
    if (new URL(ticket.priceCheckPath, this.baseUrl).pathname !== expected || this.isLive !== quote.isLive) throw new HotelQuoteError('Refresh the selected room quote.', 'expired');
    const checked = obj(await this.request(ticket.priceCheckPath));
    if (checked.status === 'sold_out') throw new HotelQuoteError('This room is sold out for the selected dates. Choose another room.', 'sold-out');
    if (checked.status === 'price_changed') throw new HotelQuoteError('The room price changed. Refresh accommodations and review the new quote.', 'changed');
    if (checked.status !== 'matched') throw new HotelQuoteError('The room is no longer available. Refresh accommodations.', 'expired');
    // Never expose or save the short-lived booking link; TravelMate only plans trips.
    return { ...ticket.property, quote: { ...quote, checkedAt: new Date().toISOString(), revalidatedAt: new Date().toISOString() } };
  }
}
