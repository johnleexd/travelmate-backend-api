import { coordinatesForCebuDestination } from '../constants/cebu-locations.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { createAmadeusTravelProvider, type ActivityOption, type FlightOption } from '../services/travel/amadeus-provider.ts';
import { readApprovedListings } from '../repositories/platform-repository.ts';
import { PROVIDER_CACHE_POLICIES } from '../services/cache/policies.ts';
import { cachePolicyLabel, withProviderCache, type FreshnessMetadata } from '../services/cache/provider-cache.ts';
import { normalizeCurrency } from '../schemas/domain.ts';
import { createTravelSelectionToken } from '../utils/travel-selection-token.ts';

function unavailableFreshness(source: 'flights' | 'activities', now = new Date()): FreshnessMetadata {
  const policy = PROVIDER_CACHE_POLICIES[source];
  return { source, status: 'unavailable', isStale: false, fetchedAt: now.toISOString(), expiresAt: now.toISOString(), staleUntil: now.toISOString(), policy: cachePolicyLabel(policy) };
}

async function coordinates(destination: string, supplied?: { latitude: number; longitude: number }): Promise<{ latitude: number; longitude: number } | null> {
  if (supplied) return supplied;
  const known = coordinatesForCebuDestination(destination);
  if (known) return known;
  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const data = await response.json() as { results?: Array<{ latitude: number; longitude: number }> };
  return data.results?.[0] || null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const user = await requireUser(request, 'traveler').catch(() => null);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`travel-options:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many travel-option searches.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  const origin = params.get('origin')?.trim() || '';
  const destination = params.get('destination')?.trim() || '';
  const departureDate = params.get('departureDate') || '';
  const returnDate = params.get('returnDate') || '';
  const adults = Number(params.get('adults') || 1);
  let currency;
  try { currency = normalizeCurrency(params.get('currency') || 'PHP'); }
  catch { return Response.json({ error: 'Select a supported comparison currency.' }, { status: 400 }); }
  const latitudeText = params.get('latitude');
  const longitudeText = params.get('longitude');
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const suppliedCoordinates = latitudeText !== null && longitudeText !== null
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : undefined;
  if (origin.length < 2 || origin.length > 120 || destination.length < 2 || destination.length > 120
    || !validDate(departureDate) || (returnDate && (!validDate(returnDate) || returnDate < departureDate))
    || !Number.isInteger(adults) || adults < 1 || adults > 9) {
    return Response.json({ error: 'Provide valid origin, destination, dates, and 1-9 travelers.' }, { status: 400 });
  }

  const fetchedAt = new Date().toISOString();
  const listings = await readApprovedListings();
  const municipality = destination.split(',')[0].trim().toLowerCase();
  const localActivities: ActivityOption[] = (currency === 'PHP' ? listings : [])
    .filter((listing) => listing.category === 'activity' && listing.municipality.toLowerCase() === municipality)
    .map((listing) => ({
      id: `travelmate:${listing.id}`, provider: 'travelmate', name: listing.name, location: listing.address,
      description: listing.description, price: listing.price, currency: 'PHP', fetchedAt, isLive: false,
    }));
  const signedLocalActivities = localActivities.map((activity) => ({ ...activity, selectionToken: createTravelSelectionToken({ kind: 'activity', id: activity.id, name: activity.name, price: activity.price, currency: activity.currency, fetchedAt: activity.fetchedAt }) }));

  const configured = Boolean(process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET && !process.env.AMADEUS_API_KEY.startsWith('your_') && !process.env.AMADEUS_API_SECRET.startsWith('your_'));
  const isLive = process.env.AMADEUS_ENV === 'production';
  if (!configured) return Response.json({
    fetchedAt, provider: { name: 'amadeus', configured: false, isLive: false }, flights: [] as FlightOption[], activities: signedLocalActivities,
    flightMessage: 'Add Amadeus credentials to retrieve flight offers. No flight availability has been fabricated.',
    activityMessage: localActivities.length ? 'Showing approved TravelMate activities. Add Amadeus credentials for external activity offers.' : 'Add Amadeus credentials to retrieve external activities.',
    freshness: { flights: unavailableFreshness('flights'), activities: unavailableFreshness('activities') },
  });

  let providerPromise: ReturnType<typeof createAmadeusTravelProvider> | undefined;
  const getProvider = () => providerPromise ??= createAmadeusTravelProvider();
  const flightKey = JSON.stringify({ environment: isLive ? 'production' : 'test', origin: origin.toLowerCase(), destination: destination.toLowerCase(), departureDate, returnDate, adults, currency });
  const activityKey = JSON.stringify({ environment: isLive ? 'production' : 'test', destination: destination.toLowerCase(), latitude: suppliedCoordinates?.latitude.toFixed(4), longitude: suppliedCoordinates?.longitude.toFixed(4) });
  const [flightResult, activityResult] = await Promise.allSettled([
    withProviderCache(flightKey, PROVIDER_CACHE_POLICIES.flights, async () => {
      const provider = await getProvider();
      if (!provider) throw new Error('Amadeus is not configured.');
      return provider.searchFlights({ origin, destination, departureDate, returnDate: returnDate || undefined, adults, currency }, fetchedAt);
    }),
    withProviderCache(activityKey, PROVIDER_CACHE_POLICIES.activities, async () => {
      const [provider, location] = await Promise.all([getProvider(), coordinates(destination, suppliedCoordinates)]);
      if (!provider || !location) throw new Error('Activity provider or destination coordinates unavailable.');
      return provider.searchActivities({ destination, ...location }, fetchedAt);
    }),
  ]);
  const flights = flightResult.status === 'fulfilled' ? flightResult.value.value.map((flight) => ({ ...flight, selectionToken: createTravelSelectionToken({ kind: 'flight', id: flight.id, name: `${flight.airline} ${flight.origin}-${flight.destination}`, price: flight.price, currency: flight.currency, fetchedAt: flight.fetchedAt }) })) : [];
  const externalActivities = activityResult.status === 'fulfilled' ? activityResult.value.value : [];
  const activities = [...signedLocalActivities, ...externalActivities.map((activity) => ({ ...activity, selectionToken: createTravelSelectionToken({ kind: 'activity', id: activity.id, name: activity.name, price: activity.price, currency: activity.currency, fetchedAt: activity.fetchedAt }) }))];
  if (flightResult.status === 'rejected') console.error('[TravelMate] Flight provider failed:', flightResult.reason instanceof Error ? flightResult.reason.message : flightResult.reason);
  if (activityResult.status === 'rejected') console.error('[TravelMate] Activity provider failed:', activityResult.reason instanceof Error ? activityResult.reason.message : activityResult.reason);
  return Response.json({
    fetchedAt,
    provider: { name: 'amadeus', configured: true, isLive },
    flights,
    activities,
    freshness: { flights: flightResult.status === 'fulfilled' ? flightResult.value.freshness : unavailableFreshness('flights'), activities: activityResult.status === 'fulfilled' ? activityResult.value.freshness : unavailableFreshness('activities') },
    flightMessage: flightResult.status === 'rejected' ? 'Flight prices are temporarily unavailable for this route.' : flightResult.value.freshness.isStale ? `Showing ${flights.length} stale cached flight offers because Amadeus is unavailable. Recheck before booking.` : flights.length ? `Found ${flights.length} Amadeus flight offers.` : 'No Amadeus flight offers were found for this route and date.',
    activityMessage: activityResult.status === 'rejected' ? (localActivities.length ? 'Showing approved TravelMate activities; external activities are unavailable.' : 'External activities are temporarily unavailable.') : activityResult.value.freshness.isStale ? `Showing stale cached external activities plus ${localActivities.length} current TravelMate listings.` : externalActivities.length || localActivities.length ? `Found ${externalActivities.length} external and ${localActivities.length} TravelMate activity options.` : 'No activity offers were found near this destination.',
  });
}
