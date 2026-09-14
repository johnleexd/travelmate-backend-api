import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';

export interface LocationSuggestion {
  id: number;
  name: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  label: string;
}

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!allowRequest(`locations:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many location searches.' }, { status: 429 });

  const query = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (query.length < 2 || query.length > 100) {
    return Response.json({ error: 'Enter between 2 and 100 characters.' }, { status: 400 });
  }

  try {
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return Response.json({ error: 'Location search is temporarily unavailable.' }, { status: 502 });
    const data = await response.json() as { results?: Array<{ id: number; name: string; admin1?: string; country?: string; country_code?: string; latitude: number; longitude: number }> };
    const locations: LocationSuggestion[] = (data.results || []).map((place) => {
      const region = place.admin1 || '';
      const country = place.country || place.country_code || '';
      return {
        id: place.id,
        name: place.name,
        region,
        country,
        countryCode: place.country_code || '',
        latitude: place.latitude,
        longitude: place.longitude,
        label: [place.name, region, country].filter(Boolean).join(', '),
      };
    });
    return Response.json({ locations });
  } catch (error) {
    console.error('[TravelMate] /api/locations unexpected error:', error);
    return Response.json({ error: 'Location search is temporarily unavailable.' }, { status: 502 });
  }
}
