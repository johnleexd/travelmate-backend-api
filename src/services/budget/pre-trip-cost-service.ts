import { hasValidCurrencyPrecision, type CurrencyCode } from '../../schemas/domain.ts';

export const PASSPORT_STATUSES = ['valid', 'needs_application', 'needs_renewal', 'not_sure'] as const;
export type PassportStatus = typeof PASSPORT_STATUSES[number];

export interface PreTripCostInput {
  startingLocation?: unknown;
  departureAirport?: unknown;
  passportCountry?: unknown;
  passportStatus?: unknown;
  airportTransferOutbound?: unknown;
  airportTransferReturn?: unknown;
  passport?: unknown;
  visaOrAuthorization?: unknown;
  departureTaxes?: unknown;
  insurance?: unknown;
  other?: unknown;
}

export interface PreTripCosts {
  startingLocation?: string;
  departureAirport?: string;
  passportCountry?: string;
  passportStatus?: PassportStatus;
  airportTransferOutbound: number;
  airportTransferReturn: number;
  passport: number;
  visaOrAuthorization: number;
  departureTaxes: number;
  insurance: number;
  other: number;
  total: number;
  currency: CurrencyCode;
  source: 'user-entered-estimate';
}

const COST_FIELDS = ['airportTransferOutbound', 'airportTransferReturn', 'passport', 'visaOrAuthorization', 'departureTaxes', 'insurance', 'other'] as const;

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 120) throw new Error(`${label} must be 120 characters or fewer.`);
  return value.trim() || undefined;
}

export function normalizePreTripCosts(value: unknown, currency: CurrencyCode): PreTripCosts | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Pre-trip costs must be an object.');
  const input = value as PreTripCostInput;
  const costs = Object.fromEntries(COST_FIELDS.map((field) => {
    const amount = input[field] === undefined || input[field] === '' ? 0 : Number(input[field]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000 || !hasValidCurrencyPrecision(amount, currency)) {
      throw new Error(`Pre-trip ${field} must be a valid non-negative ${currency} amount.`);
    }
    return [field, Math.round(amount * 100) / 100];
  })) as Record<(typeof COST_FIELDS)[number], number>;
  const passportStatus = input.passportStatus === undefined || input.passportStatus === '' ? undefined : String(input.passportStatus);
  if (passportStatus && !PASSPORT_STATUSES.includes(passportStatus as PassportStatus)) throw new Error('Select a valid passport status.');
  const total = Math.round(COST_FIELDS.reduce((sum, field) => sum + costs[field], 0) * 100) / 100;
  return {
    startingLocation: optionalText(input.startingLocation, 'Starting location'),
    departureAirport: optionalText(input.departureAirport, 'Departure airport'),
    passportCountry: optionalText(input.passportCountry, 'Passport country'),
    passportStatus: passportStatus as PassportStatus | undefined,
    ...costs,
    total,
    currency,
    source: 'user-entered-estimate',
  };
}
