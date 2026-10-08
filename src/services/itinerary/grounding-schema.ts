import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../../schemas/domain.ts';

const text = z.string().max(1000);
const amount = z.number().finite().min(0).max(1_000_000_000);
export const destinationAnchorSchema = z.object({
  city: z.string().trim().min(2).max(100), country: z.string().trim().min(2).max(100),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
}).strict();
export const priceEvidenceSchema = z.object({
  status: z.enum(['provider-quote', 'estimate', 'unavailable']),
  basis: text, source: text, sourceUrl: z.string().url().max(1000).optional(),
  fetchedAt: z.string().datetime({ offset: true }), currency: z.enum(SUPPORTED_CURRENCIES),
  unitAmount: amount, quantity: z.number().int().min(0).max(10000),
  unit: z.enum(['per-person', 'shared-fare', 'per-room-night', 'group', 'daily-per-person']),
  participants: z.number().int().min(1).max(20), needsConfirmation: z.boolean(),
}).strict();
export const placeEvidenceSchema = z.object({
  provider: z.literal('wikidata'), placeId: z.string().regex(/^Q\d+$/), name: text,
  city: text, country: text, countryCode: z.string().regex(/^[A-Z]{2}$/),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  sourceUrl: z.string().url(), fetchedAt: z.string().datetime({ offset: true }),
  openingHours: text, address: text,
}).strict();
export const groundingSchema = z.object({
  version: z.literal(1), destination: destinationAnchorSchema,
  startingLocation: z.string().max(200), startDate: z.string(), endDate: z.string(),
  fetchedAt: z.string().datetime({ offset: true }),
  placeDataStatus: z.enum(['live', 'fresh-cache', 'stale-cache', 'unavailable']),
  currency: z.enum(SUPPORTED_CURRENCIES), rooms: z.number().int().min(1).max(20),
  nights: z.number().int().min(0).max(30), foodDailyPerPerson: amount,
  accommodation: priceEvidenceSchema,
  additionalFees: amount, contingencyPercent: z.number().min(0).max(50), contingencyAmount: amount,
  categories: z.object({ accommodation: amount, food: amount, activities: amount, transportation: amount, fees: amount, contingency: amount }).strict(),
  subtotal: amount, total: amount, verifiedAmount: amount, estimatedAmount: amount,
  unknownPriceCount: z.number().int().min(0).max(1000),
  budgetStatus: z.enum(['exceeds-budget', 'needs-confirmation', 'within-quoted-budget']),
  limitations: z.array(text).max(20),
}).strict();
export type DestinationAnchor = z.infer<typeof destinationAnchorSchema>;
export type PriceEvidence = z.infer<typeof priceEvidenceSchema>;
export type PlaceEvidence = z.infer<typeof placeEvidenceSchema>;
export type PlanGrounding = z.infer<typeof groundingSchema>;

export class GroundingInputError extends Error {}
