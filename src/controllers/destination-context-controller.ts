import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { resolveDestinationContext } from '../services/destination/destination-context-service.ts';
import { getExchangeRate } from '../services/currency/exchange-rate-service.ts';

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
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
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`exchange-rate:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many exchange-rate requests.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  try {
    return Response.json(await getExchangeRate(params.get('base') || '', params.get('quote') || ''));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Currency must be one of:')) return Response.json({ error: message }, { status: 400 });
    console.error('[TravelMate] Exchange-rate lookup failed:', message || error);
    return Response.json({ error: 'Reference currency conversion is temporarily unavailable.' }, { status: 502 });
  }
}
