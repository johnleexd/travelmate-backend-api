import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './constant-time-equal.ts';

export interface OfferTokenData {
  hotelId: string;
  offerId: string;
  name: string;
  nightlyRate: number;
  currency: string;
  isLive: boolean;
  total?: number;
  destination?: string;
  checkInDate?: string;
  checkOutDate?: string;
  adults?: number;
  latitude?: number;
  longitude?: number;
  fetchedAt?: string;
  rooms?: number;
  address?: string;
}

function secret(): string {
  return process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me';
}

function payload(data: OfferTokenData): string {
  return JSON.stringify([data.hotelId, data.offerId, data.name, data.nightlyRate, data.currency, data.isLive, data.total, data.destination, data.checkInDate, data.checkOutDate, data.adults, data.latitude, data.longitude, data.fetchedAt, data.rooms, data.address]);
}

export function createOfferToken(data: OfferTokenData): string {
  return createHmac('sha256', secret()).update(payload(data)).digest('base64url');
}

export function verifyOfferToken(data: OfferTokenData, token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  if (data.fetchedAt !== undefined && (!Number.isFinite(Date.parse(data.fetchedAt)) || Date.now() - Date.parse(data.fetchedAt) > 2 * 60 * 60_000 || Date.parse(data.fetchedAt) - Date.now() > 5 * 60_000)) return false;
  const expected = createOfferToken(data);
  return constantTimeEqual(expected, token);
}
