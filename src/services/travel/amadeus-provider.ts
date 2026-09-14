export interface FlightOption {
  id: string;
  provider: 'amadeus';
  airline: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  returnDeparture?: string;
  returnArrival?: string;
  duration: string;
  price: number;
  currency: string;
  stops: number;
  seatsAvailable?: number;
  fetchedAt: string;
  isLive: boolean;
}

export interface ActivityOption {
  id: string;
  provider: 'amadeus' | 'travelmate';
  name: string;
  location: string;
  description: string;
  price: number;
  currency: string;
  rating?: number;
  referenceUrl?: string;
  fetchedAt: string;
  isLive: boolean;
}

export interface AccommodationOffer {
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
  fetchedAt: string;
}

export interface FlightSearchInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
}

export interface ActivitySearchInput {
  destination: string;
  latitude: number;
  longitude: number;
}

export interface AccommodationSearchInput {
  destination: string;
  latitude: number;
  longitude: number;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  nights: number;
}

export interface AccommodationSearchResult {
  accommodations: AccommodationOffer[];
  inventoryAvailable: boolean;
  hotelsFound: boolean;
}

export interface TravelProvider {
  readonly name: string;
  searchFlights(input: FlightSearchInput, fetchedAt: string): Promise<FlightOption[]>;
  searchActivities(input: ActivitySearchInput, fetchedAt: string): Promise<ActivityOption[]>;
  searchAccommodations(input: AccommodationSearchInput, fetchedAt: string): Promise<AccommodationSearchResult>;
}

