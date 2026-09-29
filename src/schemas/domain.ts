export type Role = 'traveler' | 'admin';
export type ProfileStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type TripStatus = 'active' | 'archived';
export type ItineraryVersionKind = 'saved' | 'regenerated' | 'manual_edit' | 'duplicated' | 'restored';
export type GenerationStatus = 'pending' | 'completed' | 'failed';
export type PaymentStatus = 'PENDING' | 'PAID_HELD' | 'Released' | 'FROZEN_HELD' | 'REFUNDED';
export type PartyType = 'solo' | 'couple' | 'family' | 'friends';
export const SUPPORTED_CURRENCIES = ['PHP', 'USD', 'EUR', 'JPY', 'KRW', 'THB', 'GBP', 'AUD', 'CAD', 'SGD', 'CNY', 'HKD', 'TWD', 'MYR', 'IDR', 'VND', 'INR', 'NZD', 'CHF', 'AED'] as const;
export type CurrencyCode = typeof SUPPORTED_CURRENCIES[number];
export const ZERO_DECIMAL_CURRENCIES: readonly CurrencyCode[] = ['JPY', 'KRW', 'VND'];

export function normalizeCurrency(value: unknown): CurrencyCode {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!SUPPORTED_CURRENCIES.includes(currency as CurrencyCode)) {
    throw new Error(`Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}.`);
  }
  return currency as CurrencyCode;
}

export function formatMoney(value: number, currency: CurrencyCode): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.includes(currency) ? 0 : 2,
  }).format(value);
}

export const PARTY_TYPE_LABELS: Record<PartyType, string> = {
  solo: 'Solo',
  couple: 'Couple',
  family: 'Family',
  friends: 'Friends / barkada',
};

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  profileStatus: ProfileStatus;
  trustScore: number;
  accountStatus: 'active' | 'suspended';
  bio?: string;
  phone?: string;
}

export interface StoredUser extends PublicUser {
  passwordHash: string | null;
  passwordSalt: string | null;
}

export interface Listing {
  id: string;
  ownerId: string;
  name: string;
  category: 'stay' | 'activity' | 'food' | 'transport';
  price: number;
  capacity: number;
  available: number;
  status: 'pending' | 'approved' | 'rejected';
  description: string;
  municipality: string;
  address: string;
  amenities: string[];
  imageUrl?: string;
  imageUrls: string[];
  viewCount: number;
}

export interface Booking {
  id: string;
  travelerId: string;
  listingId: string;
  amount: number;
  guests: number;
  nights: number;
  status: 'pending' | 'confirmed' | 'declined' | 'change_requested' | 'cancel_requested' | 'cancelled' | 'completed';
  paymentStatus: PaymentStatus;
  checkIn?: string;
  checkOut?: string;
  notes: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  requestedGuests?: number;
  requestNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListingBlockedDate { id: string; listingId: string; date: string; reason: string; }
export interface Promotion { id: string; listingId: string; name: string; discountPct: number; startDate: string; endDate: string; active: boolean; }
export interface Review { id: string; bookingId: string; listingId: string; travelerId: string; rating: number; comment: string; createdAt: string; }
export interface Notification { id: string; userId: string; title: string; body: string; href: string; readAt?: string; createdAt: string; }
export interface PaymentTransaction { id: string; bookingId: string; kind: string; status: string; amount: number; note: string; createdAt: string; }
export interface OwnerDocument { id: string; ownerId: string; type: string; name: string; fileUrl: string; status: string; createdAt: string; }

export interface ModerationItem {
  id: string;
  kind: 'profile' | 'listing' | 'dispute' | 'report';
  subjectId: string;
  title: string;
  details: string;
  status: 'pending' | 'approved' | 'rejected' | 'resolved';
  createdAt: string;
}

export interface SavedTrip {
  id: string;
  userId: string;
  destination: string;
  destinationCity?: string;
  destinationRegion?: string;
  destinationCountry?: string;
  destinationCountryCode?: string;
  latitude?: number;
  longitude?: number;
  budget: number;
  currency: CurrencyCode;
  startDate: string;
  endDate: string;
  travelers: number;
  partyType: PartyType;
  interests: string[];
  itinerary: unknown;
  weather: unknown;
  status: TripStatus;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItineraryVersion {
  id: string;
  tripId: string;
  version: number;
  kind: ItineraryVersionKind;
  itinerary: unknown;
  weather: unknown;
  createdAt: string;
}

export interface ItineraryGenerationSummary {
  id: string;
  userId: string;
  destination: string;
  status: GenerationStatus;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  createdAt: string;
}

export interface Database {
  users: PublicUser[];
  listings: Listing[];
  bookings: Booking[];
  moderation: ModerationItem[];
  trips: SavedTrip[];
  itineraryVersions: ItineraryVersion[];
  itineraryGenerations: ItineraryGenerationSummary[];
  audit: AuditEvent[];
  blockedDates: ListingBlockedDate[];
  promotions: Promotion[];
  reviews: Review[];
  notifications: Notification[];
  transactions: PaymentTransaction[];
  ownerDocuments: OwnerDocument[];
}

export interface BudgetSplit {
  accommodation: number;
  food: number;
  activities: number;
  transport: number;
  reserve: number;
  dailyAverage: number;
  total: number;
}

export function splitBudget(total: number, travelers = 1, days = 7): BudgetSplit {
  if (!Number.isFinite(total) || total <= 0) throw new Error('Budget must be positive.');
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 20) throw new Error('Travelers must be between 1 and 20.');
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Trip length must be between 1 and 14 days.');
  const weights = { accommodation: 0.34, food: 0.22, activities: 0.2, transport: 0.14 };
  const accommodation = Math.round(total * weights.accommodation);
  const food = Math.round(total * weights.food);
  const activities = Math.round(total * weights.activities);
  const transport = Math.round(total * weights.transport);
  const reserve = total - accommodation - food - activities - transport;
  return { accommodation, food, activities, transport, reserve, dailyAverage: Math.round(total / days), total };
}

export function travelersForParty(partyType: PartyType, requestedTravelers: number): number {
  if (partyType === 'solo') return 1;
  if (partyType === 'couple') return 2;
  if (!Number.isInteger(requestedTravelers) || requestedTravelers < 2 || requestedTravelers > 20) {
    throw new Error('Family and friends groups must have between 2 and 20 travelers.');
  }
  return requestedTravelers;
}

export function currencyFractionDigits(currency: CurrencyCode): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.includes(currency) ? 0 : 2;
}

