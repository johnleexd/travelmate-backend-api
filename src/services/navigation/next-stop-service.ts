import { withProviderCache } from '../cache/provider-cache.ts';
import { fetchNavigationRoute, type NavigationCoordinate } from './navigation-service.ts';

export type NextStopOption = {
  mode: 'walking' | 'driving'; distanceMeters: number; durationSeconds: number;
  provider: 'osrm'; fetchedAt: string;
};

/** Advisory data only: never writes activities, schedules, or transport costs. */
export async function nextStopOptions(origin: NavigationCoordinate, destination: NavigationCoordinate, options: {
  baseUrl?: string; fetcher?: typeof fetch; reservePublicRequest?: () => Promise<boolean>;
} = {}): Promise<NextStopOption[]> {
  // The shared public demo remains available to explicit map requests. Do not
  // turn every itinerary render into automatic calls to that limited service.
  const baseUrl = options.baseUrl ?? process.env.NAVIGATION_ROUTING_BASE_URL;
  if (!baseUrl?.trim()) return [];
  const results: NextStopOption[] = [];
  for (const mode of ['walking', 'driving'] as const) {
    const result = await withProviderCache<NextStopOption[]>(
      'next-stop:' + JSON.stringify([baseUrl, mode, origin, destination]),
      { source: 'activities', freshForMs: 300_000, staleForMs: 300_000, emptyForMs: 30_000 },
      async () => {
        try {
          const route = await fetchNavigationRoute({ origin, destination, mode }, {
            baseUrl, fetcher: options.fetcher, reservePublicRequest: options.reservePublicRequest,
            stops: [origin, destination],
          });
          return [{ mode, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds,
            provider: route.provider, fetchedAt: route.fetchedAt }];
        } catch { return []; }
      },
    );
    results.push(...result.value);
    // A short, returned pedestrian route is enough for this compact suggestion.
    // This suitability rule uses route distance AND duration, never a chord.
    if (mode === 'walking' && result.value.some(route => route.distanceMeters <= 1500 && route.durationSeconds <= 1200)) break;
  }
  return results;
}
