import { z } from 'zod';
import type { Trip } from '../../generated/prisma/client.ts';
import { SUPPORTED_CURRENCIES } from '../../schemas/domain.ts';
import { MAX_INTERESTS, MAX_INTEREST_LENGTH } from '../../lib/trip-preferences.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const contextSchema = z.object({
  destination: z.string().trim().min(2).max(2000),
  destinationCity: z.string().max(200).nullable(), destinationRegion: z.string().max(1000).nullable(),
  destinationCountry: z.string().max(100).nullable(), destinationCountryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  latitude: z.number().finite().min(-90).max(90).nullable(), longitude: z.number().finite().min(-180).max(180).nullable(),
  budget: z.number().finite().positive().max(1_000_000_000), currency: z.enum(SUPPORTED_CURRENCIES),
  startDate: date, endDate: date, travelers: z.number().int().min(1).max(20),
  partyType: z.enum(['solo', 'couple', 'family', 'friends']), interests: z.array(z.string().max(MAX_INTEREST_LENGTH)).max(MAX_INTERESTS),
}).strict();
const snapshotSchema = z.object({ snapshotVersion: z.literal(1), context: contextSchema, itinerary: z.unknown() }).strict();

/** Version envelopes use the existing JSON column; no database migration is needed. */
export function createVersionSnapshot(trip: Trip) {
  return {
    snapshotVersion: 1,
    context: contextSchema.parse({
      destination: trip.destination,
      destinationCity: trip.destinationCity ?? null, destinationRegion: trip.destinationRegion ?? null,
      destinationCountry: trip.destinationCountry ?? null, destinationCountryCode: trip.destinationCountryCode ?? null,
      latitude: trip.latitude == null ? null : Number(trip.latitude), longitude: trip.longitude == null ? null : Number(trip.longitude),
      budget: Number(trip.budget), currency: trip.currency,
      startDate: trip.startDate.toISOString().slice(0, 10), endDate: trip.endDate.toISOString().slice(0, 10),
      travelers: trip.travelers, partyType: trip.partyType,
      interests: Array.isArray(trip.interests) ? trip.interests.map(String) : [],
    }),
    itinerary: trip.itinerary,
  };
}

export function readVersionSnapshot(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid itinerary snapshot.');
  if ('snapshotVersion' in value) {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid itinerary snapshot context.');
    return { ...parsed.data, legacy: false };
  }
  // Legacy rows retain these core details in their itinerary. Unrecorded
  // geographic details/interests are cleared rather than copied from another trip.
  const itinerary = value as Record<string, unknown>;
  const days = Array.isArray(itinerary.days) ? itinerary.days as Array<Record<string, unknown>> : [];
  const sharing = itinerary.costSharing as Record<string, unknown> | undefined;
  const travelers = itinerary.travelers ?? sharing?.travelers;
  const partyType = itinerary.partyType ?? sharing?.partyType;
  if (travelers === undefined || partyType === undefined) throw new Error('This older snapshot did not record its party details and cannot be restored safely. Your current trip is unchanged.');
  const context = contextSchema.parse({
    destination: itinerary.destination, budget: itinerary.totalBudget, currency: itinerary.currency,
    startDate: days[0]?.date, endDate: days.at(-1)?.date,
    travelers, partyType,
    destinationCity: null, destinationRegion: null, destinationCountry: null, destinationCountryCode: null,
    latitude: null, longitude: null, interests: [],
  });
  return { context, itinerary: value, legacy: true };
}
