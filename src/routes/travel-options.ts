import { coordinatesForCebuDestination } from '../data/cebu-locations.ts';
import { allowRequest } from '../rate-limit.ts';
import { requireUser } from '../session.ts';
import { createAmadeusTravelProvider, type ActivityOption, type FlightOption } from '../services/travel/amadeus-provider.ts';
import { readDb } from '../store.ts';

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
  if (!allowRequest(`travel-options:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many travel-option searches.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  const origin = params.get('origin')?.trim() || '';
  const destination = params.get('destination')?.trim() || '';
  const departureDate = params.get('departureDate') || '';
  const returnDate = params.get('returnDate') || '';
  const adults = Number(params.get('adults') || 1);
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
  const db = await readDb();
  const municipality = destination.split(',')[0].trim().toLowerCase();
  const localActivities: ActivityOption[] = db.listings
    .filter((listing) => listing.category === 'activity' && listing.status === 'approved' && listing.municipality.toLowerCase() === municipality)
    .map((listing) => ({
      id: `travelmate:${listing.id}`, provider: 'travelmate', name: listing.name, location: listing.address,
      description: listing.description, price: listing.price, currency: 'PHP', fetchedAt, isLive: false,
    }));

  let provider;
  try {
    provider = await createAmadeusTravelProvider();
  } catch (error) {
    console.error('[TravelMate] Amadeus authentication failed:', error instanceof Error ? error.message : error);
    return Response.json({
      fetchedAt, provider: { name: 'amadeus', configured: true, isLive: false }, flights: [] as FlightOption[],
      activities: localActivities, flightMessage: 'Flight prices are temporarily unavailable.',
      activityMessage: localActivities.length ? 'Showing approved TravelMate activities; external activities are temporarily unavailable.' : 'Activity options are temporarily unavailable.',
    });
  }
  if (!provider) return Response.json({
    fetchedAt, provider: { name: 'amadeus', configured: false, isLive: false }, flights: [] as FlightOption[], activities: localActivities,
    flightMessage: 'Add Amadeus credentials to retrieve flight offers. No flight availability has been fabricated.',
    activityMessage: localActivities.length ? 'Showing approved TravelMate activities. Add Amadeus credentials for external activity offers.' : 'Add Amadeus credentials to retrieve external activities.',
  });

  const location = await coordinates(destination, suppliedCoordinates).catch(() => null);
  const [flightResult, activityResult] = await Promise.allSettled([
    provider.searchFlights({ origin, destination, departureDate, returnDate: returnDate || undefined, adults }, fetchedAt),
    location ? provider.searchActivities({ destination, ...location }, fetchedAt) : Promise.reject(new Error('Destination coordinates unavailable.')),
  ]);
  const flights = flightResult.status === 'fulfilled' ? flightResult.value : [];
  const externalActivities = activityResult.status === 'fulfilled' ? activityResult.value : [];
  if (flightResult.status === 'rejected') console.error('[TravelMate] Flight provider failed:', flightResult.reason instanceof Error ? flightResult.reason.message : flightResult.reason);
  if (activityResult.status === 'rejected') console.error('[TravelMate] Activity provider failed:', activityResult.reason instanceof Error ? activityResult.reason.message : activityResult.reason);
  return Response.json({
    fetchedAt,
    provider: { name: provider.name, configured: true, isLive: provider.isLive },
    flights,
    activities: [...localActivities, ...externalActivities],
    flightMessage: flightResult.status === 'rejected' ? 'Flight prices are temporarily unavailable for this route.' : flights.length ? `Found ${flights.length} Amadeus flight offers.` : 'No Amadeus flight offers were found for this route and date.',
    activityMessage: activityResult.status === 'rejected' ? (localActivities.length ? 'Showing approved TravelMate activities; external activities are unavailable.' : 'External activities are temporarily unavailable.') : externalActivities.length || localActivities.length ? `Found ${externalActivities.length} external and ${localActivities.length} TravelMate activity options.` : 'No activity offers were found near this destination.',
  });
}
