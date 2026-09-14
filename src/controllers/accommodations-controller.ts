import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { createOfferToken } from '../utils/offer-token.ts';
import { coordinatesForCebuDestination } from '../constants/cebu-locations.ts';
import { createAmadeusTravelProvider, type AccommodationOffer } from '../services/travel/amadeus-provider.ts';

export interface LiveAccommodation extends AccommodationOffer {
  selectionToken: string;
}

async function coordinates(destination: string, supplied?: { latitude: number; longitude: number }): Promise<{ latitude: number; longitude: number } | null> {
  if (supplied) return supplied;
  const knownCebu = coordinatesForCebuDestination(destination);
  if (knownCebu) return knownCebu;
  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const data = await response.json() as { results?: Array<{ latitude: number; longitude: number }> };
  return data.results?.[0] || null;
}

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!allowRequest(`accommodations:${user.id}`, 12, 60_000)) return Response.json({ error: 'Too many accommodation searches.' }, { status: 429 });

  const searchParams = new URL(request.url).searchParams;
  const destination = searchParams.get('destination')?.trim() || '';
  const checkInDate = searchParams.get('checkInDate') || '';
  const checkOutDate = searchParams.get('checkOutDate') || '';
  const adults = Number(searchParams.get('adults') || 1);
  const latitudeText = searchParams.get('latitude');
  const longitudeText = searchParams.get('longitude');
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const suppliedCoordinates = latitudeText !== null && longitudeText !== null && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : undefined;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const nights = Math.round((new Date(`${checkOutDate}T00:00:00Z`).getTime() - new Date(`${checkInDate}T00:00:00Z`).getTime()) / 86_400_000);
  if (destination.length < 2 || destination.length > 120 || !datePattern.test(checkInDate) || !datePattern.test(checkOutDate) || !Number.isFinite(nights) || nights < 1 || nights > 30 || !Number.isInteger(adults) || adults < 1 || adults > 9) {
    return Response.json({ error: 'Provide a destination, valid stay dates (up to 30 nights), and 1-9 travelers.' }, { status: 400 });
  }

  const fetchedAt = new Date().toISOString();
  let provider;
  try {
    provider = await createAmadeusTravelProvider();
  } catch (error) {
    console.error('[TravelMate] Amadeus authentication failed:', error instanceof Error ? error.message : error);
    return Response.json({ error: 'Could not connect the destination to live hotel inventory.' }, { status: 502 });
  }
  if (!provider) return Response.json({ configured: false, accommodations: [], message: 'Add AMADEUS_API_KEY and AMADEUS_API_SECRET to enable live hotel availability.' });

  try {
    const location = await coordinates(destination, suppliedCoordinates);
    if (!location) return Response.json({ error: 'Could not connect the destination to live hotel inventory.' }, { status: 502 });
    const result = await provider.searchAccommodations({ destination, ...location, checkInDate, checkOutDate, adults, nights }, fetchedAt);
    if (!result.inventoryAvailable) return Response.json({ error: 'Live hotel inventory is unavailable for this destination.' }, { status: 502 });
    if (!result.hotelsFound) return Response.json({ configured: true, accommodations: [], message: 'No live hotels were found near this destination.' });
    const accommodations: LiveAccommodation[] = result.accommodations.map((offer) => ({
      ...offer,
      selectionToken: createOfferToken({ hotelId: offer.hotelId, offerId: offer.offerId, name: offer.name, nightlyRate: offer.nightlyRate, isLive: offer.isLive }),
    }));
    const sourceLabel = provider.isLive ? 'live' : 'test';
    return Response.json({ configured: true, accommodations, message: accommodations.length ? `Found ${accommodations.length} ${sourceLabel} Amadeus offers.` : 'No rooms are available for the selected dates.' });
  } catch (error) {
    console.error('[TravelMate] /api/accommodations unexpected error:', error);
    return Response.json({ error: 'Live accommodation search is temporarily unavailable.' }, { status: 502 });
  }
}
