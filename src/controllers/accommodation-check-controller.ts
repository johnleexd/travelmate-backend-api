import { revalidateHotelRecommendation } from '../services/travel/hotel-recommendations.ts';
import { createAmadeusTravelProvider } from '../services/travel/amadeus-provider.ts';
import { createOfferToken, verifyOfferToken } from '../utils/offer-token.ts';
import { occupancySchema } from '../services/travel/hotel-quote.ts';
import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { openQuote, sealQuote, type RoomOccupancy } from '../services/travel/hotel-quote.ts';
import { HotelQuoteError } from '../services/travel/rapid-hotel-provider.ts';
export async function POST(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest('accommodation-check:' + user.id, 20, 60000)) return Response.json({ error: 'Too many room checks. Try again shortly.' }, { status: 429 });
  try {
    const body = await request.json();
    if (body.liveOffer) {
      const offer = body.liveOffer;
      const rooms = occupancySchema.parse(body.occupancy);
      if (rooms.some(room => room.childAges.length || room.adults !== rooms[0].adults)) return Response.json({ error: 'This provider cannot quote the requested room occupancy.' }, { status: 400 });
      const adults = rooms.reduce((sum, room) => sum + room.adults, 0);
      const tokenData = { hotelId: offer.hotelId, offerId: offer.offerId, name: offer.name, address: offer.address, nightlyRate: offer.nightlyRate, currency: offer.currency, isLive: offer.isLive, total: offer.total, destination: body.destination, checkInDate: body.checkInDate, checkOutDate: body.checkOutDate, adults, latitude: body.latitude, longitude: body.longitude, fetchedAt: offer.fetchedAt, rooms: rooms.length };
      if (!verifyOfferToken(tokenData, offer.selectionToken)) return Response.json({ error: 'This room quote expired or is invalid.' }, { status: 409 });
      const provider = await createAmadeusTravelProvider();
      if (!provider) return Response.json({ error: 'Room quote provider is not configured.' }, { status: 503 });
      const next = await provider.revalidateAccommodationOffer(offer.offerId, { destination: body.destination, latitude: body.latitude, longitude: body.longitude, checkInDate: body.checkInDate, checkOutDate: body.checkOutDate, adults, roomQuantity: rooms.length, nights: Math.round((Date.parse(body.checkOutDate) - Date.parse(body.checkInDate)) / 86400000), currency: offer.currency }, offer.hotelId);
      if (next.total !== offer.total || next.currency !== offer.currency) return Response.json({ error: 'The room price changed. Refresh accommodations and review the new quote.', status: 'changed' }, { status: 409 });
      return Response.json({ liveOffer: { ...next, selectionToken: createOfferToken({ ...tokenData, fetchedAt: next.fetchedAt }) } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const ticket = openQuote(body.quoteToken, user.id);
    const quote = ticket.property.quote!;
    if (body.checkInDate !== quote.checkInDate || body.checkOutDate !== quote.checkOutDate || JSON.stringify(body.occupancy as RoomOccupancy) !== JSON.stringify(quote.occupancy)) {
      return Response.json({ error: 'Stay dates or guests changed. Refresh accommodations.', status: 'expired' }, { status: 409 });
    }
    const property = await revalidateHotelRecommendation(ticket);
    return Response.json({ accommodation: { ...property, quoteToken: sealQuote({ ...ticket, property, expiresAt: Date.now() + 10 * 60000 }) } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not check the room quote.', status: error instanceof HotelQuoteError ? error.status : 'expired' }, { status: error instanceof HotelQuoteError && error.status === 'provider-error' ? 502 : 409 });
  }
}