type FetchImplementation = typeof fetch;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function amount(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeFlightOffers(payload: unknown, fetchedAt: string, isLive: boolean): FlightOption[] {
  return array(object(payload)?.data).flatMap((rawOffer): FlightOption[] => {
    const offer = object(rawOffer);
    const itineraries = array(offer?.itineraries).map(object).filter((item): item is Record<string, unknown> => Boolean(item));
    const outbound = itineraries[0];
    const outboundSegments = array(outbound?.segments).map(object).filter((item): item is Record<string, unknown> => Boolean(item));
    const first = outboundSegments[0];
    const last = outboundSegments.at(-1);
    const departure = object(first?.departure);
    const arrival = object(last?.arrival);
    const priceData = object(offer?.price);
    const price = amount(priceData?.grandTotal ?? priceData?.total);
    const id = text(offer?.id);
    if (!id || !first || !last || !departure || !arrival || price === undefined) return [];
    const inboundSegments = array(itineraries[1]?.segments).map(object).filter((item): item is Record<string, unknown> => Boolean(item));
    const inboundFirst = inboundSegments[0];
    const inboundLast = inboundSegments.at(-1);
    const carriers = array(offer?.validatingAirlineCodes).map(text).filter(Boolean);
    const seats = Number(offer?.numberOfBookableSeats);
    return [{
      id: `amadeus:${id}`,
      provider: 'amadeus',
      airline: carriers[0] || text(first.carrierCode) || 'Airline code unavailable',
      origin: text(departure.iataCode),
      destination: text(arrival.iataCode),
      departure: text(departure.at),
      arrival: text(arrival.at),
      returnDeparture: text(object(inboundFirst?.departure)?.at) || undefined,
      returnArrival: text(object(inboundLast?.arrival)?.at) || undefined,
      duration: text(outbound.duration) || 'Duration unavailable',
      price,
      currency: text(priceData?.currency) || 'PHP',
      stops: Math.max(0, outboundSegments.length - 1),
      seatsAvailable: Number.isInteger(seats) && seats >= 0 ? seats : undefined,
      fetchedAt,
      isLive,
    }];
  });
}

export function normalizeActivityOffers(payload: unknown, destination: string, fetchedAt: string, isLive: boolean): ActivityOption[] {
  return array(object(payload)?.data).flatMap((rawActivity): ActivityOption[] => {
    const activity = object(rawActivity);
    const priceData = object(activity?.price);
    const price = amount(priceData?.amount);
    const id = text(activity?.id);
    const name = text(activity?.name).trim();
    if (!id || !name || price === undefined) return [];
    const rating = Number(activity?.rating);
    return [{
      id: `amadeus:${id}`,
      provider: 'amadeus',
      name,
      location: destination,
      description: text(activity?.shortDescription).replace(/\s+/g, ' ').trim().slice(0, 600) || 'See provider details for this activity.',
      price,
      currency: text(priceData?.currencyCode) || 'Currency unavailable',
      rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : undefined,
      referenceUrl: safeUrl(activity?.bookingLink),
      fetchedAt,
      isLive,
    }];
  });
}

export function normalizeAccommodationOffers(
  payload: unknown,
  input: Pick<AccommodationSearchInput, 'destination' | 'nights'>,
  fetchedAt: string,
  isLive: boolean,
): AccommodationOffer[] {
  return array(object(payload)?.data).flatMap((rawHotel): AccommodationOffer[] => {
    const hotelResult = object(rawHotel);
    const hotel = object(hotelResult?.hotel);
    const offer = object(array(hotelResult?.offers)[0]);
    const price = object(offer?.price);
    const room = object(offer?.room);
    const description = object(room?.description);
    const policies = object(offer?.policies);
    const cancellation = object(array(policies?.cancellations)[0]);
    const cancellationDescription = object(cancellation?.description);
    const hotelId = text(hotel?.hotelId);
    const offerId = text(offer?.id);
    const name = text(hotel?.name).trim();
    const total = amount(price?.total);
    if (!hotelId || !offerId || !name || total === undefined || total <= 0) return [];
    return [{
      id: `amadeus:${hotelId}:${offerId}`,
      hotelId,
      offerId,
      name,
      address: input.destination,
      checkInDate: text(offer?.checkInDate),
      checkOutDate: text(offer?.checkOutDate),
      nightlyRate: Math.round(total / input.nights),
      total: Math.round(total),
      currency: text(price?.currency) || 'PHP',
      roomDescription: text(description?.text).replace(/\s+/g, ' ').trim() || 'Available room',
      cancellationPolicy: text(cancellationDescription?.text) || 'Check the provider terms before booking.',
      available: hotelResult?.available !== false,
      isLive,
      source: 'amadeus',
      fetchedAt,
    }];
  });
}

export class AmadeusTravelProvider implements TravelProvider {
  readonly name = 'amadeus';
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    accessToken: string,
    environment: 'test' | 'production',
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.accessToken = accessToken;
    this.fetchImplementation = fetchImplementation;
    this.baseUrl = environment === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
    this.isLive = environment === 'production';
  }

  readonly isLive: boolean;

  private async locationCode(place: string): Promise<string | null> {
    const keywords = place.split(',').map((part) => part.replace(/[^a-z\s-]/gi, '').trim()).filter((part) => part.length >= 2);
    for (const keyword of keywords) {
      const params = new URLSearchParams({ subType: 'CITY,AIRPORT', keyword: keyword.slice(0, 40), view: 'LIGHT' });
      const response = await this.fetchImplementation(`${this.baseUrl}/v1/reference-data/locations?${params}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) continue;
      const options = array(object(await response.json())?.data).map(object).filter((item): item is Record<string, unknown> => Boolean(item));
      const code = options.map((item) => text(item.iataCode)).find((candidate) => /^[A-Z]{3}$/.test(candidate));
      if (code) return code;
    }
    return null;
  }

  async searchFlights(input: FlightSearchInput, fetchedAt: string): Promise<FlightOption[]> {
    const [originCode, destinationCode] = await Promise.all([this.locationCode(input.origin), this.locationCode(input.destination)]);
    if (!originCode || !destinationCode) throw new Error('No airport or city code was found for the selected route.');
    const params = new URLSearchParams({
      originLocationCode: originCode,
      destinationLocationCode: destinationCode,
      departureDate: input.departureDate,
      adults: String(input.adults),
      currencyCode: 'PHP',
      max: '10',
    });
    if (input.returnDate && input.returnDate > input.departureDate) params.set('returnDate', input.returnDate);
    const response = await this.fetchImplementation(`${this.baseUrl}/v2/shopping/flight-offers?${params}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Amadeus flight search failed (${response.status}).`);
    return normalizeFlightOffers(await response.json(), fetchedAt, this.isLive);
  }

  async searchActivities(input: ActivitySearchInput, fetchedAt: string): Promise<ActivityOption[]> {
    const params = new URLSearchParams({ latitude: String(input.latitude), longitude: String(input.longitude), radius: '20' });
    const response = await this.fetchImplementation(`${this.baseUrl}/v1/shopping/activities?${params}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Amadeus activity search failed (${response.status}).`);
    return normalizeActivityOffers(await response.json(), input.destination, fetchedAt, this.isLive).slice(0, 12);
  }

  async searchAccommodations(input: AccommodationSearchInput, fetchedAt: string): Promise<AccommodationSearchResult> {
    const hotelListParams = new URLSearchParams({
      latitude: String(input.latitude),
      longitude: String(input.longitude),
      radius: '20',
      radiusUnit: 'KM',
      hotelSource: 'ALL',
    });
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    const hotelListResponse = await this.fetchImplementation(`${this.baseUrl}/v1/reference-data/locations/hotels/by-geocode?${hotelListParams}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (!hotelListResponse.ok) return { accommodations: [], inventoryAvailable: false, hotelsFound: false };

    const hotelIds = array(object(await hotelListResponse.json())?.data)
      .map(object)
      .filter((hotel): hotel is Record<string, unknown> => Boolean(hotel))
      .map((hotel) => text(hotel.hotelId))
      .filter(Boolean)
      .slice(0, 20);
    if (hotelIds.length === 0) return { accommodations: [], inventoryAvailable: true, hotelsFound: false };

    const rooms = Math.min(9, Math.max(1, Math.ceil(input.adults / 2)));
    const offerParams = new URLSearchParams({
      hotelIds: hotelIds.join(','),
      adults: String(input.adults),
      checkInDate: input.checkInDate,
      checkOutDate: input.checkOutDate,
      roomQuantity: String(rooms),
      currency: 'PHP',
      bestRateOnly: 'true',
    });
    const offersResponse = await this.fetchImplementation(`${this.baseUrl}/v3/shopping/hotel-offers?${offerParams}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(20_000),
    });
    if (!offersResponse.ok) return { accommodations: [], inventoryAvailable: true, hotelsFound: true };
    return {
      accommodations: normalizeAccommodationOffers(await offersResponse.json(), input, fetchedAt, this.isLive),
      inventoryAvailable: true,
      hotelsFound: true,
    };
  }
}

export async function createAmadeusTravelProvider(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): Promise<AmadeusTravelProvider | null> {
  const clientId = environment.AMADEUS_API_KEY;
  const clientSecret = environment.AMADEUS_API_SECRET;
  if (!clientId || !clientSecret || clientId.startsWith('your_') || clientSecret.startsWith('your_')) return null;
  const mode = environment.AMADEUS_ENV === 'production' ? 'production' : 'test';
  const baseUrl = mode === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const response = await fetchImplementation(`${baseUrl}/v1/security/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Amadeus authentication failed (${response.status}).`);
  const token = text(object(await response.json())?.access_token);
  if (!token) throw new Error('Amadeus authentication returned no access token.');
  return new AmadeusTravelProvider(token, mode, fetchImplementation);
}
