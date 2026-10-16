import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { NavigationError, fetchNavigationRoute, navigationRequestSchema, searchNavigationDestinations } from '../services/navigation/navigation-service.ts';
import { nextStopOptions } from '../services/navigation/next-stop-service.ts';

export async function POST_NEXT_STOP(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const parsed = navigationRequestSchema.omit({ mode: true }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Exact start and destination coordinates are required.' }, { status: 400 });
  if (!await allowRequest(`next-stop:${user.id}`, 30, 60_000)) return Response.json({ error: 'Route guidance is temporarily busy.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const { origin, destination } = parsed.data;
  const options = await nextStopOptions(origin, destination, {
    reservePublicRequest: () => allowRequest('navigation-routing:public-provider', 1, 1100),
  });
  return Response.json({ origin, destination, options });
}

export async function POST_SEARCH(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`navigation-search:${user.id}`, 12, 60_000)) return Response.json({ error: 'Too many place searches. Try again shortly.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const body = await request.json().catch(() => null);
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (query.length < 2 || query.length > 200) return Response.json({ error: 'Enter a place or address between 2 and 200 characters.' }, { status: 400 });
  try { return Response.json({ destinations: await searchNavigationDestinations(query) }); }
  catch { return Response.json({ error: 'Place search is unavailable. Try again or choose a pin on the map.' }, { status: 502 }); }
}

export async function POST_ROUTE(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`navigation-route:${user.id}`, 12, 60_000)) return Response.json({ error: 'Too many route requests. Try again shortly.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const parsed = navigationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Choose valid start and destination coordinates, and walking, cycling or driving.' }, { status: 400 });
  try {
    const route = await fetchNavigationRoute(parsed.data, { signal: request.signal, reservePublicRequest: () => allowRequest('navigation-routing:public-provider', 1, 1100) });
    return Response.json({ route });
  } catch (error) {
    const status = error instanceof NavigationError ? error.status : 502;
    return Response.json({ error: error instanceof NavigationError ? error.message : 'Route guidance is unavailable. Try again.' }, { status, headers: status === 429 ? { 'Retry-After': '2' } : undefined });
  }
}
