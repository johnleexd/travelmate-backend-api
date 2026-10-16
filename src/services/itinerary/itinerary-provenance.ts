import { prisma } from '../../lib/prisma.ts';
import { verifyGroundedPlan } from './grounded-plan.ts';
import { parseSavedItinerary } from './saved-trip-schema.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';

export function itineraryContext(plan: ItineraryResponse) {
  return { days: plan.days.length, currency: plan.currency, budget: plan.totalBudget, travelers: plan.travelers ?? 1,
    partyType: plan.partyType ?? 'solo' as const, startDate: plan.days[0].date, destination: plan.destination };
}

/** Resolve only the current user's saved/generated baseline; never write a trip. */
export async function ownedItineraryBaseline(userId: string, value: unknown, suppliedBase?: unknown): Promise<ItineraryResponse> {
  const candidate = value as ItineraryResponse;
  if (!candidate || !Array.isArray(candidate.days) || !candidate.grounding || typeof candidate.groundingProof !== 'string') throw new Error('This plan has no verified destination reference. Reopen its original itinerary before retrying.');
  const context = itineraryContext(candidate);
  if (verifyGroundedPlan(candidate)) return parseSavedItinerary(candidate, context) as ItineraryResponse;
  if (suppliedBase && verifyGroundedPlan(suppliedBase as ItineraryResponse)) return parseSavedItinerary(suppliedBase, context) as ItineraryResponse;
  const proof = candidate.groundingProof;
  const saved = await prisma.trip.findFirst({ where: { userId, itinerary: { path: ['groundingProof'], equals: proof } }, select: { itinerary: true } });
  const generated = saved ? null : await prisma.itineraryGeneration.findFirst({ where: { userId, status: 'completed', response: { path: ['groundingProof'], equals: proof } }, select: { response: true } });
  const baseline = saved?.itinerary ?? generated?.response;
  if (!baseline) throw new Error('The original plan could not be verified. Your browser draft is unchanged. Reopen the original plan and retry.');
  return parseSavedItinerary(baseline, context) as ItineraryResponse;
}
