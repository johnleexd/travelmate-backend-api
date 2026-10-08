import { countryForQuery } from '../destination/destination-index.ts';

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
  selectionToken?: string;
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
  selectionToken?: string;
}

export interface AccommodationOffer {
  originalName?: string;
  nameSource?: 'provider-english' | 'transliterated' | 'unavailable';
  id: string;
  hotelId: string;
  offerId: string;
  name: string;
    type: 'Hotel' | 'Hostel' | 'Condo' | 'Apartment' | 'Resort' | 'Guesthouse' | 'Accommodation';
  typeSource: 'name-inferred';
  rating?: number;
  amenities?: string[];
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
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
  currency: string;
  originCoordinates?: { latitude: number; longitude: number };
  originCountryCode?: string;
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
  roomQuantity?: number;
  nights: number;
  currency: string;
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

export function inferAccommodationType(name: string): AccommodationOffer['type'] {
  const normalized = name.toLowerCase();
  if (/\b(guesthouse|guest house|guest-house)\b/.test(normalized)) return 'Guesthouse';
  if (/\bhostel\b/.test(normalized)) return 'Hostel';
  if (/\b(condo|condominium)\b/.test(normalized)) return 'Condo';
  if (/\b(apartment|apartments|aparthotel|apart-hotel|residence)\b/.test(normalized)) return 'Apartment';
  if (/\bresort\b/.test(normalized)) return 'Resort';
  if (/\bhotel\b/.test(normalized)) return 'Hotel';
  return 'Accommodation';
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
    input: Pick<AccommodationSearchInput, 'destination' | 'nights' | 'currency'> & { roomQuantity?: number },
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
    const rating = hotel?.rating === undefined || hotel?.rating === null || hotel?.rating === '' ? NaN : Number(hotel.rating);
    const addressData = object(hotel?.address);
    const address = array(addressData?.lines).map(text).filter(Boolean).join(', ');
      const roomTotal = amount(price?.total);
      if (!hotelId || !offerId || !name || roomTotal === undefined || roomTotal <= 0 || hotelResult?.available !== true || !text(price?.currency)) return [];
      const total = Math.round(roomTotal * (input.roomQuantity || 1) * 100) / 100;
    return [{
      id: `amadeus:${hotelId}:${offerId}`,
      hotelId,
      offerId,
      name,
      type: inferAccommodationType(name),
      typeSource: 'name-inferred',
      ...(Number.isFinite(rating) && rating > 0 && rating <= 5 ? { rating } : {}),
      ...(Array.isArray(hotel?.amenities) ? { amenities: hotel.amenities.filter((item): item is string => typeof item === 'string' && item.length <= 100).slice(0, 12) } : {}),
      ...(typeof hotel?.latitude === 'number' && Number.isFinite(hotel.latitude) && Math.abs(hotel.latitude) <= 90 && typeof hotel?.longitude === 'number' && Number.isFinite(hotel.longitude) && Math.abs(hotel.longitude) <= 180 ? { latitude: hotel.latitude, longitude: hotel.longitude } : {}),
      address: address || 'Not available; confirm with the hotel',
      checkInDate: text(offer?.checkInDate),
      checkOutDate: text(offer?.checkOutDate),
        nightlyRate: Math.round(total / input.nights * (['JPY','KRW'].includes(text(price?.currency)) ? 1 : 100)) / (['JPY','KRW'].includes(text(price?.currency)) ? 1 : 100),
        total,
      currency: text(price?.currency) || input.currency,
      roomDescription: text(description?.text).replace(/\s+/g, ' ').trim() || 'Available room',
      cancellationPolicy: text(cancellationDescription?.text) || 'Check the provider terms before booking.',
        available: true,
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
    const parts = place.split(',').map(part => part.trim());
    const countryCode = parts.length > 1 ? countryForQuery(parts.at(-1)!) : undefined;
    const keywords = [parts[0].replace(/[^\p{L}\p{N}\s-]/gu, '').trim()].filter(part => part.length >= 2);
    for (const keyword of keywords) {
      const params = new URLSearchParams({ subType: 'CITY,AIRPORT', keyword: keyword.slice(0, 40), view: 'LIGHT', ...(countryCode ? { countryCode } : {}) });
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

  private async originAirport(input: FlightSearchInput): Promise<string | null> {
    if (!input.originCoordinates) return this.locationCode(input.origin);
    const { latitude, longitude } = input.originCoordinates;
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('Invalid origin coordinates.');
    // Resolve the user's selected point, not the first airport sharing a city name.
    const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), radius: '500', sort: 'distance' });
    const response = await this.fetchImplementation(`${this.baseUrl}/v1/reference-data/locations/airports?${params}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Origin airport lookup failed (${response.status}).`);
    const airports = array(object(await response.json())?.data).map(object).filter((item): item is Record<string, unknown> => Boolean(item));
    const valid = airports.filter(item => /^[A-Z]{3}$/.test(text(item.iataCode)));
    const domestic = input.originCountryCode ? valid.filter(item => text(object(item.address)?.countryCode).toUpperCase() === input.originCountryCode) : [];
    // Places without a commercial airport can use a nearby airport across a border.
    const candidates = domestic.length ? domestic : valid;
    return candidates.length ? text(candidates[0].iataCode) : null;
  }

  async searchFlights(input: FlightSearchInput, fetchedAt: string): Promise<FlightOption[]> {
    const [originCode, destinationCode] = await Promise.all([this.originAirport(input), this.locationCode(input.destination)]);
    if (!originCode || !destinationCode) throw new Error('No airport or city code was found for the selected route.');
    const params = new URLSearchParams({
      originLocationCode: originCode,
      destinationLocationCode: destinationCode,
      departureDate: input.departureDate,
        adults: String(input.adults),
      currencyCode: input.currency,
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

  async revalidateAccommodationOffer(offerId: string, input: AccommodationSearchInput, expectedHotelId: string) {
    const response = await this.fetchImplementation(this.baseUrl + '/v3/shopping/hotel-offers/' + encodeURIComponent(offerId) + '?lang=EN', {
      headers: { Authorization: 'Bearer ' + this.accessToken, 'Accept-Language': 'en' }, cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('This room quote is no longer available. Refresh accommodations.');
    const payload = object(await response.json());
    const raw = object(payload?.data);
    const result = normalizeAccommodationOffers({ data: raw ? [raw] : [] }, input, new Date().toISOString(), this.isLive).find(offer => offer.hotelId === expectedHotelId && offer.offerId === offerId);
    if (!result) throw new Error('The room is no longer available for your dates. Refresh accommodations.');
    const { localizePropertyNames } = await import('../destination/accommodation-localization.ts');
    const localized = (await localizePropertyNames([{ ...result, nameSource: 'provider-english' as AccommodationOffer['nameSource'] }]))[0];
    return { ...localized, name: localized.nameSource === 'unavailable' ? 'Accommodation name unavailable in English' : localized.name };
  }

  async searchAccommodations(input: AccommodationSearchInput, fetchedAt: string): Promise<AccommodationSearchResult> {
    const hotelListParams = new URLSearchParams({
      latitude: String(input.latitude),
      longitude: String(input.longitude),
      radius: '20',
      radiusUnit: 'KM',
      hotelSource: 'ALL',
    });
    const headers = { Authorization: `Bearer ${this.accessToken}`, 'Accept-Language': 'en' };
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

    const rooms = input.roomQuantity ?? Math.min(9, Math.max(1, Math.ceil(input.adults / 2)));
    const offerParams = new URLSearchParams({
      hotelIds: hotelIds.join(','),
      adults: String(Math.ceil(input.adults / rooms)),
      checkInDate: input.checkInDate,
      checkOutDate: input.checkOutDate,
      roomQuantity: String(rooms),
      currency: input.currency,
      bestRateOnly: 'true',
      lang: 'EN',
    });
    const offersResponse = await this.fetchImplementation(`${this.baseUrl}/v3/shopping/hotel-offers?${offerParams}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(20_000),
    });
    if (!offersResponse.ok) return { accommodations: [], inventoryAvailable: false, hotelsFound: true };
    const { localizePropertyNames } = await import('../destination/accommodation-localization.ts');
    const localized = await localizePropertyNames(normalizeAccommodationOffers(await offersResponse.json(), { ...input, roomQuantity: rooms }, fetchedAt, this.isLive).filter(offer => hotelIds.includes(offer.hotelId)).map(offer => ({ ...offer, nameSource: 'provider-english' as AccommodationOffer['nameSource'] })));
    return {
      accommodations: localized.map(offer => ({ ...offer, name: offer.nameSource === 'unavailable' ? 'Accommodation name unavailable in English' : offer.name })),
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
