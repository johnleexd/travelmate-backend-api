import { z } from 'zod';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { ownedItineraryBaseline, itineraryContext } from '../services/itinerary/itinerary-provenance.ts';
import { applyManualItineraryChanges } from '../services/itinerary/itinerary-edit-service.ts';
import { loadGroundedPlaces } from '../services/itinerary/grounded-places.ts';
import { retryIncompleteDays } from '../services/itinerary/incomplete-day-retry.ts';
import { parseSavedItinerary } from '../services/itinerary/saved-trip-schema.ts';
import { verifyGroundedPlan } from '../services/itinerary/grounded-plan.ts';
import type { ItineraryResponse } from './itinerary-controller.ts';

const requestSchema = z.object({ itinerary: z.unknown(), providerBase: z.unknown().optional(), days: z.array(z.number().int().min(0).max(30)).min(1).max(31), includeNearby: z.boolean().default(false) }).strict();
export async function POST_RETRY_DAYS(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest(`retry-days:${user.id}`, 10, 60_000)) return Response.json({ error: 'Please wait a moment before retrying more days.' }, { status: 429 });
    const input = requestSchema.safeParse(await request.json());
    if (!input.success) return Response.json({ error: 'Choose the days to retry.' }, { status: 400 });
    const baseline = await ownedItineraryBaseline(user.id, input.data.itinerary, input.data.providerBase);
    const context = itineraryContext(baseline);
    const edited = verifyGroundedPlan(input.data.itinerary as ItineraryResponse) ? baseline
      : applyManualItineraryChanges(baseline, input.data.itinerary, context.days, context.budget, context.travelers, context.currency) as unknown as ItineraryResponse;
    // No AI call and no trip write. Force a fresh, bounded provider lookup.
    const catalog = await loadGroundedPlaces(baseline.grounding!.destination, AbortSignal.timeout(100_000), false, { tripDays: context.days, forceRefresh: true });
    const result = retryIncompleteDays(edited, input.data.days, catalog, input.data.includeNearby, baseline);
    return Response.json({ ...result, itinerary: parseSavedItinerary(result.itinerary, context) });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    console.warn(JSON.stringify({ event: 'incomplete_day_retry_failed', error: error instanceof Error ? error.name : 'RequestError' }));
    return Response.json({ error: 'Could not refresh these days. Your existing itinerary and browser draft are preserved. Please retry.' }, { status: 422 });
  }
}