export function hasValidCurrencyPrecision(value: number, currency: CurrencyCode): boolean {
  if (!Number.isFinite(value)) return false;
  const scale = 10 ** currencyFractionDigits(currency);
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-7;
}

/** Split money exactly in its smallest supported unit; the first members absorb any remainder. */
export function allocateEqualShares(total: number, travelers: number, currency: CurrencyCode): number[] {
  if (total < 0 || !hasValidCurrencyPrecision(total, currency)) {
    throw new Error(`Shared amount must be a non-negative ${currency} value with at most ${currencyFractionDigits(currency)} decimal places.`);
  }
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 20) throw new Error('Travelers must be between 1 and 20.');
  const scale = 10 ** currencyFractionDigits(currency);
  const minorUnitTotal = Math.round(total * scale);
  const base = Math.floor(minorUnitTotal / travelers);
  const remainder = minorUnitTotal - base * travelers;
  return Array.from({ length: travelers }, (_, index) => (base + (index < remainder ? 1 : 0)) / scale);
}

/** Preserve the relative mix of estimates while keeping their exact whole-peso sum under a cap. */
export function capCostsToBudget(costs: number[], cap: number): number[] {
  const safeCosts = costs.map((cost) => Math.max(0, Math.round(Number.isFinite(cost) ? cost : 0)));
  const safeCap = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0));
  const total = safeCosts.reduce((sum, cost) => sum + cost, 0);
  if (total <= safeCap) return safeCosts;
  if (total === 0 || safeCap === 0) return safeCosts.map(() => 0);

  const scaled = safeCosts.map((cost) => (cost * safeCap) / total);
  const capped = scaled.map(Math.floor);
  let remainder = safeCap - capped.reduce((sum, cost) => sum + cost, 0);
  const order = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) capped[order[index].index] += 1;
  return capped;
}

const DAILY_SPEND_WEIGHTS = [11, 14, 16, 13, 19, 17, 10] as const;

export function allocateDailyBudget(total: number, reserve: number, days = 7): number[] {
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Trip length must be between 1 and 14 days.');
  const spendable = Math.max(0, Math.round(total - reserve));
  const weights = Array.from({ length: days }, (_, index) => DAILY_SPEND_WEIGHTS[index % DAILY_SPEND_WEIGHTS.length]);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const daily = weights.map((weight) => Math.floor((spendable * weight) / weightTotal));
  let remainder = spendable - daily.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % daily.length) {
    daily[index] += 1;
    remainder -= 1;
  }
  return daily;
}

type PublicUserSource = Omit<PublicUser, 'bio' | 'phone'> & {
  bio?: string | null;
  phone?: string | null;
};

export function publicUser(user: PublicUserSource): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
    profileStatus: user.profileStatus,
    trustScore: user.trustScore,
    accountStatus: user.accountStatus,
    bio: user.bio ?? undefined,
    phone: user.phone ?? undefined,
  };
}
