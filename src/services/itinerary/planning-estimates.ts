import type { CurrencyCode } from '../../schemas/domain.ts';
import type { PriceEvidence } from './grounding-schema.ts';

/** TravelMate planning-v1 allocations, adopted 2026-10-16. These are editable
 * contingency envelopes, NOT surveyed market averages, venue fees or fares.
 * Local-currency denominations reserve room for one visit, meals for one day,
 * one room/night, and one day's shared local transport respectively. No budget
 * percentage, FX assumption, travel-style premium or invented external source.
 * Unknown destination/currency combinations deliberately remain unpriced. */
const envelopes: Record<string, { currency: CurrencyCode; visit: number; food: number; room: number; transport: number }> = {
  PH: { currency: 'PHP', visit: 300, food: 600, room: 2000, transport: 600 },
  JP: { currency: 'JPY', visit: 2000, food: 4000, room: 12000, transport: 4000 },
  US: { currency: 'USD', visit: 25, food: 60, room: 150, transport: 60 },
  GB: { currency: 'GBP', visit: 20, food: 45, room: 120, transport: 45 },
  FR: { currency: 'EUR', visit: 20, food: 50, room: 130, transport: 50 },
  DE: { currency: 'EUR', visit: 20, food: 50, room: 130, transport: 50 },
  IT: { currency: 'EUR', visit: 20, food: 50, room: 130, transport: 50 },
  ES: { currency: 'EUR', visit: 20, food: 45, room: 110, transport: 45 },
  AU: { currency: 'AUD', visit: 35, food: 80, room: 200, transport: 80 },
  SG: { currency: 'SGD', visit: 35, food: 60, room: 180, transport: 60 },
  TH: { currency: 'THB', visit: 500, food: 900, room: 2500, transport: 900 },
};
export function planningAllowance(country: string, currency: CurrencyCode, category: 'visit' | 'food' | 'room' | 'transport', quantity: number, participants: number, fetchedAt: string): PriceEvidence {
  const rule = envelopes[country];
  const available = rule?.currency === currency;
  const unit = category === 'visit' ? 'per-person' : category === 'food' ? 'daily-per-person' : category === 'room' ? 'per-room-night' : 'day';
  return { status: available ? 'allowance' : 'unavailable', currency, unit,
    unitAmount: available ? rule[category] * (category === 'transport' ? Math.ceil(participants / 4) : 1) : 0,
    quantity, participants, source: available ? 'TravelMate planning allowance' : 'unavailable', fetchedAt, needsConfirmation: true,
    ruleId: `planning-v1:${country}:${category}`,
    ...(category === 'food' ? { coverage: 'daily-food' } : category === 'transport' ? { coverage: 'daily-transport' } : {}),
    basis: available ? `TravelMate planning-v1 (${country}, adopted 2026-10-16): editable ${category === 'visit' ? 'reserve for an unpriced visit; not an entrance fee' : category === 'room' ? 'generic room/night reserve; not a rate for the suggested property' : category === 'food' ? 'daily meal reserve per person; not menu prices' : `daily local transport reserve for ${Math.ceil(participants / 4)} group(s) of up to four; no vehicle, route or fare is promised`}. Independent of your budget; replace with your own estimate or a qualified source price.`
      : `No destination/category allowance rule for ${country} in ${currency}. Enter an estimate; missing prices are not free.`,
  };
}
