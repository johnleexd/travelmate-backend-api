import { requireUser } from '../middlewares/auth-middleware.ts';
import { PlatformActionError } from '../exceptions/index.ts';
import { readActivityLog } from '../repositories/activity-log-repository.ts';
import { isDatabaseConnectionError, retryDatabaseOperation } from '../lib/database-retry.ts';

export async function GET_ACTIVITY_LOG(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'admin');
    const result = await retryDatabaseOperation(() => readActivityLog(new URL(request.url).searchParams));
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: 'Admin authentication required.' }, { status: 401 });
    if (error instanceof PlatformActionError) return Response.json({ error: error.message }, { status: 400 });
    if (isDatabaseConnectionError(error)) throw error;
    // No raw audit payloads or database diagnostics in the response.
    console.error('[TravelMate] Activity log could not be loaded.');
    return Response.json({ error: 'Could not load activity. Please try again.' }, { status: 500 });
  }
}
