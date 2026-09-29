import { SUPPORTED_CURRENCIES, type CurrencyCode } from '../../schemas/domain.ts';

export interface TransportationOption {
  id: string;
  label: string;
  category: 'public' | 'private' | 'active' | 'water';
}

export interface DestinationContext {
  currency: CurrencyCode | null;
  currencySource: 'country-code' | 'unsupported';
  transportation: TransportationOption[];
  transportationSource: 'curated-country-city-guidance' | 'unavailable';
  transportationMessage: string;
}

const COUNTRY_CURRENCIES: Record<string, CurrencyCode> = {
  AE: 'AED', AT: 'EUR', AU: 'AUD', BE: 'EUR', CA: 'CAD', CH: 'CHF', CN: 'CNY', DE: 'EUR',
  ES: 'EUR', FI: 'EUR', FR: 'EUR', GB: 'GBP', GR: 'EUR', HK: 'HKD', ID: 'IDR', IE: 'EUR',
  IN: 'INR', IT: 'EUR', JP: 'JPY', KR: 'KRW', LU: 'EUR', MY: 'MYR', NL: 'EUR', NZ: 'NZD',
  PH: 'PHP', PT: 'EUR', SG: 'SGD', TH: 'THB', TW: 'TWD', US: 'USD', VN: 'VND',
};

const option = (id: string, label: string, category: TransportationOption['category']): TransportationOption => ({ id, label, category });

const WALKING = option('walking', 'Walking', 'active');
const BUS = option('bus', 'Bus', 'public');
const TAXI = option('taxi', 'Taxi', 'private');
const RIDE_HAILING = option('ride-hailing', 'Ride-hailing', 'private');
const TRAIN = option('train', 'Train', 'public');
const METRO = option('metro-subway', 'Metro / Subway', 'public');
const RENTAL_CAR = option('rental-car', 'Rental car', 'private');

function transportFor(countryCode: string, city: string): TransportationOption[] {
  const normalizedCity = city.trim().toLowerCase();
  switch (countryCode) {
    case 'PH': {
      const modes = [BUS, option('jeepney', 'Jeepney', 'public'), TAXI, RIDE_HAILING, option('tricycle', 'Tricycle', 'private'), WALKING];
      if (/cebu|lapu-lapu|cordova|mandaue|iloilo|bacolod|davao/.test(normalizedCity)) modes.splice(5, 0, option('ferry', 'Ferry', 'water'));
      return modes;
    }
    case 'JP': return [TRAIN, METRO, BUS, TAXI, WALKING];
    case 'KR': return [METRO, TRAIN, BUS, TAXI, WALKING];
    case 'FR': return [TRAIN, ...(/paris|lyon|marseille|lille|toulouse/.test(normalizedCity) ? [METRO] : []), BUS, TAXI, WALKING];
    case 'TH': return [...(/bangkok/.test(normalizedCity) ? [TRAIN, METRO] : []), BUS, TAXI, RIDE_HAILING, option('tuk-tuk', 'Tuk-tuk', 'private'), ...(/bangkok|phuket|krabi|pattaya/.test(normalizedCity) ? [option('ferry', 'Ferry / boat', 'water')] : []), WALKING];
    case 'US': return [...(/new york|chicago|washington|boston|san francisco|philadelphia/.test(normalizedCity) ? [METRO] : []), BUS, TAXI, RIDE_HAILING, RENTAL_CAR, WALKING];
    case 'GB': return [TRAIN, ...(/london|glasgow|newcastle/.test(normalizedCity) ? [METRO] : []), BUS, TAXI, WALKING];
    case 'SG': return [METRO, BUS, TAXI, RIDE_HAILING, WALKING];
    case 'HK': return [METRO, BUS, TAXI, option('ferry', 'Ferry', 'water'), WALKING];
    case 'TW': return [TRAIN, METRO, BUS, TAXI, WALKING];
    case 'MY': return [...(/kuala lumpur/.test(normalizedCity) ? [TRAIN, METRO] : []), BUS, TAXI, RIDE_HAILING, RENTAL_CAR, WALKING];
    default: return [];
  }
}

export function resolveDestinationContext(countryCodeValue: string, city: string): DestinationContext {
  const countryCode = countryCodeValue.trim().toUpperCase();
  const currency = COUNTRY_CURRENCIES[countryCode] || null;
  const transportation = transportFor(countryCode, city);
  return {
    currency: currency && SUPPORTED_CURRENCIES.includes(currency) ? currency : null,
    currencySource: currency ? 'country-code' : 'unsupported',
    transportation,
    transportationSource: transportation.length ? 'curated-country-city-guidance' : 'unavailable',
    transportationMessage: transportation.length
      ? 'Common destination-specific modes from TravelMate guidance; availability and schedules are not live.'
      : 'TravelMate has no verified transportation guidance for this destination yet. You can continue without choosing a mode; the generated plan will request locally appropriate transportation.',
  };
}
