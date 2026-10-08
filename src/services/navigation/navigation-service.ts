import { z } from 'zod';
import { fetchGeocoderSearch } from '../destination/geocoder-client.ts';

export const coordinateSchema = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).strict();
export const navigationRequestSchema = z.object({ origin: coordinateSchema, destination: coordinateSchema, mode: z.enum(['walking', 'cycling', 'driving']) }).strict();
export type NavigationRequest = z.infer<typeof navigationRequestSchema>;
export type NavigationCoordinate = z.infer<typeof coordinateSchema>;
export type NavigationDestination = NavigationCoordinate & { id: string; name: string; label: string };
export type NavigationStep = { instruction: string; distanceMeters: number; durationSeconds: number; location: NavigationCoordinate; maneuver: string; modifier?: string };
export type NavigationRoute = { mode: NavigationRequest['mode']; origin: NavigationCoordinate; destination: NavigationCoordinate; geometry: NavigationCoordinate[]; steps: NavigationStep[]; distanceMeters: number; durationSeconds: number; originOffsetMeters: number; destinationOffsetMeters: number; fetchedAt: string; provider: 'osrm' };

export class NavigationError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export async function searchNavigationDestinations(query: string, fetcher: typeof fetch = fetch): Promise<NavigationDestination[]> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: '6' });
  const payload = await fetchGeocoderSearch(params, fetcher);
  if (!Array.isArray(payload)) throw new NavigationError('Place search is unavailable. Try again or choose a pin on the map.');
  return payload.slice(0, 6).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.lat !== 'string' || !item.lat.trim() || typeof item.lon !== 'string' || !item.lon.trim()) return [];
    const coordinates = coordinateSchema.safeParse({ latitude: Number(item.lat), longitude: Number(item.lon) });
    if (!coordinates.success || typeof item.display_name !== 'string' || !item.display_name.trim()) return [];
    return [{ ...coordinates.data, id: `${item.osm_type || 'place'}:${item.osm_id || item.place_id || item.display_name}`, name: String(item.name || item.display_name.split(',')[0]).slice(0, 200), label: item.display_name.slice(0, 500) }];
  });
}

const providerPoint = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const nonnegative = z.number().finite().nonnegative();
const providerRouteSchema = z.object({
  code: z.literal('Ok'),
  waypoints: z.array(z.object({ distance: nonnegative })).length(2),
  routes: z.array(z.object({ distance: nonnegative, duration: nonnegative,
    geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(providerPoint).min(2).max(60_000) }),
    legs: z.array(z.object({ steps: z.array(z.object({ name: z.string().max(500), distance: nonnegative, duration: nonnegative,
      maneuver: z.object({ type: z.string().max(50), modifier: z.string().max(50).optional(), location: providerPoint, bearing_after: z.number().optional(), exit: z.number().int().positive().optional() }),
    })).min(1).max(1000) })).length(1),
  })).min(1),
});

export function maneuverInstruction(type: string, modifier = '', road = '', exit?: number, bearing = 0): string {
  const onto = road ? ` onto ${road}` : '';
  const direction = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
  if (type === 'depart') return `Head ${direction}${road ? ` on ${road}` : ''}`;
  if (type === 'arrive') return 'Arrive at your destination';
  if (type === 'roundabout' || type === 'rotary') return exit ? `At the roundabout, take exit ${exit}${onto}` : `Enter the roundabout${onto}`;
  if (type === 'exit roundabout' || type === 'exit rotary') return `Exit the roundabout${onto}`;
  if (modifier === 'uturn') return `Make a U-turn${onto}`;
  const turn = modifier === 'sharp left' ? 'Turn sharply left' : modifier === 'sharp right' ? 'Turn sharply right'
    : modifier === 'slight left' ? 'Bear left' : modifier === 'slight right' ? 'Bear right'
      : modifier === 'left' ? 'Turn left' : modifier === 'right' ? 'Turn right' : 'Continue straight';
  if (type === 'merge') return `Merge${modifier && modifier !== 'straight' ? ` ${modifier}` : ''}${onto}`;
  if (type === 'fork') return `Keep ${modifier.includes('left') ? 'left' : modifier.includes('right') ? 'right' : 'straight'}${onto}`;
  if (type === 'on ramp' || type === 'off ramp') return `Take the ${type === 'on ramp' ? 'ramp' : 'exit'}${modifier && modifier !== 'straight' ? ` ${modifier}` : ''}${onto}`;
  return `${turn}${onto}`;
}

