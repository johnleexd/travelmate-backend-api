import { createHmac, timingSafeEqual } from 'node:crypto';

export interface OfferTokenData {
  hotelId: string;
  offerId: string;
  name: string;
  nightlyRate: number;
  isLive: boolean;
}

function secret(): string {
  return process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me';
}

function payload(data: OfferTokenData): string {
  return [data.hotelId, data.offerId, data.name, String(data.nightlyRate), data.isLive ? 'live' : 'test'].join('|');
}

export function createOfferToken(data: OfferTokenData): string {
  return createHmac('sha256', secret()).update(payload(data)).digest('base64url');
}

export function verifyOfferToken(data: OfferTokenData, token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const expected = createOfferToken(data);
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
