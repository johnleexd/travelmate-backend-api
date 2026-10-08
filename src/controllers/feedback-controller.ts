import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { PlatformActionError } from '../exceptions/index.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';
import { feedbackItinerary, listFeedback, submitFeedback, ownFeedback, feedbackDetails } from '../services/platform/feedback-service.ts';

function errorResponse(error: unknown): Response {
  if (isDatabaseConnectionError(error)) throw error;
  if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (error instanceof PlatformActionError) return Response.json({ error: error.message }, { status: 400 });
  console.error('[TravelMate] Feedback request failed:', error);
  return Response.json({ error: 'Feedback request failed.' }, { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'admin');
    return Response.json(await listFeedback(new URL(request.url).searchParams));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest(`feedback:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many feedback submissions. Try again shortly.' }, { status: 429 });
    const body: unknown = await request.json().catch(() => { throw new PlatformActionError('Request body must be valid JSON.'); });
    return Response.json({ result: await submitFeedback(user, body) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function OWN(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) || '');
    return Response.json({ result: await ownFeedback(user, id) });
  } catch (error) { return errorResponse(error); }
}

export async function ITINERARY(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'admin');
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-2) || '');
    if (!id || id.length > 200) throw new PlatformActionError('A valid feedback ID is required.');
    const itinerary = await feedbackItinerary(id);
    if (!itinerary) return Response.json({ error: 'Related itinerary is no longer available.' }, { status: 404 });
    return Response.json({ itinerary });
  } catch (error) { return errorResponse(error); }
}

export async function DETAIL(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'admin');
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) || '');
    const entry = await feedbackDetails(id);
    if (!entry) return Response.json({ error: 'Feedback not found.' }, { status: 404 });
    return Response.json({ entry });
  } catch (error) { return errorResponse(error); }
}
