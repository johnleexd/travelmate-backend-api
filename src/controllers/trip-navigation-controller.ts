import { z } from 'zod';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { readTripDetails } from '../repositories/trip-workspace-repository.ts';
import { PlatformActionError } from '../exceptions/index.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';
import { withProviderCache } from '../services/cache/provider-cache.ts';
import { NavigationError, fetchNavigationRoute } from '../services/navigation/navigation-service.ts';
import { activitySelectionSchema, loadTripMapManifest, mapActivity, resolveTripMapActivity } from '../services/navigation/trip-map-service.ts';
import { loadActivityWeather } from '../services/navigation/activity-weather.ts';

async function ownedTrip(request: Request) {
  const user = await requireUser(request, 'traveler');
  const id = decodeURIComponent(new URL(request.url).pathname.split('/').filter(Boolean)[3] || '');
  if (!id || id.length > 100) throw new NavigationError('Choose a saved trip.', 400);
  if (!await allowRequest('trip-navigation:' + user.id, 60, 60_000)) throw new NavigationError('Too many map requests. Try again shortly.', 429);
  return { user, trip: await readTripDetails(user, id) };
}
function failure(error: unknown) {
  if (isDatabaseConnectionError(error)) throw error;
  const status = error instanceof NavigationError ? error.status : error instanceof PlatformActionError ? 404 : error instanceof z.ZodError ? 400 : error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : 502;
  const message = error instanceof NavigationError || error instanceof PlatformActionError ? error.message
    : status === 401 ? 'Unauthorized.' : status === 400 ? 'Choose a valid saved day, activity and travel mode.' : 'Trip map information is temporarily unavailable.';
  return Response.json({ error: message }, { status, headers: status === 429 ? { 'Retry-After': '60' } : undefined });
}
export async function GET_TRIP_MAP(request: Request) {
  try {
    const { trip } = await ownedTrip(request);
    return Response.json({ map: await loadTripMapManifest(trip) });
  } catch (error) { return failure(error); }
}
export async function POST_TRIP_ACTIVITY(request: Request) {
  try {
    const { trip } = await ownedTrip(request);
    const selection = activitySelectionSchema.parse(await request.json().catch(() => null));
    return Response.json(await resolveTripMapActivity(trip, selection, { photos: true }));
  } catch (error) { return failure(error); }
}
const routeSchema = z.object({ dayIndex: z.number().int().min(0).max(30), mode: z.enum(['walking', 'cycling', 'driving']),
  selections: z.array(z.object({ activityIndex: z.number().int().min(0).max(49), query: z.string().trim().min(2).max(200), placeId: z.string().min(1).max(150) }).strict()).max(50).default([]) }).strict();
export async function POST_TRIP_DAY_ROUTE(request: Request) {
  try {
    const { trip } = await ownedTrip(request), input = routeSchema.parse(await request.json().catch(() => null));
    const manifest = await loadTripMapManifest(trip), day = manifest.days[input.dayIndex];
    if (!day) throw new NavigationError('This saved day is unavailable.', 404);
    if (new Set(input.selections.map(item => item.activityIndex)).size !== input.selections.length ||
      input.selections.some(item => !day.activities[item.activityIndex])) throw new NavigationError('Choose valid activity locations.', 400);
    const stops: { index: number; latitude: number; longitude: number }[] = [];
    for (const activity of day.activities) {
      if (activity.budgetOnly || activity.status === 'skipped') continue;
      const selected = input.selections.find(item => item.activityIndex === activity.index);
      const place = selected ? (await resolveTripMapActivity(trip, { ...selected, dayIndex: input.dayIndex })).activity.place : activity.place;
      if (place) stops.push({ index: activity.index, latitude: place.latitude, longitude: place.longitude });
    }
    if (stops.length < 2) throw new NavigationError('Choose at least two exact places for this day before routing.', 400);
    const points = stops.map(({ latitude, longitude }) => ({ latitude, longitude }));
    const cached = await withProviderCache('trip-day-route:' + JSON.stringify([input.mode, points]),
      { source: 'activities', freshForMs: 300_000, staleForMs: 300_000 }, () => fetchNavigationRoute({
        origin: points[0], destination: points.at(-1)!, mode: input.mode,
      }, { stops: points, reservePublicRequest: () => allowRequest('navigation-routing:public-provider', 1, 1100) }));
    return Response.json({ route: cached.value, stopIndices: stops.map(stop => stop.index), totalActivities: day.activities.filter(activity => !activity.budgetOnly && activity.status !== 'skipped').length,
      travelLegs: cached.value.legDurationsSeconds?.map((durationSeconds, index) => ({ fromActivityIndex: stops[index].index, toActivityIndex: stops[index + 1].index, durationSeconds })) || [],
      message: stops.length < day.activities.filter(activity => !activity.budgetOnly && activity.status !== 'skipped').length ? 'Route includes only verified stops. Unresolved activities are omitted.' : 'Route follows the saved activity order; skipped activities are excluded.' });
  } catch (error) { return failure(error); }
}
export async function POST_TRIP_ACTIVITY_WEATHER(request: Request) {
  try {
    const { trip } = await ownedTrip(request);
    const input = z.object({ selection: activitySelectionSchema, current: z.boolean().default(false) }).strict().parse(await request.json().catch(() => null));
    const { day } = mapActivity(trip, input.selection);
    const activity = (await resolveTripMapActivity(trip, input.selection)).activity;
    if (!activity.place) return Response.json({ weather: { status: 'unavailable', kind: input.current ? 'current' : 'forecast', message: 'Choose an exact place before requesting weather.' } });
    return Response.json({ weather: await loadActivityWeather(activity.place, day.date, activity.time, input.current,
      { reserve: async () => await allowRequest('trip-map-weather:minute', 200, 60000) &&
        await allowRequest('trip-map-weather:hour', 500, 3600000) && await allowRequest('trip-map-weather:day', 4000, 86400000) }) });
  } catch (error) { return failure(error); }
}
