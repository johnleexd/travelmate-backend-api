import { LiteHotelProvider, liteConfigured, LiteApiError } from '../services/travel/lite-hotel-provider.ts';
import { RapidHotelProvider, rapidConfigured } from '../services/travel/rapid-hotel-provider.ts';
import { occupancySchema } from '../services/travel/hotel-quote.ts';
import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { createOfferToken } from '../utils/offer-token.ts';
import { countryForQuery } from '../services/destination/destination-index.ts';
import { resolveDestination, needsAccommodationArea, destinationAreas } from '../services/destination/location-resolution.ts';
import { accommodationDistanceKm, searchAccommodationPlaces } from '../services/destination/accommodation-places.ts';
import { createAmadeusTravelProvider, type AccommodationOffer } from '../services/travel/amadeus-provider.ts';
import { normalizeCurrency, hasValidCurrencyPrecision } from '../schemas/domain.ts';
import { PROVIDER_CACHE_POLICIES } from '../services/cache/policies.ts';
import { cachePolicyLabel, withProviderCache, type FreshnessMetadata } from '../services/cache/provider-cache.ts';

export interface LiveAccommodation extends AccommodationOffer {
  selectionToken: string;
}

function unavailableFreshness(now = new Date()): FreshnessMetadata {
  return { source: 'hotels', status: 'unavailable', isStale: false, fetchedAt: now.toISOString(), expiresAt: now.toISOString(), staleUntil: now.toISOString(), policy: cachePolicyLabel(PROVIDER_CACHE_POLICIES.hotels) };
}

async function coordinates(destination: string, supplied?: { latitude: number; longitude: number }): Promise<{ latitude: number; longitude: number } | null> {
  if (supplied) return supplied;
  const match = (await resolveDestination(destination)).location;
  return match ? { latitude: match.latitude, longitude: match.longitude } : null;
}

