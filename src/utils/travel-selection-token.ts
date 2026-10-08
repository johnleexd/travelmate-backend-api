import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './constant-time-equal.ts';

export interface TravelSelectionTokenData {
  kind: 'flight' | 'activity';
  id: string;
  name: string;
  price: number;
  currency: string;
  fetchedAt: string;
  isLive?: boolean;
  destination?: string;
  tripContext?: string;
}

function secret(): string {
  return process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me';
}

function payload(data: TravelSelectionTokenData): string {
  return [data.kind, data.id, data.name, String(data.price), data.currency, data.fetchedAt, data.isLive, data.destination, data.tripContext].join('|');
}

export function createTravelSelectionToken(data: TravelSelectionTokenData): string {
  return createHmac('sha256', secret()).update(payload(data)).digest('base64url');
}

export function verifyTravelSelectionToken(data: TravelSelectionTokenData, token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const age = Date.now() - Date.parse(data.fetchedAt);
  if (!Number.isFinite(age) || age < -300000 || age > (data.kind === 'flight' ? 15 * 60000 : 2 * 3600000)) return false;
  const expected = createTravelSelectionToken(data);
  return constantTimeEqual(expected, token);
}
