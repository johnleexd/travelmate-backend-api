import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { enrichCountrySuggestions, rankLocationSuggestions, reverseGeocodeLocation, type GeocodingPlace } from '../services/destination/location-search-service.ts';

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`locations:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many location searches.' }, { status: 429 });

  const query = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (query.length < 2 || query.length > 100) {
    return Response.json({ error: 'Enter between 2 and 100 characters.' }, { status: 400 });
  }

  try {
    const queryParts = query.split(',').map((part) => part.trim()).filter(Boolean).slice(0, 4);
    const responses = await Promise.all(queryParts.map((part) => fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(part)}&count=50&language=en&format=json`, { signal: AbortSignal.timeout(10_000) })));
    if (responses.some((response) => !response.ok)) return Response.json({ error: 'Location search is temporarily unavailable.' }, { status: 502 });
    const results = await Promise.all(responses.map(async (response, index) => {
      const data = await response.json() as { results?: GeocodingPlace[] };
      return rankLocationSuggestions(queryParts[index], data.results || []);
    }));
    const seen = new Set<string>();
    const merged = results.flat().filter((location) => {
      const key = `${location.id}:${location.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const locations = await enrichCountrySuggestions(merged.slice(0, 8));
    return Response.json({ locations });
  } catch (error) {
    console.error('[TravelMate] /api/locations unexpected error:', error);
    return Response.json({ error: 'Location search is temporarily unavailable.' }, { status: 502 });
  }
}

export async function GET_CURRENT(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`current-location:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many current-location requests.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  const latitude = Number(params.get('latitude'));
  const longitude = Number(params.get('longitude'));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return Response.json({ error: 'Provide valid latitude and longitude coordinates.' }, { status: 400 });
  }

  try {
    const location = await reverseGeocodeLocation(latitude, longitude);
    if (!location) return Response.json({ error: 'Your current area could not be identified. Enter the starting location manually.' }, { status: 404 });
    return Response.json({ location });
  } catch (error) {
    console.error('[TravelMate] Current location lookup failed:', error);
    return Response.json({ error: 'Current location lookup is temporarily unavailable. Enter the starting location manually.' }, { status: 502 });
  }
}
