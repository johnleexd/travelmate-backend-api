import { requireUser } from '../session.ts';
import { allowRequest } from '../rate-limit.ts';
import { createOfferToken } from '../offer-token.ts';
import { coordinatesForCebuDestination } from '../data/cebu-locations.ts';

export interface LiveAccommodation {
  id: string;
  hotelId: string;
  offerId: string;
  name: string;
  address: string;
  checkInDate: string;
  checkOutDate: string;
  nightlyRate: number;
  total: number;
  currency: string;
  roomDescription: string;
  cancellationPolicy: string;
  available: boolean;
  isLive: boolean;
  source: 'amadeus';
  selectionToken: string;
  fetchedAt: string;
}

type AmadeusToken = { access_token?: string };

function apiBase(): string {
  return process.env.AMADEUS_ENV === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
}

async function accessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const response = await fetch(`${apiBase()}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const token = await response.json() as AmadeusToken;
  return token.access_token || null;
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

  const clientId = process.env.AMADEUS_API_KEY;
  const clientSecret = process.env.AMADEUS_API_SECRET;
  const fetchedAt = new Date().toISOString();
  if (!clientId || !clientSecret || clientId.startsWith('your_') || clientSecret.startsWith('your_')) {
    return Response.json({ configured: false, accommodations: [], message: 'Add AMADEUS_API_KEY and AMADEUS_API_SECRET to enable live hotel availability.' });
  }

  try {
    const [token, location] = await Promise.all([accessToken(clientId, clientSecret), coordinates(destination, suppliedCoordinates)]);
    if (!token || !location) return Response.json({ error: 'Could not connect the destination to live hotel inventory.' }, { status: 502 });
    const headers = { Authorization: `Bearer ${token}` };
    const hotelListUrl = `${apiBase()}/v1/reference-data/locations/hotels/by-geocode?latitude=${location.latitude}&longitude=${location.longitude}&radius=20&radiusUnit=KM&hotelSource=ALL`;
    const hotelListResponse = await fetch(hotelListUrl, { headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!hotelListResponse.ok) return Response.json({ error: 'Live hotel inventory is unavailable for this destination.' }, { status: 502 });
    const hotelList = await hotelListResponse.json() as { data?: Array<{ hotelId: string }> };
    const hotelIds = (hotelList.data || []).slice(0, 20).map((hotel) => hotel.hotelId).filter(Boolean);
    if (!hotelIds.length) return Response.json({ configured: true, accommodations: [], message: 'No live hotels were found near this destination.' });

    const rooms = Math.min(9, Math.max(1, Math.ceil(adults / 2)));
    const offerParams = new URLSearchParams({ hotelIds: hotelIds.join(','), adults: String(adults), checkInDate, checkOutDate, roomQuantity: String(rooms), currency: 'PHP', bestRateOnly: 'true' });
    const offersResponse = await fetch(`${apiBase()}/v3/shopping/hotel-offers?${offerParams}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!offersResponse.ok) return Response.json({ configured: true, accommodations: [], message: 'No rooms are available for the selected dates.' });
    const result = await offersResponse.json() as { data?: Array<{ available?: boolean; hotel: { hotelId: string; name: string }; offers?: Array<{ id: string; checkInDate: string; checkOutDate: string; roomQuantity?: string; room?: { description?: { text?: string } }; price?: { currency?: string; total?: string }; policies?: { cancellations?: Array<{ description?: { text?: string } }> } }> }> };
    const accommodations: LiveAccommodation[] = (result.data || []).flatMap((item) => {
      const offer = item.offers?.[0];
      const pricePerRoom = Number(offer?.price?.total);
      if (!offer || !Number.isFinite(pricePerRoom) || pricePerRoom <= 0) return [];
      const total = Math.round(pricePerRoom);
      const tokenData = { hotelId: item.hotel.hotelId, offerId: offer.id, name: item.hotel.name, nightlyRate: Math.round(total / nights), isLive: process.env.AMADEUS_ENV === 'production' };
      return [{
        id: `amadeus:${item.hotel.hotelId}:${offer.id}`,
        hotelId: item.hotel.hotelId,
        offerId: offer.id,
        name: item.hotel.name,
        address: destination,
        checkInDate: offer.checkInDate,
        checkOutDate: offer.checkOutDate,
        nightlyRate: tokenData.nightlyRate,
        total,
        currency: offer.price?.currency || 'PHP',
        roomDescription: offer.room?.description?.text?.replace(/\s+/g, ' ').trim() || 'Available room',
        cancellationPolicy: offer.policies?.cancellations?.[0]?.description?.text || 'Check the provider terms before booking.',
        available: item.available !== false,
        isLive: tokenData.isLive,
        source: 'amadeus' as const,
        selectionToken: createOfferToken(tokenData),
        fetchedAt,
      }];
    });
    const sourceLabel = process.env.AMADEUS_ENV === 'production' ? 'live' : 'test';
    return Response.json({ configured: true, accommodations, message: accommodations.length ? `Found ${accommodations.length} ${sourceLabel} Amadeus offers.` : 'No rooms are available for the selected dates.' });
  } catch (error) {
    console.error('[TravelMate] /api/accommodations unexpected error:', error);
    return Response.json({ error: 'Live accommodation search is temporarily unavailable.' }, { status: 502 });
  }
}
