import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { enrichSavedActivityPhotos } from '../services/itinerary/saved-activity-photos.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';

/** Explicit POST enriches server-owned activities, never a submitted itinerary. */
export async function POST_SAVED_ACTIVITY_PHOTOS(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest(`saved-activity-photos:${user.id}`, 20, 60000)) return Response.json({ error: 'Photo lookup limit reached. Try again shortly.' }, { status: 429 });
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-2)!);
    const body = await request.json().catch(() => null);
    if (!/^[\w-]{1,200}$/.test(id) || !Number.isInteger(body?.day) || body.day < 1 || body.day > 31) return Response.json({ error: 'A saved trip and day are required.' }, { status: 400 });
    const failures = body.failedPhotos;
    if (failures !== undefined && (!Array.isArray(failures) || failures.length > 8 || failures.some(photo => !Number.isInteger(photo?.index) || photo.index < 0 || photo.index > 7 || typeof photo.imageUrl !== 'string' || photo.imageUrl.length > 1000))) return Response.json({ error: 'Invalid failed photo identities.' }, { status: 400 });
    const googleFailedIndices = body.googleFailedIndices || [];
    if (!Array.isArray(googleFailedIndices) || googleFailedIndices.length > 8 || googleFailedIndices.some(index => !Number.isInteger(index) || index < 0 || index > 7)) return Response.json({ error: 'Invalid Google photo failures.' }, { status: 400 });
    const result = await enrichSavedActivityPhotos(user.id, id, body.day, undefined, failures || [], true, googleFailedIndices);
    return result ? Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } }) : Response.json({ error: 'Saved itinerary day not found.' }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    if (isDatabaseConnectionError(error)) throw error;
    console.warn('[TravelMate saved activity photos] Enrichment unavailable.');
    return Response.json({ error: 'Activity photos are temporarily unavailable; the saved trip is unchanged.' }, { status: 502 });
  }
}