export async function GET(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`accommodations:${user.id}`, 12, 60_000)) return Response.json({ error: 'Too many accommodation searches.' }, { status: 429 });

  const searchParams = new URL(request.url).searchParams;
  const destination = searchParams.get('destination')?.trim() || '';
  const checkInDate = searchParams.get('checkInDate') || '';
  const checkOutDate = searchParams.get('checkOutDate') || '';
  const requestedAdults = Number(searchParams.get('adults') || 1);
  let occupancy;
  try { occupancy = occupancySchema.parse(searchParams.has('occupancy') ? JSON.parse(searchParams.get('occupancy')!) : [{ adults: requestedAdults, childAges: [] }]); }
  catch { return Response.json({ error: 'Provide 1–8 rooms, at least one adult per room, and child ages from 0–17.' }, { status: 400 }); }
  const adults = occupancy.reduce((sum, room) => sum + room.adults, 0);
  if (occupancy.reduce((sum, room) => sum + room.adults + room.childAges.length, 0) > 20) return Response.json({ error: 'Accommodation occupancy supports at most 20 travelers.' }, { status: 400 });
  let currency;
  try { currency = normalizeCurrency(searchParams.get('currency') || 'PHP'); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Currency is invalid.' }, { status: 400 }); }
  const latitudeText = searchParams.get('latitude');
  const longitudeText = searchParams.get('longitude');
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const suppliedCoordinates = latitudeText !== null && longitudeText !== null && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : undefined;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (value: string) => datePattern.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  const nights = Math.round((new Date(`${checkOutDate}T00:00:00Z`).getTime() - new Date(`${checkInDate}T00:00:00Z`).getTime()) / 86_400_000);
  if (destination.length < 2 || destination.length > 120 || !validDate(checkInDate) || !validDate(checkOutDate) || !Number.isFinite(nights) || nights < 1 || nights > 30 || !Number.isInteger(adults) || adults < 1 || adults > 20) {
    return Response.json({ error: 'Provide a destination, valid stay dates (up to 30 nights), and 1-20 travelers.' }, { status: 400 });
  }

  // City-states can share the exact country name (e.g. Singapore). Respect the
  // selected place's type so their city result still loads nearby properties.
  if (needsAccommodationArea({ placeType: searchParams.get('placeType') || '' }) || (!searchParams.get('placeType') && countryForQuery(destination))) {
    const resolved = await resolveDestination(destination).catch(() => null);
    return Response.json({ configured: false, accommodations: [], nearbyAccommodations: [], status: 'needs-area', areas: resolved?.location ? destinationAreas(resolved.location) : [], message: 'Choose a city or town within this destination to find relevant accommodation.', freshness: unavailableFreshness() });
  }
  const configured = Boolean(process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET && !process.env.AMADEUS_API_KEY.startsWith('your_') && !process.env.AMADEUS_API_SECRET.startsWith('your_'));
  try {
    const location = await coordinates(destination, suppliedCoordinates);
    if (!location) return Response.json({ configured, accommodations: [], nearbyAccommodations: [], status: 'needs-area', message: 'Resolve the destination and choose its intended city or town before searching stays.', freshness: unavailableFreshness() });
    if (liteConfigured()) {
      const guestNationality = (searchParams.get('guestNationality') || '').trim().toUpperCase();
      try {
        const provider = new LiteHotelProvider();
        const providerAccommodations = await provider.search({ destination, ...location, countryCode: searchParams.get('countryCode') || undefined,
          checkInDate, checkOutDate, currency, occupancy, guestNationality: searchParams.get('quotes') === 'false' ? '' : guestNationality }, user.id);
        const failed = providerAccommodations.find(p => p.providerMessage);
        const providerMessage = failed?.providerMessage || (!guestNationality ? 'Enter the guests’ nationality to check room prices.' : searchParams.get('quotes') === 'false' ? 'Choose a supported budget currency to check room prices.' : 'Sandbox accommodation results are test data, not production availability or prices.');
        return Response.json({configured:true,providerAccommodations,providerEnvironment:'sandbox',providerMessage,
          providerStatus:failed?'provider-error':providerAccommodations.length?'ready':'no-results',
          accommodations:[],nearbyAccommodations:[],status:failed?'provider-error':providerAccommodations.length?'ready':'no-results',
          message:providerMessage,freshness:unavailableFreshness()}, {headers:{'Cache-Control':'no-store'}});
      } catch(error) {
        const providerMessage = error instanceof LiteApiError ? error.message : 'Hotel recommendations are temporarily unavailable. Refresh stays to retry.';
        return Response.json({configured:true,providerAccommodations:[],providerEnvironment:'sandbox',providerStatus:'provider-error',providerMessage,
          accommodations:[],nearbyAccommodations:[],status:'provider-error',message:providerMessage,freshness:unavailableFreshness()}, {headers:{'Cache-Control':'no-store'}});
      }
    }
    const useRapid = rapidConfigured();
    const rapidResults = useRapid && searchParams.get('quotes') !== 'false' ? new RapidHotelProvider().search({ destination, ...location, countryCode: searchParams.get('countryCode') || undefined, checkInDate, checkOutDate, currency, occupancy }, user.id) : Promise.resolve([]);
    const offers = async () => {
      if (useRapid || !configured || occupancy.some(room => room.childAges.length || room.adults !== occupancy[0].adults) || adults > 18 || searchParams.get('quotes') === 'false') return null;
      const key = JSON.stringify({ environment: process.env.AMADEUS_ENV === 'production' ? 'production' : 'test', destination: destination.toLowerCase(), checkInDate, checkOutDate, adults, occupancy, currency, latitude: location.latitude.toFixed(4), longitude: location.longitude.toFixed(4) });
      return withProviderCache(key, PROVIDER_CACHE_POLICIES.hotels, async () => {
        const provider = await createAmadeusTravelProvider();
        if (!provider) throw new Error('Hotel offers unavailable.');
        const result = await provider.searchAccommodations({ destination, ...location, checkInDate, checkOutDate, adults, roomQuantity: occupancy.length, nights, currency }, new Date().toISOString());
        if (!result.inventoryAvailable) throw new Error('Hotel offer provider unavailable.');
        return { result, isLive: provider.isLive };
      });
    };
    const listingLocation = { destination, ...location, countryCode: searchParams.get('countryCode') || undefined };
    let searchRadiusKm = 1;
    const mappedPlaces = async () => {
      for (const radiusKm of [1, 3, 10, 30]) {
        searchRadiusKm = radiusKm;
        const nearby = await searchAccommodationPlaces({ ...listingLocation, radiusKm });
        if (nearby.value.length || radiusKm === 30) return nearby;
      }
      throw new Error('Accommodation search did not complete.');
    };
    const [places, prices, rapid] = await Promise.allSettled([mappedPlaces(), offers(), rapidResults]);
    const nearbyAccommodations = places.status === 'fulfilled' ? places.value.value : [];
    const cached = prices.status === 'fulfilled' ? prices.value : null;
    const accommodations: LiveAccommodation[] = (cached?.value.result.accommodations || []).filter(offer => offer.available && offer.currency === currency && offer.checkInDate === checkInDate && offer.checkOutDate === checkOutDate && hasValidCurrencyPrecision(offer.total, currency)).map(offer => ({ ...offer,
      ...(offer.latitude !== undefined && offer.longitude !== undefined ? { distanceKm: Math.round(accommodationDistanceKm(location.latitude, location.longitude, offer.latitude, offer.longitude) * 10) / 10 } : {}),
      selectionToken: createOfferToken({ hotelId: offer.hotelId, offerId: offer.offerId, name: offer.name, address: offer.address, nightlyRate: offer.nightlyRate, currency: offer.currency, isLive: offer.isLive, total: offer.total, destination, checkInDate, checkOutDate, adults, ...location, fetchedAt: offer.fetchedAt, rooms: occupancy.length }),
    }));
    const providerAccommodations = rapid.status === 'fulfilled' ? rapid.value : [];
    const providerStatus = !useRapid ? 'not-configured' : rapid.status === 'rejected' || providerAccommodations.some(p => p.availability === 'provider-error') ? 'provider-error' : providerAccommodations.length ? 'ready' : 'no-results';
    const messages = [];
    if (nearbyAccommodations.length) messages.push('Found ' + nearbyAccommodations.length + (searchRadiusKm > 1 ? ` nearby mapped stays after expanding to ${searchRadiusKm} km; these may be in other towns. Check their actual locations.` : ' mapped stays within 1 km; check their actual locations.') + ' Map listings do not provide room prices or availability.' + (places.status === 'fulfilled' && places.value.freshness.isStale ? ' Cached map listings may be outdated.' : ''));
    else messages.push(places.status === 'rejected' ? 'Nearby accommodation provider error. Listings are temporarily unavailable; retry the search.' : 'No mapped stays were found within 30 km of this location. Try a nearby city or area.');
    if (accommodations.length) messages.push('Found ' + accommodations.length + (cached?.value.isLive ? ' live' : ' test') + ' room offers for your dates and group size.' + (cached?.freshness.isStale ? ' Cached offers may be outdated; recheck before booking.' : ''));
    else messages.push(!configured ? 'Room prices and availability are unavailable because the room-quote provider is not configured.' : searchParams.get('quotes') === 'false' ? 'Confirm a supported destination currency to search room offers.' : prices.status === 'rejected' ? 'Room offer provider error. Retry the search.' : adults > 18 ? 'Contact the property for a large-group quote.' : 'No room offers were returned for these dates and travelers.');
    messages.push('You can enter accommodation manually or choose it later.');
    return Response.json({ configured: configured || useRapid, providerAccommodations, providerStatus, accommodations, nearbyAccommodations, status: providerAccommodations.length || accommodations.length || nearbyAccommodations.length ? 'ready' : places.status === 'rejected' || prices.status === 'rejected' ? 'provider-error' : 'no-results', mapStatus: places.status === 'rejected' ? 'provider-error' : nearbyAccommodations.length ? 'ready' : 'no-results', quoteStatus: !configured ? 'not-configured' : prices.status === 'rejected' ? 'provider-error' : accommodations.length ? 'ready' : 'no-results', message: messages.join(' '), freshness: cached?.freshness || (places.status === 'fulfilled' ? places.value.freshness : unavailableFreshness()) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ configured, accommodations: [], nearbyAccommodations: [], status: 'provider-error', message: 'Accommodation provider error. Retry the search, enter accommodation manually or choose it later.', freshness: unavailableFreshness() });
  }
}
