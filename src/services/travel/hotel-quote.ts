import { z } from 'zod';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SUPPORTED_CURRENCIES } from '../../schemas/domain.ts';

export const occupancySchema = z.array(z.object({
  adults: z.number().int().min(1).max(8),
  childAges: z.array(z.number().int().min(0).max(17)).max(6),
}).strict()).min(1).max(8);
export type RoomOccupancy = z.infer<typeof occupancySchema>;
const amount = z.number().finite().nonnegative().max(1_000_000_000);
const moneySchema = z.object({ amount, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const propertyPhotoSchema = z.object({
  reference: z.string().max(1000), url: z.string().url().max(1500), caption: z.string().max(300),
  attribution: z.object({ creator: z.string().max(500), license: z.string().max(100), sourceUrl: z.string().url().max(1500), licenseUrl: z.string().url().max(1500).optional() }).strict(),
}).strict();
export const accommodationQuoteSchema = z.object({
  provider: z.enum(['expedia-rapid', 'liteapi']), propertyId: z.string().regex(/^(?:\d+|lp[a-z0-9]+)$/i).max(40),
  roomId: z.string().min(1).max(8000), offerId: z.string().min(1).max(12000),
  roomType: z.string().min(1).max(300), checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), occupancy: occupancySchema,
  currency: z.enum(SUPPORTED_CURRENCIES), total: amount.positive(), nightlyAverage: amount,
  taxesAndFeesIncluded: z.boolean().optional(), payableAtProperty: z.array(moneySchema).max(32),
  budgetTotal: amount.positive().optional(), guestNationality: z.string().regex(/^[A-Z]{2}$/).optional(),
  taxDetails: z.array(z.object({ description: z.string().max(100), included: z.boolean().optional(), amount: amount.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict()).max(64).optional(),
  priceBreakdown: z.array(z.object({ label: z.string().max(100), amount, currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(16),
  approximateTotal: moneySchema.optional(), checkedAt: z.string().datetime(), isLive: z.boolean(),
  photoReferences: z.array(z.string().max(1000)).max(5), revalidatedAt: z.string().datetime().optional(),
}).strict();
export type AccommodationQuote = z.infer<typeof accommodationQuoteSchema>;
export type PropertyPhoto = z.infer<typeof propertyPhotoSchema>;
export type ProviderAccommodation = {
  id: string; propertyId: string; name: string; originalName?: string; nameSource: 'provider-english' | 'transliterated' | 'unavailable';
  address: string; type: string; latitude: number; longitude: number; distanceKm: number;
  rating?: number; amenities: string[]; photos: PropertyPhoto[]; environment?: 'sandbox' | 'production'; providerMessage?: string;
  availability: 'available' | 'sold-out' | 'unavailable' | 'price-unavailable' | 'provider-error';
  quote?: AccommodationQuote; quoteToken?: string;
};
export type QuoteTicket = {
  userId: string; expiresAt: number; destination: string; latitude: number; longitude: number;
  property: Omit<ProviderAccommodation, 'quoteToken'>; priceCheckPath: string;
  liteSearch?: { guestNationality: string; sessionId: string; roomSignature: string };
};
function key() {
  const secret = process.env.ACCOMMODATION_QUOTE_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('A strong ACCOMMODATION_QUOTE_SECRET or SESSION_SECRET is required for hotel quotes.');
  return createHash('sha256').update('accommodation-quote-v1:' + secret).digest();
}
export function sealQuote(ticket: QuoteTicket) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(ticket)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function openQuote(token: unknown, userId: string): QuoteTicket {
  try {
    if (typeof token !== 'string' || token.length > 160_000) throw new Error();
    const bytes = Buffer.from(token, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const ticket = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as QuoteTicket;
    if (ticket.userId !== userId || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) throw new Error();
    accommodationQuoteSchema.parse(ticket.property.quote);
    return ticket;
  } catch { throw new Error('This room quote expired or is invalid. Refresh accommodations and select the room again.'); }
}
