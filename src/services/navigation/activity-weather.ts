import { z } from 'zod';
import { withProviderCache } from '../cache/provider-cache.ts';
import { distanceKm } from '../itinerary/grounded-places.ts';
import { weatherDetails } from '../weather/weather-domain.ts';
import { NavigationError, type NavigationCoordinate } from './navigation-service.ts';

const unix = z.number().int().nonnegative();
const nullable = z.number().finite().nullable();
const weatherSchema = z.object({
  latitude: z.number().finite(), longitude: z.number().finite(), timezone: z.string().min(1),
  current: z.object({ time: unix, temperature_2m: nullable, weather_code: nullable, precipitation_probability: nullable.optional() }).optional(),
  hourly: z.object({ time: z.array(unix).min(1).max(400), temperature_2m: z.array(nullable), weather_code: z.array(nullable),
    precipitation_probability: z.array(nullable).optional() }),
});
export type HourlyGrid = z.infer<typeof weatherSchema>;
export interface ActivityWeather {
  status: 'available' | 'outside-horizon' | 'unavailable' | 'missing-time';
  kind: 'current' | 'forecast'; temperature?: number; condition?: string; precipitationProbability?: number;
  validAt?: string; localTime?: string; timezone?: string; fetchedAt?: string; stale?: boolean;
  providerUpdatedAt?: string; grid?: NavigationCoordinate; message?: string;
}
function localTime(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(epoch);
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return part('year') + '-' + part('month') + '-' + part('day') + 'T' + part('hour') + ':' + part('minute');
}
export function scheduledMinutes(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(?:[-–—]|to)|$)/i);
  if (!match) return null;
  let hour = Number(match[1]); const minutes = Number(match[2] || 0);
  if (match[3]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0); }
  else if (!match[2]) return null;
  return hour <= 23 && minutes <= 59 ? hour * 60 + minutes : null;
}
/** Unix provider timestamps are converted with IANA time zones, including DST transitions. */
export function selectActivityWeather(grid: HourlyGrid, date: string, time: string, current = false): ActivityWeather {
  const base = { kind: current ? 'current' as const : 'forecast' as const, timezone: grid.timezone, grid: { latitude: grid.latitude, longitude: grid.longitude } };
  let index = -1, epoch: number | undefined, temperature: number | null | undefined, code: number | null | undefined, rain: number | null | undefined;
  if (current) {
    epoch = grid.current?.time; temperature = grid.current?.temperature_2m; code = grid.current?.weather_code; rain = grid.current?.precipitation_probability;
  } else {
    const minutes = scheduledMinutes(time);
    if (minutes === null) return { ...base, status: 'missing-time', message: 'A precise scheduled time is needed for the activity forecast.' };
    const target = Date.parse(date + 'T00:00:00Z') + minutes * 60_000;
    const dates = grid.hourly.time.map(epoch => localTime(epoch * 1000, grid.timezone).slice(0, 10));
    if (!dates.includes(date)) return { ...base, status: 'outside-horizon', message: 'Forecast not available yet. This date is outside the provider forecast window; past forecasts are not available here.' };
    let nearest = Infinity;
    for (let i = 0; i < grid.hourly.time.length; i++) {
      const local = localTime(grid.hourly.time[i] * 1000, grid.timezone);
      const delta = Math.abs(Date.parse(local + ':00Z') - target);
      if (delta < nearest) { nearest = delta; index = i; }
    }
    if (index < 0 || nearest > 3_600_000) return { ...base, status: 'outside-horizon', message: 'Forecast not available yet. This date is outside the provider forecast window; past forecasts are not available here.' };
    epoch = grid.hourly.time[index]; temperature = grid.hourly.temperature_2m[index]; code = grid.hourly.weather_code[index]; rain = grid.hourly.precipitation_probability?.[index];
  }
  if (epoch === undefined || temperature == null || code == null || !Number.isFinite(temperature) || !Number.isFinite(code)) return { ...base, status: 'unavailable', message: 'Weather is unavailable for this place and time.' };
  return { ...base, status: 'available', temperature: Math.round(temperature * 10) / 10, condition: weatherDetails(code).description,
    ...(rain != null && rain >= 0 && rain <= 100 ? { precipitationProbability: rain } : {}),
    validAt: new Date(epoch * 1000).toISOString(), localTime: localTime(epoch * 1000, grid.timezone) };
}
let retryAt = 0;
export async function loadActivityWeather(point: NavigationCoordinate, date: string, time: string, current = false,
  options: { fetcher?: typeof fetch; reserve?: () => Promise<boolean> } = {}): Promise<ActivityWeather> {
  try {
    const cached = await withProviderCache('trip-map-hourly:' + point.latitude.toFixed(2) + ':' + point.longitude.toFixed(2),
      { source: 'weather', freshForMs: 900_000, staleForMs: 3_600_000 }, async () => {
        if (Date.now() < retryAt || options.reserve && !await options.reserve()) throw new NavigationError('Weather is rate limited. Try again later.', 429);
        const params = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude), timezone: 'auto', timeformat: 'unixtime',
          hourly: 'temperature_2m,weather_code,precipitation_probability', current: 'temperature_2m,weather_code,precipitation_probability', forecast_days: '16', temperature_unit: 'celsius' });
        const apiKey = process.env.OPEN_METEO_API_KEY;
        if (apiKey) params.set('apikey', apiKey);
        const endpoint = apiKey ? 'https://customer-api.open-meteo.com/v1/forecast?' : 'https://api.open-meteo.com/v1/forecast?';
        const response = await (options.fetcher || fetch)(endpoint + params, { signal: AbortSignal.timeout(12_000) });
        if (response.status === 429) {
          const header = response.headers.get('Retry-After'), seconds = Number(header);
          retryAt = Math.max(Date.now() + 60_000, header && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header || '') || 0);
          throw new NavigationError('Weather provider is rate limited. Try again later.', 429);
        }
        if (!response.ok) throw new NavigationError('Weather provider unavailable.');
        const parsed = weatherSchema.parse(await response.json());
        new Intl.DateTimeFormat('en', { timeZone: parsed.timezone });
        if (Math.abs(parsed.latitude) > 90 || Math.abs(parsed.longitude) > 180 || distanceKm(point, parsed) > 50 || parsed.hourly.temperature_2m.length !== parsed.hourly.time.length ||
          parsed.hourly.weather_code.length !== parsed.hourly.time.length) throw new NavigationError('Incomplete weather forecast.');
        return parsed;
      });
    const weather = selectActivityWeather(cached.value, date, time, current);
    const oldCurrent = current && weather.validAt !== undefined && Date.now() - Date.parse(weather.validAt) > 3_600_000;
    return { ...weather, fetchedAt: cached.freshness.fetchedAt, stale: cached.freshness.isStale || oldCurrent }; 
  } catch {
    return { status: 'unavailable', kind: current ? 'current' : 'forecast', message: 'Weather is temporarily unavailable or rate limited. Try again later.' };
  }
}
