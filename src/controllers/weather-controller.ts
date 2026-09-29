import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { validateWeatherDateRange, weatherForTripDates } from '../services/weather/weather-domain.ts';
import { configuredWeatherProviders, resolveWeather } from '../services/weather/weather-service.ts';
import { estimateCrowdRange } from '../services/crowd/crowd-service.ts';
import { unavailableWeather } from '../services/weather/weather-domain.ts';
import { PROVIDER_CACHE_POLICIES } from '../services/cache/policies.ts';
import { cachePolicyLabel, withProviderCache, type FreshnessMetadata } from '../services/cache/provider-cache.ts';

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`weather:${user.id}`, 30, 60_000)) return Response.json({ error: 'Too many weather requests.' }, { status: 429 });

  const { searchParams } = new URL(request.url);
  const city = searchParams.get('city')?.trim() || '';
  if (city.length < 2 || city.length > 120) return Response.json({ error: 'Provide a valid city query parameter.' }, { status: 400 });
  const range = validateWeatherDateRange(searchParams.get('startDate'), searchParams.get('endDate'));
  if (range.error) return Response.json({ error: range.error }, { status: 400 });

  const latitudeText = searchParams.get('latitude');
  const longitudeText = searchParams.get('longitude');
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const coordinates = latitudeText !== null && longitudeText !== null
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : undefined;
  if ((latitudeText === null) !== (longitudeText === null) || (latitudeText !== null && !coordinates)) {
    return Response.json({ error: 'Provide valid latitude and longitude together.' }, { status: 400 });
  }

  const policy = PROVIDER_CACHE_POLICIES.weather;
  let cached;
  try {
    const key = coordinates ? `${coordinates.latitude.toFixed(4)}:${coordinates.longitude.toFixed(4)}` : city.toLowerCase();
    cached = await withProviderCache(key, policy, async () => {
      const weather = await resolveWeather({ city, coordinates }, configuredWeatherProviders());
      if (weather.source === 'unavailable') throw new Error('All weather providers are unavailable.');
      return weather;
    });
  } catch (error) {
    console.error('[TravelMate] Weather cache/provider lookup failed:', error instanceof Error ? error.message : error);
    const now = new Date();
    const freshness: FreshnessMetadata = { source: 'weather', status: 'unavailable', isStale: false, fetchedAt: now.toISOString(), expiresAt: now.toISOString(), staleUntil: now.toISOString(), policy: cachePolicyLabel(policy) };
    cached = { value: unavailableWeather(city), freshness };
  }
  return Response.json({
    ...weatherForTripDates(cached.value, range.startDate, range.endDate),
    fetchedAt: cached.freshness.fetchedAt,
    refreshAfter: cached.freshness.expiresAt,
    freshness: cached.freshness,
    crowd: estimateCrowdRange(range.startDate, range.endDate, city, new Date()),
  });
}
