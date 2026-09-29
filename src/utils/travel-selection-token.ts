import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TravelSelectionTokenData {
  kind: 'flight' | 'activity';
  id: string;
  name: string;
  price: number;
  currency: string;
  fetchedAt: string;
}

function secret(): string {
  return process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me';
}

function payload(data: TravelSelectionTokenData): string {
  return [data.kind, data.id, data.name, String(data.price), data.currency, data.fetchedAt].join('|');
}

export function createTravelSelectionToken(data: TravelSelectionTokenData): string {
  return createHmac('sha256', secret()).update(payload(data)).digest('base64url');
}

export function verifyTravelSelectionToken(data: TravelSelectionTokenData, token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const expected = createTravelSelectionToken(data);
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
