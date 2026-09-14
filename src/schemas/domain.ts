export type Role = 'traveler' | 'owner' | 'admin';
export type ProfileStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type PaymentStatus = 'PAID_HELD' | 'Released' | 'FROZEN_HELD' | 'REFUNDED';
export type PartyType = 'solo' | 'couple' | 'family' | 'friends';

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
  passwordHash: string;
  passwordSalt: string;
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
}

export interface Booking {
  id: string;
  travelerId: string;
  listingId: string;
  amount: number;
  guests: number;
  nights: number;
  status: 'confirmed' | 'change_requested' | 'cancel_requested' | 'cancelled' | 'completed';
  paymentStatus: PaymentStatus;
  createdAt: string;
}

export interface ModerationItem {
  id: string;
  kind: 'profile' | 'listing' | 'dispute';
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
  budget: number;
  startDate: string;
  endDate: string;
  travelers: number;
  interests: string[];
  itinerary: unknown;
  weather: unknown;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  createdAt: string;
}

export interface Database {
  users: StoredUser[];
  listings: Listing[];
  bookings: Booking[];
  moderation: ModerationItem[];
  trips: SavedTrip[];
  audit: AuditEvent[];
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

/** Split whole-peso costs exactly; the first members absorb any PHP 1 remainder. */
export function allocateEqualShares(total: number, travelers: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('Shared amount must be a non-negative whole peso value.');
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 20) throw new Error('Travelers must be between 1 and 20.');
  const base = Math.floor(total / travelers);
  const remainder = total - base * travelers;
  return Array.from({ length: travelers }, (_, index) => base + (index < remainder ? 1 : 0));
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
