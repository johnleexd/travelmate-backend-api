import { z } from 'zod';
import { trackUnsplashCoverSelection } from '../services/destination/unsplash-cover-photos.ts';
import { destinationPhotoQuerySchema, loadDestinationCoverPhotos } from '../services/destination/destination-cover-photo.ts';
import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { resolveDestinationContext } from '../services/destination/destination-context-service.ts';
import { ExchangeRateProviderRateLimit, getExchangeRate } from '../services/currency/exchange-rate-service.ts';

export async function GET(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`destination-context:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many destination requests.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  const countryCode = params.get('countryCode')?.trim().toUpperCase() || '';
  const city = params.get('city')?.trim() || '';
  if (!/^[A-Z]{2}$/.test(countryCode) || city.length < 1 || city.length > 100) {
    return Response.json({ error: 'Provide a valid selected city and two-letter country code.' }, { status: 400 });
  }
  return Response.json(resolveDestinationContext(countryCode, city));
}

export async function GET_EXCHANGE_RATE(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`exchange-rate:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many exchange-rate requests.' }, {
    status: 429, headers: { 'Retry-After': '60', 'X-Rate-Limit-Source': 'backend' },
  });

  const params = new URL(request.url).searchParams;
  try {
    return Response.json(await getExchangeRate(params.get('base') || '', params.get('quote') || ''));
  } catch (error) {
    if (error instanceof ExchangeRateProviderRateLimit) return Response.json({ error: 'Reference currency provider is temporarily rate limited.' }, {
      status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))), 'X-Rate-Limit-Source': 'upstream' },
    });
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Currency must be one of:')) return Response.json({ error: message }, { status: 400 });
    console.error('[TravelMate] Exchange-rate lookup failed:', message || error);
    return Response.json({ error: 'Reference currency conversion is temporarily unavailable.' }, { status: 502 });
  }
}

/** Saved-card cover photos only; uses the existing destination reference providers. */
export async function GET_PHOTO(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest('destination-photo:' + user.id, 60, 60_000)) return Response.json({ error: 'Too many photo requests.' }, { status: 429 });
  const params = new URL(request.url).searchParams;
  const parsed = destinationPhotoQuerySchema.safeParse(Object.fromEntries(
    ['city', 'region', 'country', 'countryCode', 'latitude', 'longitude'].filter(key => params.has(key)).map(key => [key, params.get(key)]),
  ));
  if (!parsed.success) return Response.json({ error: 'Provide a valid destination for its cover photo.' }, { status: 400 });
  const photos = await loadDestinationCoverPhotos(parsed.data);
  return Response.json({ photo: photos[0] || null, photos });
}

/** Cover-only provider tracking; does not read or update trip records. */
export async function POST_PHOTO_SELECTION(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest('destination-photo-selection:' + user.id, 60, 60_000)) return Response.json({ error: 'Too many photo requests.' }, { status: 429 });
  const parsed = z.object({ tripId: z.string().min(1).max(100), photoId: z.string().regex(/^[\w-]{1,100}$/) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Provide a valid photo selection.' }, { status: 400 });
  return Response.json({ tracked: await trackUnsplashCoverSelection(user.id, parsed.data.tripId, parsed.data.photoId) });
}