export function parseNavigationRoute(payload: unknown, input: NavigationRequest): NavigationRoute {
  const parsed = providerRouteSchema.safeParse(payload);
  if (!parsed.success) throw new NavigationError('The routing service returned an incomplete route. Try again.');
  const route = parsed.data.routes[0];
  return { ...input, provider: 'osrm', fetchedAt: new Date().toISOString(), distanceMeters: route.distance, durationSeconds: route.duration,
    originOffsetMeters: parsed.data.waypoints[0].distance, destinationOffsetMeters: parsed.data.waypoints[1].distance,
    geometry: route.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
    steps: route.legs[0].steps.map(step => ({ instruction: maneuverInstruction(step.maneuver.type, step.maneuver.modifier, step.name, step.maneuver.exit, step.maneuver.bearing_after), distanceMeters: step.distance, durationSeconds: step.duration, location: { latitude: step.maneuver.location[1], longitude: step.maneuver.location[0] }, maneuver: step.maneuver.type, modifier: step.maneuver.modifier })),
  };
}

export async function fetchNavigationRoute(raw: NavigationRequest, options: { fetcher?: typeof fetch; reservePublicRequest?: () => Promise<boolean>; signal?: AbortSignal; baseUrl?: string } = {}): Promise<NavigationRoute> {
  const input = navigationRequestSchema.parse(raw);
  const base = new URL(options.baseUrl || process.env.NAVIGATION_ROUTING_BASE_URL || 'https://routing.openstreetmap.de/');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new NavigationError('The routing service is not configured correctly.');
  if (base.hostname === 'routing.openstreetmap.de' && (!options.reservePublicRequest || !await options.reservePublicRequest())) throw new NavigationError('Routing is busy. Try again in a moment.', 429);
  const profile = { walking: 'routed-foot', cycling: 'routed-bike', driving: 'routed-car' }[input.mode];
  const points = `${input.origin.longitude},${input.origin.latitude};${input.destination.longitude},${input.destination.latitude}`;
  const url = new URL(`${base.toString().replace(/\/$/, '')}/${profile}/route/v1/driving/${points}`);
  url.search = new URLSearchParams({ steps: 'true', geometries: 'geojson', overview: 'full', alternatives: 'false', generate_hints: 'false' }).toString();
  let response: Response;
  try {
    response = await (options.fetcher || fetch)(url, { headers: { Accept: 'application/json', 'User-Agent': 'TravelMate/1.0 (interactive GPS route guidance)' }, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch { throw new NavigationError('The routing service is unavailable. Check your connection and try again.'); }
  if (response.status === 429) throw new NavigationError('The routing service is busy. Try again shortly.', 429);
  if (!response.ok && response.status !== 400) throw new NavigationError('The routing service is unavailable. Try again shortly.');
  const text = await response.text();
  if (text.length > 8_000_000) throw new NavigationError('This route is too large. Choose a closer destination.');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new NavigationError('The routing service returned an unreadable route. Try again.'); }
  const code = payload && typeof payload === 'object' && 'code' in payload ? payload.code : null;
  if (code === 'NoRoute' || code === 'NoSegment') throw new NavigationError('No road or path route connects these locations for this travel mode. Choose another mode or destination.', 404);
  return parseNavigationRoute(payload, input);
}
