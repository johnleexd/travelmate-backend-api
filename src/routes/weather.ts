import { allowRequest } from '../rate-limit.ts';
import { requireUser } from '../session.ts';
import { validateWeatherDateRange, weatherForTripDates } from '../services/weather/weather-domain.ts';
import { configuredWeatherProviders, resolveWeather } from '../services/weather/weather-service.ts';

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!allowRequest(`weather:${user.id}`, 30, 60_000)) return Response.json({ error: 'Too many weather requests.' }, { status: 429 });

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

  const weather = await resolveWeather({ city, coordinates }, configuredWeatherProviders());
  return Response.json(weatherForTripDates(weather, range.startDate, range.endDate));
}
