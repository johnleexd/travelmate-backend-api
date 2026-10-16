import { notifyAdmins } from '../services/platform/admin-notification-service.ts';
import { publishReportChange } from '../services/platform/report-events.ts';
// app/api/itinerary/route.ts
// ─── Server-only Route Handler ────────────────────────────────────────────────
// Keeps AI provider keys strictly on the server; never bundled to the client.

import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import {
  allocateEqualShares, allocateNightlyCosts,
  hasValidCurrencyPrecision,
  normalizeCurrency,
  splitBudget,
  travelersForParty,
  currencyFractionDigits, roundMoney, sumMoney,
  type CurrencyCode,
  type PartyType,
} from '../schemas/domain.ts';
import { readApprovedListings } from '../repositories/platform-repository.ts';
import { plannedAccommodationSchema, type PlannedAccommodation } from '../services/destination/planned-accommodation.ts';
import { createAmadeusTravelProvider } from '../services/travel/amadeus-provider.ts';
import { openQuote, type AccommodationQuote } from '../services/travel/hotel-quote.ts';
import { revalidateHotelRecommendation } from '../services/travel/hotel-recommendations.ts';
import { verifyOfferToken } from '../utils/offer-token.ts';
import { verifyTravelSelectionToken } from '../utils/travel-selection-token.ts';
import { mockItinerariesEnabled, resolveAIProviders } from '../services/ai/provider.ts';
import {
  buildBudgetOptimization,
  type BudgetOptimization,
} from '../services/budget/budget-optimization-service.ts';
import { normalizePreTripCosts, type PreTripCosts } from '../services/budget/pre-trip-cost-service.ts';
import { estimateCrowd, estimateCrowdRange } from '../services/crowd/crowd-service.ts';
import { configuredWeatherProviders, resolveWeather } from '../services/weather/weather-service.ts';
import { forecastAlert, weatherForTripDates } from '../services/weather/weather-domain.ts';
import { PROVIDER_CACHE_POLICIES } from '../services/cache/policies.ts';
import { withProviderCache } from '../services/cache/provider-cache.ts';
import { generateGroundedSchedule, dateAt, type GroundedScheduleDay } from '../services/ai/grounded-schedule.ts';
import { loadGroundedPlaces, validateDestinationAnchor, permittedPlaceCandidates } from '../services/itinerary/grounded-places.ts';
import { type PlaceEvidence, type PriceEvidence, type PlanGrounding } from '../services/itinerary/grounding-schema.ts';
import { generationPreferencesSchema, preferenceInstructions, generationDefaults, generationPolicyVersion } from '../services/itinerary/travel-preferences.ts';
import { buildGroundedPlan, signGroundedPlan, verifyGroundedPlan } from '../services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../services/itinerary/saved-trip-schema.ts';
import { generationConstraintsSchema, completeGroundedSchedule, type ScheduleMetadata } from '../services/itinerary/generated-day-scheduler.ts';
import { retainSelectedActivityPhotos } from '../services/itinerary/saved-activity-photos.ts';
import { fillDayDisplayPhotos } from '../services/itinerary/activity-display-photos.ts';
import { reusableWikimediaLicense } from '../lib/wikimedia-photo-license.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DayActivity {
  id?: string;
  status?: 'planned' | 'completed' | 'skipped' | 'rescheduled';
  statusChangedAt?: string;
  managementHistory?: { action: 'complete' | 'skip' | 'plan' | 'edit' | 'reschedule' | 'replan'; status: 'planned' | 'completed' | 'skipped' | 'rescheduled'; at: string; fromDate: string; fromTime: string; toDate: string; toTime: string }[];
  durationMinutes?: number;
  travelMinutes?: number;
  location?: string;
  time: string;       // e.g. "09:00 AM"
  title: string;
  description: string;
  estimatedCost: number;
  unitCost?: number;
  category: 'accommodation' | 'food' | 'activity' | 'transport' | 'misc';
  icon: string;       // emoji shorthand
  imageUrl?: string;
  imageAttribution?: ImageAttribution;
  googlePlaceId?: string;
  placeVerification?: 'supporting-source-found' | 'unverified';
  place?: PlaceEvidence;
  priceEvidence?: PriceEvidence;
  scheduleLabel?: 'Suggested';
}

export interface ImageAttribution {
  creator: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
  provider?: 'unsplash';
  photoType?: 'place' | 'illustrative' | 'destination' | 'saved';
  photoId?: string;
  photographerUrl?: string;
  photographerUsername?: string;
  illustrative?: boolean;
  match?: 'place' | 'destination' | 'activity';
  downloadLocation?: string;
  downloadTracked?: boolean;
  selectedAt?: string;
}

export interface DayPlan extends ScheduleMetadata {
  day: number;        // sequential trip day
  date: string;       // ISO date string "YYYY-MM-DD"
  theme: string;      // e.g. "Arrival & City Tour"
  imageUrl: string;
  imageAttribution?: ImageAttribution;
  travelNote?: string;
  returnToStayAt?: string;
  rideFare?: number;
  totalCost: number;
  activities: DayActivity[];
  weatherAlert?: string;
  crowdLevel?: 'low' | 'moderate' | 'high';
  crowdSource?: 'estimated';
  crowdConfidence?: 'low';
  crowdNote?: string;
  crowdRecommendation?: string;
  crowdFetchedAt?: string;
  crowdRefreshAfter?: string;
}

export interface AccommodationPlan {
  latitude?: number;
  longitude?: number;
  photos?: import('../services/travel/hotel-quote.ts').PropertyPhoto[];
  listingId: string;
  name: string;
  address: string;
  nightlyRate: number;
  nights: number;
  total: number;
  currency: CurrencyCode;
  source?: 'travelmate' | 'amadeus' | 'expedia-rapid' | 'liteapi';
  providerQuote?: AccommodationQuote;
  offerId?: string;
  isLive?: boolean;
  quotedTotal?: number;
  fetchedAt?: string;
  rooms?: number;
}

const DAY_IMAGES = [
  '/travel-illustration.png',
  '/mountain-hero-bg.png',
  '/beach-bg.png',
  '/travel-illustration.png',
  '/beach-bg.png',
  '/mountain-hero-bg.png',
  '/travel-illustration.png',
] as const;

function activityImage(_title: string, _fallback: string): string { return ''; }

type CommonsImage = { imageUrl: string; attribution: ImageAttribution };
type CommonsImageSearch = (query: string, limit: number, signal?: AbortSignal) => Promise<CommonsImage[]>;
type PhotoSearchOptions = { timeoutMs?: number; signal?: AbortSignal };
const commonsImageCache = new Map<string, { expiresAt: number; images: CommonsImage[] }>();

function plainText(value: string | undefined): string {
  return (value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
}

const IMAGE_SEARCH_STOP_WORDS = new Set([
  'activity', 'breakfast', 'cafe', 'dinner', 'explore', 'food', 'japan', 'lunch',
  'philippines', 'restaurant', 'the', 'tour', 'travel', 'trip', 'visit', 'with',
]);

function imageSearchTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/)
    .filter((term) => term.length >= 4 && !IMAGE_SEARCH_STOP_WORDS.has(term)))];
}

export interface SelectedTravelCosts {
  flight?: { id: string; name: string; total: number; currency: CurrencyCode; fetchedAt: string; source?: "amadeus"; isLive?: boolean };
  activities: Array<{ id: string; name: string; unitCost: number; travelers: number; total: number; currency: CurrencyCode; fetchedAt: string; source?: "amadeus" | "travelmate"; isLive?: boolean; priceBasis?: "per-person-assumption" }>;
  preTrip?: PreTripCosts;
  total: number;
}

export function imageResultMatches(query: string, candidate: string): boolean {
  const terms = imageSearchTerms(query);
  if (terms.length === 0) return false;
  const candidateText = ` ${candidate.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const matches = terms.filter((term) => candidateText.includes(` ${term} `) || candidateText.includes(term));
  return matches.length >= Math.min(2, terms.length);
}

export async function searchCommonsImages(query: string, limit: number, signal?: AbortSignal): Promise<CommonsImage[]> {
  if (signal?.aborted) return [];
  const cacheKey = `${query.toLowerCase()}:${limit}`;
  const cached = commonsImageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.images;
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(Math.min(10, Math.max(1, limit))),
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1200',
    iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl', iiextmetadatalanguage: 'en',
  });
  try {
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': 'TravelMate/1.0 location-photo-search', 'Api-User-Agent': 'TravelMate/1.0 location-photo-search' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { query?: { pages?: Record<string, { pageid: number; title?: string; index?: number; imageinfo?: Array<{ thumburl?: string; url?: string; extmetadata?: Record<string, { value?: string }> }> }> } };
    const images = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).flatMap((page): CommonsImage[] => {
      const info = page.imageinfo?.[0];
      const imageUrl = info?.thumburl || info?.url;
      if (!info || !(imageUrl?.startsWith('https://upload.wikimedia.org/') || imageUrl?.startsWith('https://thumb.wikimedia.org/'))) return [];
      const metadata = info.extmetadata || {};
      const license = plainText(metadata.LicenseShortName?.value), creator = plainText(metadata.Artist?.value) || plainText(metadata.Credit?.value);
      const licenseUrl = reusableWikimediaLicense(license, metadata.LicenseUrl?.value);
      if (!creator || !licenseUrl) return [];
      const descriptiveText = `${page.title || ''} ${plainText(metadata.Credit?.value)}`;
      if (!imageResultMatches(query, descriptiveText)) return [];
      return [{
        imageUrl,
        attribution: {
          creator, license, licenseUrl,
          sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}`,
        },
      }];
    });
    if (images.length) {
      if (commonsImageCache.size >= 256) commonsImageCache.delete(commonsImageCache.keys().next().value!);
      commonsImageCache.set(cacheKey, { images, expiresAt: Date.now() + 5 * 60_000 });
    }
    return images;
  } catch {
    return [];
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function firstUnusedImage(images: CommonsImage[], usedImageUrls: Set<string>): CommonsImage | undefined {
  const image = images.find((candidate) => !usedImageUrls.has(candidate.imageUrl)) || images[0];
  if (image) usedImageUrls.add(image.imageUrl);
  return image;
}

/**
 * Retrieves a destination-aware Wikimedia Commons result for every individual
 * activity. A day-level query cannot reliably represent several different
 * places, and previously caused a single result to be repeated down the list.
 */
async function attachImagesToDays(destination: string, days: DayPlan[], search: CommonsImageSearch, options: PhotoSearchOptions = {}): Promise<DayPlan[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const lookups = days.flatMap((day) => day.activities.map((activity) => activity.title));
  const pending = new Map<string, Promise<CommonsImage[]>>();
  const lookup = (query: string) => {
    let result = pending.get(query);
    if (!result) {
      result = new Promise<CommonsImage[]>(resolve => {
        if (signal.aborted) { resolve([]); return; }
        const stop = () => resolve([]);
        signal.addEventListener('abort', stop, { once: true });
        Promise.resolve().then(() => search(query, 5, signal))
          .then(resolve, () => resolve([]))
          .finally(() => signal.removeEventListener('abort', stop));
      });
      pending.set(query, result);
    }
    return result;
  };
  const found = await mapWithConcurrency(lookups, 4, async (title) => {
    // Search the named place without itinerary actions that Commons treats as
    // additional required words. Keep geographic context in every attempt.
    const place = title.replace(/\b(?:guided|visit|explore|tour|walk|walking|briefing|breakfast|lunch|dinner|at|the|of|and|with)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const country = destination.split(',').at(-1)?.trim() || destination;
    const queries = [...new Set([
      `${title} ${destination}`,
      ...(place ? [`${place} ${destination}`, `${place} ${country}`] : []),
    ])];
    for (const query of queries) {
      if (signal.aborted) break;
      const images = await lookup(query);
      if (images.length) return images;
    }
    return [];
  });
  const usedImageUrls = new Set<string>();
  let lookupIndex = 0;

  return days.map((day) => {
    const activityPhotos = day.activities.map(() => firstUnusedImage(found[lookupIndex++] || [], usedImageUrls));
    const dayImage = activityPhotos.find(Boolean);
    return {
      ...day,
      imageUrl: dayImage?.imageUrl || day.imageUrl,
      imageAttribution: dayImage?.attribution || day.imageAttribution,
      activities: day.activities.map((item, activityIndex) => {
        const activityPhoto = activityPhotos[activityIndex];
        return { ...item, imageUrl: activityPhoto?.imageUrl || item.imageUrl, imageAttribution: activityPhoto?.attribution || item.imageAttribution, placeVerification: activityPhoto ? 'supporting-source-found' : 'unverified' };
      }),
    };
  });
}

export async function attachPlaceImages(itinerary: ItineraryResponse, search: CommonsImageSearch = searchCommonsImages, options: PhotoSearchOptions = {}): Promise<ItineraryResponse> {
  return { ...itinerary, days: await attachImagesToDays(itinerary.destination, itinerary.days, search, options) };
}

async function finalizeItinerary(itinerary: ItineraryResponse, budgetSummary: ReturnType<typeof splitBudget>, partyType: PartyType, travelers: number, tripDays: number, startDate: string, accommodation?: Omit<AccommodationPlan, 'nights' | 'total'>, selectedTravelCosts?: SelectedTravelCosts, signal?: AbortSignal): Promise<ItineraryResponse> {
  return attachPlaceImages(normalizeItinerary(itinerary, budgetSummary, partyType, travelers, tripDays, startDate, accommodation, selectedTravelCosts), searchCommonsImages, { signal });
}

export function normalizeItinerary(itinerary: ItineraryResponse, budgetSummary: ReturnType<typeof splitBudget>, partyType: PartyType, travelers: number, tripDays: number, startDate: string, accommodation?: Omit<AccommodationPlan, 'nights' | 'total'>, selectedTravelCosts?: SelectedTravelCosts): ItineraryResponse {
  if (!Number.isInteger(tripDays) || tripDays < 1 || tripDays > 31 || itinerary.days.length !== tripDays) {
    throw new Error('Itinerary must contain every selected travel day (1–31 days).');
  }
  const nights = accommodation ? Math.max(1, tripDays - 1) : 0;
  const accommodationTotal = accommodation ? accommodation.quotedTotal ?? accommodation.nightlyRate * nights : 0;
  const lodgingByNight = accommodation ? allocateNightlyCosts(accommodationTotal, nights, itinerary.currency) : [];
  const travelOptionsTotal = selectedTravelCosts?.total ?? 0;
  const variableBudget = Math.max(0, budgetSummary.total - accommodationTotal - travelOptionsTotal - budgetSummary.reserve);
  const estimatedUnitCosts = itinerary.days.flatMap((day) => day.activities.map((activity) => Math.max(0, roundMoney(Number.isFinite(activity.estimatedCost) ? activity.estimatedCost : 0,itinerary.currency))));
  let costIndex = 0;
  const crowdRetrievedAt = new Date();
  const days = itinerary.days.map((day, index) => {
    const fallbackImage = day.imageUrl || DAY_IMAGES[index % DAY_IMAGES.length];
    const activities = day.activities.map((activity) => {
      const estimated = estimatedUnitCosts[costIndex++] ?? 0;
      const unitCost = accommodation && activity.category === 'accommodation' ? 0 : estimated;
      return { ...activity, imageUrl: activity.imageUrl || activityImage(activity.title, fallbackImage), unitCost, estimatedCost: unitCost * travelers };
    });
    const activityTotal = activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    const rideFare = activities.filter((activity) => activity.category === 'transport').reduce((sum, activity) => sum + activity.estimatedCost, 0);
    const nightlyCost = lodgingByNight[index] || 0;
    return {
      ...day,
      day: index + 1,
      date: new Date(`${startDate}T00:00:00.000Z`).toISOString().slice(0, 10),
      imageUrl: day.imageUrl || DAY_IMAGES[index % DAY_IMAGES.length],
      returnToStayAt: accommodation ? day.returnToStayAt || '08:00 PM' : undefined,
      rideFare,
      totalCost: sumMoney([activityTotal,nightlyCost],itinerary.currency),
      activities,
    };
  }).map((day, index) => {
    const date = new Date(`${startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const dateText = date.toISOString().slice(0, 10);
    const crowd = estimateCrowd(dateText, itinerary.destination, crowdRetrievedAt);
    return {
      ...day,
      date: dateText,
      crowdLevel: crowd.crowdLevel,
      crowdSource: crowd.crowdSource,
      crowdConfidence: crowd.crowdConfidence,
      crowdNote: crowd.crowdNote,
      crowdRecommendation: crowd.crowdRecommendation,
      crowdFetchedAt: crowd.fetchedAt,
      crowdRefreshAfter: crowd.refreshAfter,
    };
  });
  const plannedSpend = sumMoney([...days.map(day=>day.totalCost),travelOptionsTotal],itinerary.currency);
  const budgetOptimization = buildBudgetOptimization({
    budget: budgetSummary.total,
    currency: itinerary.currency as CurrencyCode,
    reserve: budgetSummary.reserve,
    plannedSpend,
    travelers,
    accommodation: accommodation ? { nightlyRate: accommodation.nightlyRate, nights } : undefined,
    days: days.map((day) => ({
      day: day.day,
      activities: day.activities.map((activity) => ({
        title: activity.title,
        estimatedCost: activity.estimatedCost,
        category: activity.category,
      })),
    })),
  });
  return {
    ...itinerary,
    days,
    accommodation: accommodation ? { ...accommodation, nights, total: accommodationTotal } : undefined,
    selectedTravelCosts,
    partyType,
    travelers,
    budgetOptimization,
    costSharing: {
      partyType,
      travelers,
      groupBudget: budgetSummary.total,
      plannedGroupSpend: plannedSpend,
      budgetShares: allocateEqualShares(budgetSummary.total, travelers, itinerary.currency),
      plannedSpendShares: allocateEqualShares(plannedSpend, travelers, itinerary.currency),
      accommodationShares: allocateEqualShares(accommodationTotal, travelers, itinerary.currency),
      reserveShares: allocateEqualShares(Math.max(0, budgetSummary.total - plannedSpend), travelers, itinerary.currency),
    },
    budgetSummary: {
      ...budgetSummary,
      accommodationActual: accommodationTotal,
      travelOptionsActual: travelOptionsTotal,
      variableBudget,
      plannedSpend,
      remainingBudget: Math.max(0, budgetSummary.total - plannedSpend),
      shortfall: Math.max(0, plannedSpend - budgetSummary.total),
    },
  };
}

export interface ItineraryResponse {
  destination: string;
  totalBudget: number;
  currency: CurrencyCode;
  source?: 'openai' | 'gemini' | 'mock' | 'catalog';
  partyType?: PartyType;
  travelers?: number;
  grounding?: PlanGrounding;
  accommodationEstimate?: PriceEvidence;
  groundingProof?: string;
  preferences?: { travelStyle?: string; accommodation: string; transportation: string; activities: string[]; interests?: string[]; pace?: 'relaxed' | 'balanced' | 'active' };
  accommodation?: AccommodationPlan;
  plannedAccommodation?: PlannedAccommodation;
  selectedTravelCosts?: SelectedTravelCosts;
  budgetOptimization?: BudgetOptimization;
  costSharing?: {
    partyType: PartyType;
    travelers: number;
    groupBudget: number;
    plannedGroupSpend: number;
    budgetShares: number[];
    plannedSpendShares: number[];
    accommodationShares: number[];
    reserveShares: number[];
  };
  days: DayPlan[];   // exactly one entry per selected travel date
  budgetSummary: {
    accommodation: number;
    food: number;
    activities: number;
    transport: number;
    reserve: number;
    dailyAverage: number;
    accommodationActual?: number;
    travelOptionsActual?: number;
    variableBudget?: number;
    plannedSpend?: number;
    remainingBudget?: number;
    shortfall?: number;
    total: number;
  };
}

// Legacy compatibility prompt for historical normalization tests; POST uses the catalog-only grounded scheduler.
export function buildSystemPrompt(tripDays: number, currency: CurrencyCode): string {
  return `You are TravelMate's expert AI travel planner. 
 Given a destination and total budget in ${currency}, produce a detailed ${tripDays}-day travel itinerary as valid JSON.

The JSON must exactly match this TypeScript interface:

interface DayActivity {
  time: string;          // "HH:MM AM/PM"
  title: string;
  description: string;
  estimatedCost: number; // ${currency} per traveler, with at most two decimals; the server converts this to a group total exactly once
  category: "accommodation" | "food" | "activity" | "transport" | "misc";
  icon: string;          // single emoji
}

interface DayPlan {
  day: number;           // 1 through ${tripDays}
  date: string;          // "YYYY-MM-DD" starting from the requested trip start date
  theme: string;         // short day theme e.g. "Arrival & City Tour"
  travelNote?: string;   // nearby-zone rule and explicit transport/check-in allowance
  returnToStayAt?: string; // realistic time to return to the selected accommodation
  totalCost: number;     // sum of activity costs for the day
  activities: DayActivity[];
  weatherAlert?: string; // optional weather tip relevant to the season
}

interface ItineraryResponse {
  destination: string;
  totalBudget: number;
  currency: "${currency}";
  days: DayPlan[];       // exactly ${tripDays}
  budgetSummary: {
    accommodation: number;
    food: number;
    activities: number;
    transport: number;
    reserve: number;
    dailyAverage: number;
    total: number;
  };
}

Rules:
- accommodation + food + activities + transport + reserve must equal totalBudget; budgetSummary.total must also equal totalBudget.
- estimatedCost is always the realistic cost for ONE traveler, never the whole group.
- Do not include accommodation as a daily activity. The selected stay is calculated separately by TravelMate.
- Spread costs realistically across all ${tripDays} days.
- Treat the requested city or municipality as a strict geographic boundary. Do not add attractions from another city merely because they are nearby.
- Name real, specific attractions, neighborhoods, markets, restaurants, or activity areas inside that boundary.
- Every activity title must describe a concrete action at a named place. Do not use generic titles such as "city experience."
- Group each day inside one compact nearby zone or around one main attraction; avoid backtracking and cross-city transfers.
- Set travelNote for every day with a realistic travel, boarding, check-in, traffic, tide, or weather allowance.
- Keep enough time between activities for travel and rest. Never create a rushed schedule merely to add more stops.
- Do not invent entrance fees, hotel rates, fares or price sources. The server supplies supported prices or clearly labeled editable planning allowances; never allocate the user budget as venue prices.
- End each non-departure day with a realistic return time to the selected accommodation.
- Include 3–5 activities per day.
- Respond with ONLY valid JSON, no markdown fences, no explanatory text.`;
}

// ─── Route Handler ─────────────────────────────────────────────────────────────

function validatedDateRange(startDate: unknown, endDate: unknown): { startDate: string; endDate: string; tripDays: number } {
  const start = typeof startDate === 'string' ? startDate : '';
  const end = typeof endDate === 'string' ? endDate : '';
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(start) || !pattern.test(end)) throw new Error('Choose valid start and end dates.');
  const startTime = new Date(`${start}T00:00:00.000Z`).getTime();
  const endTime = new Date(`${end}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) throw new Error('Choose valid start and end dates.');
  if (new Date(startTime).toISOString().slice(0, 10) !== start || new Date(endTime).toISOString().slice(0, 10) !== end) throw new Error('Choose valid start and end dates.');
  const tripDays = Math.floor((endTime - startTime) / 86_400_000) + 1;
  if (tripDays < 1 || tripDays > 31) throw new Error('Trip dates must cover between 1 and 31 days.');
  const today = new Date();
  const todayTime = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (startTime < todayTime) throw new Error('Start date cannot be in the past.');
  return { startDate: start, endDate: end, tripDays };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'idempotencyKey').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function beginGeneration(userId: string, destination: string, body: Record<string, unknown>, headerKey: string | null) {
  const suppliedKey = (headerKey || String(body.idempotencyKey || '')).trim();
  if (suppliedKey && !/^[A-Za-z0-9._:-]{8,100}$/.test(suppliedKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  const idempotencyKey = suppliedKey || randomUUID();
  const requestHash = createHash('sha256').update(stableJson(body)).digest('hex');
  const existing = await prisma.itineraryGeneration.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== requestHash) return { conflict: 'This generation key was already used for different trip details.' } as const;
    if (existing.status === 'completed' && existing.response) return { replay: existing.response } as const;
    if (existing.status === 'pending' && Date.now() - existing.updatedAt.getTime() < 10 * 60_000) return { conflict: 'This itinerary generation is already in progress.' } as const;
    const attemptId = randomUUID();
    const retried = await prisma.itineraryGeneration.updateMany({
      where: { id: existing.id, attemptId: existing.attemptId, status: existing.status },
      data: { attemptId, status: 'pending', errorCode: null, response: Prisma.DbNull },
    });
    if (retried.count !== 1) return { conflict: 'This itinerary generation is already in progress.' } as const;
    return { recordId: existing.id, attemptId } as const;
  }
  try {
    const created = await prisma.itineraryGeneration.create({ data: { userId, idempotencyKey, requestHash, destination } });
    return { recordId: created.id, attemptId: created.attemptId } as const;
  } catch (error) {
    const raced = await prisma.itineraryGeneration.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (!raced) throw error;
    if (raced.requestHash !== requestHash) return { conflict: 'This generation key was already used for different trip details.' } as const;
    if (raced.status === 'completed' && raced.response) return { replay: raced.response } as const;
    return { conflict: 'This itinerary generation is already in progress.' } as const;
  }
}

export async function completeGeneration(recordId: string, attemptId: string, response: Record<string, unknown>): Promise<boolean> {
  const completed = await prisma.itineraryGeneration.updateMany({
    where: { id: recordId, attemptId, status: 'pending' },
    data: { status: 'completed', response: response as Prisma.InputJsonValue, errorCode: null },
  });
  return completed.count === 1;
}

export async function failGeneration(recordId: string | undefined, attemptId: string | undefined, errorCode: string) {
  if (!recordId || !attemptId) return;
  const updated = await prisma.itineraryGeneration.updateMany({
    where: { id: recordId, attemptId, status: 'pending' },
    data: { status: 'failed', errorCode, response: Prisma.DbNull },
  }).catch(() => { console.warn('[TravelMate] Could not persist failed generation status.'); return undefined; });
  if (updated?.count) {
    try {
      const generation = await prisma.itineraryGeneration.findUnique({ where: { id: recordId }, select: { destination: true } });
      if (generation) {
        await notifyAdmins(prisma, 'system', 'Itinerary generation failed', 'Generation for ' + generation.destination + ' could not complete. Review System Health for details.');
        publishReportChange();
      }
    } catch { console.warn('[TravelMate] Could not notify admins about a generation failure.'); }
  }
}

export async function POST(request: Request) {
  let generationRecordId: string | undefined;
  let generationAttemptId: string | undefined;
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest(`itinerary:${user.id}`, 6, 60_000)) {
      return Response.json({ error: 'Planner limit reached. Try again in one minute.' }, { status: 429 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
    const { destination, budget, currency: requestedCurrency, travelers: requestedTravelers = 1, partyType: requestedPartyType, latitude, longitude, startDate: requestedStartDate, endDate: requestedEndDate, interests = [], preferredActivities = [], accommodationPreference, transportationPreference, accommodationListingId, externalAccommodation, plannedAccommodation: requestedPlannedAccommodation, selectedFlight, selectedActivities = [], preTripCosts: requestedPreTripCosts } = body as { destination: string; budget: number; currency?: string; travelers?: number; partyType?: PartyType; latitude?: number; longitude?: number; startDate?: string; endDate?: string; interests?: string[]; preferredActivities?: string[]; travelStyle?: string; accommodationPreference?: string; transportationPreference?: string; accommodationListingId?: string; plannedAccommodation?: unknown; externalAccommodation?: { fetchedAt?: string; total?: number; hotelId?: string; offerId?: string; name?: string; address?: string; nightlyRate?: number; currency?: string; isLive?: boolean; selectionToken?: string }; selectedFlight?: { id?: string; name?: string; price?: number; currency?: string; fetchedAt?: string; selectionToken?: string }; selectedActivities?: Array<{ id?: string; name?: string; price?: number; currency?: string; fetchedAt?: string; selectionToken?: string }>; preTripCosts?: unknown };

    if (typeof destination !== 'string' || destination.trim().length < 2 || typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1_000_000_000) {
      return Response.json(
        { error: 'destination (string) and budget (positive number) are required.' },
        { status: 400 },
      );
    }
    const normalizedDestination = destination.trim();
    if (normalizedDestination.length > 2000) return Response.json({ error: 'Destination is too long.' }, { status: 400 });
    let currency: CurrencyCode;
    try {
      currency = normalizeCurrency(requestedCurrency);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Currency is invalid.' }, { status: 400 });
    }
    if (!hasValidCurrencyPrecision(budget, currency)) {
      const precision = currencyFractionDigits(currency) === 0 ? 'whole currency units' : `no more than ${currencyFractionDigits(currency)} decimal places`;
      return Response.json({ error: `${currency} budgets must use ${precision}.` }, { status: 400 });
    }
    let range: { startDate: string; endDate: string; tripDays: number };
    try {
      range = validatedDateRange(requestedStartDate, requestedEndDate);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid trip dates.' }, { status: 400 });
    }
    const { startDate, endDate, tripDays } = range;
    const constraintsResult = generationConstraintsSchema.safeParse(body.scheduleConstraints ?? {});
    if (!constraintsResult.success || constraintsResult.data.restDates.some(date => date < startDate || date > endDate || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || dateAt(date, 0) !== date)) return Response.json({ error: 'Schedule constraints must use valid destination-local clocks and rest dates within the trip.' }, { status: 400 });
    const scheduleConstraints = constraintsResult.data;
    const startingLocation = typeof body.startingLocation === 'string' ? body.startingLocation.trim() : '';
    // Legacy style/pace fields are accepted but no longer select generation behavior.
    const pace = generationDefaults.pace;
    if ((body.startingLocation !== undefined && typeof body.startingLocation !== 'string') || (startingLocation.length > 0 && startingLocation.length < 2) || startingLocation.length > 200) return Response.json({ error: 'Starting location must be between 2 and 200 characters when provided.' }, { status: 400 });
    let anchor;
    try { anchor = await validateDestinationAnchor(normalizedDestination, body.destinationDetails, latitude, longitude); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Selected destination is invalid.' }, { status: 400 }); }
    const partyType: PartyType = requestedPartyType || (requestedTravelers === 1 ? 'solo' : requestedTravelers === 2 ? 'couple' : 'friends');
    if (!['solo', 'couple', 'family', 'friends'].includes(partyType)) return Response.json({ error: 'Select a valid party type.' }, { status: 400 });
    let travelers: number;
    try {
      travelers = travelersForParty(partyType, requestedTravelers);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid traveler count.' }, { status: 400 });
    }
    const rooms = body.rooms === undefined ? Math.ceil(travelers / 2) : Number(body.rooms);
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 20) return Response.json({ error: 'Rooms must be a whole number between 1 and 20.' }, { status: 400 });

    const listings = await readApprovedListings();
    const stay = anchor.countryCode === 'PH' ? listings.find((listing) => listing.id === accommodationListingId && listing.category === 'stay' && anchor.city.toLowerCase() === listing.municipality.toLowerCase()) : undefined;
    if (accommodationListingId && !stay) {
      return Response.json({ error: 'Select an approved accommodation in the chosen city or municipality.' }, { status: 400 });
    }
    if (stay && currency !== 'PHP') {
      return Response.json({ error: 'TravelMate marketplace stays are priced in PHP. Choose PHP or remove the selected stay.' }, { status: 400 });
    }
    const parsedPlanned = requestedPlannedAccommodation === undefined ? undefined : plannedAccommodationSchema.safeParse(requestedPlannedAccommodation);
    if (parsedPlanned && !parsedPlanned.success) return Response.json({ error: 'Enter a valid accommodation name and location, or choose it later.' }, { status: 400 });
    const plannedAccommodation = parsedPlanned?.success ? parsedPlanned.data : undefined;
    if (plannedAccommodation && (accommodationListingId || externalAccommodation)) return Response.json({ error: 'Choose one accommodation option.' }, { status: 400 });
    let validatedExternalAccommodation = externalAccommodation;
    const externalTotal = Number(externalAccommodation?.total);
    const externalRate = Number(externalAccommodation?.nightlyRate);
    const externalCurrency = typeof externalAccommodation?.currency === 'string' ? externalAccommodation.currency.toUpperCase() : '';
    const hasValidExternalAccommodation = externalAccommodation
      && typeof externalAccommodation.hotelId === 'string' && externalAccommodation.hotelId.length <= 30
      && typeof externalAccommodation.offerId === 'string' && externalAccommodation.offerId.length <= 200
      && typeof externalAccommodation.name === 'string' && externalAccommodation.name.length > 0 && externalAccommodation.name.length <= 150
      && Number.isFinite(externalRate) && externalRate > 0 && externalRate <= 10_000_000
      && Number.isFinite(externalTotal) && externalTotal > 0 && hasValidCurrencyPrecision(externalTotal, currency)
      && externalCurrency === currency && typeof externalAccommodation.fetchedAt === "string" && Number.isFinite(Date.parse(externalAccommodation.fetchedAt))
      && verifyOfferToken({ hotelId: externalAccommodation.hotelId, offerId: externalAccommodation.offerId, name: externalAccommodation.name, nightlyRate: externalRate, currency: externalCurrency, isLive: externalAccommodation.isLive === true, total: externalTotal, destination: normalizedDestination, checkInDate: startDate, checkOutDate: tripDays === 1 ? new Date(Date.parse(startDate) + 86_400_000).toISOString().slice(0,10) : endDate, adults: travelers, latitude, longitude, fetchedAt: externalAccommodation.fetchedAt, rooms, address: externalAccommodation.address }, externalAccommodation.selectionToken);
    if (externalAccommodation && !hasValidExternalAccommodation) {
      return Response.json({ error: 'The selected live accommodation offer is invalid.' }, { status: 400 });
    }
    if (hasValidExternalAccommodation) {
      try {
        const provider = await createAmadeusTravelProvider();
        if (!provider) throw new Error('Room quote provider is not configured. Choose accommodation later or refresh room prices.');
        const quote = await provider.revalidateAccommodationOffer(externalAccommodation!.offerId!, { destination: normalizedDestination, latitude: anchor.latitude, longitude: anchor.longitude, checkInDate: startDate, checkOutDate: tripDays === 1 ? new Date(Date.parse(startDate) + 86400000).toISOString().slice(0,10) : endDate, adults: travelers, nights: Math.max(1, tripDays - 1), currency, roomQuantity: rooms }, externalAccommodation!.hotelId!);
        if (quote.total !== externalTotal || quote.currency !== currency) return Response.json({ error: 'The room price changed. Refresh accommodations and review the new quote.' }, { status: 409 });
        validatedExternalAccommodation = { ...externalAccommodation, ...quote };
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Could not revalidate the room quote.' }, { status: 409 }); }
    }
    if (accommodationListingId && externalAccommodation) {
      return Response.json({ error: 'Select either a TravelMate stay or a live hotel offer.' }, { status: 400 });
    }
    let checkedProviderAccommodation;
    if (body.selectedAccommodationQuote) {
      if (stay || plannedAccommodation || externalAccommodation) return Response.json({ error: 'Choose one accommodation option.' }, { status: 400 });
      try {
        const ticket = openQuote(body.selectedAccommodationQuote, user.id);
        const quote = ticket.property.quote!;
        const checkOutDate = tripDays === 1 ? new Date(Date.parse(startDate) + 86400000).toISOString().slice(0,10) : endDate;
        if (ticket.destination !== normalizedDestination || Math.abs(ticket.latitude - anchor.latitude) > 0.0001 || Math.abs(ticket.longitude - anchor.longitude) > 0.0001 || quote.checkInDate !== startDate || quote.checkOutDate !== checkOutDate || quote.occupancy.length !== rooms || quote.occupancy.reduce((sum, room) => sum + room.adults + room.childAges.length, 0) !== travelers || quote.currency !== currency) throw new Error('The selected room quote does not match the trip dates, guests, destination or budget currency. Refresh accommodations.');
        checkedProviderAccommodation = await revalidateHotelRecommendation(ticket);
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Could not revalidate accommodation.' }, { status: 409 }); }
    }
    const accommodation: Omit<AccommodationPlan, 'nights' | 'total'> | undefined = stay
      ? { listingId: stay.id, name: stay.name, address: stay.address, nightlyRate: stay.price, currency: 'PHP' as const, source: 'travelmate' as const }
      : checkedProviderAccommodation ? { listingId: (checkedProviderAccommodation.quote!.provider === 'liteapi' ? 'liteapi:' : 'rapid:') + checkedProviderAccommodation.propertyId, offerId: checkedProviderAccommodation.quote!.offerId, name: checkedProviderAccommodation.name, address: checkedProviderAccommodation.address, nightlyRate: checkedProviderAccommodation.quote!.nightlyAverage, quotedTotal: checkedProviderAccommodation.quote!.budgetTotal ?? checkedProviderAccommodation.quote!.total, fetchedAt: checkedProviderAccommodation.quote!.checkedAt, currency, source: checkedProviderAccommodation.quote!.provider, isLive: checkedProviderAccommodation.quote!.isLive, providerQuote: checkedProviderAccommodation.quote, photos: checkedProviderAccommodation.photos.slice(0, 5), latitude: checkedProviderAccommodation.latitude, longitude: checkedProviderAccommodation.longitude }
      : hasValidExternalAccommodation
        ? { listingId: `amadeus:${externalAccommodation!.hotelId}`, offerId: externalAccommodation!.offerId!, name: externalAccommodation!.name!, address: String(externalAccommodation!.address || "Not available; confirm with the hotel").slice(0, 300), nightlyRate: externalRate, quotedTotal: externalTotal, fetchedAt: validatedExternalAccommodation!.fetchedAt, currency, source: 'amadeus' as const, isLive: externalAccommodation!.isLive === true }
        : undefined;
    const accommodationNights = accommodation ? Math.max(1, tripDays - 1) : 0;
    const accommodationTotal = accommodation ? accommodation.quotedTotal ?? accommodation.nightlyRate * accommodationNights * rooms : 0;
    const normalizeSelection = (kind: 'flight' | 'activity', selection: { id?: string; name?: string; price?: number; currency?: string; fetchedAt?: string; selectionToken?: string; isLive?: boolean }) => {
      if (kind === "activity" && selection.id?.startsWith("travelmate:") && anchor.countryCode !== "PH") return null;
      const price = Number(selection.price);
      const selectionCurrency = typeof selection.currency === 'string' ? selection.currency.toUpperCase() : '';
      const valid = typeof selection.id === 'string' && selection.id.length > 0 && selection.id.length <= 200
        && typeof selection.name === 'string' && selection.name.trim().length > 0 && selection.name.length <= 200
        && Number.isFinite(price) && price >= 0 && price <= 100_000_000 && hasValidCurrencyPrecision(price, currency)
        && selectionCurrency === currency && typeof selection.fetchedAt === 'string' && Number.isFinite(Date.parse(selection.fetchedAt))
        && verifyTravelSelectionToken({ kind, id: selection.id, name: selection.name, price, currency: selectionCurrency, fetchedAt: selection.fetchedAt, isLive: selection.isLive, destination: normalizedDestination, tripContext: kind === 'flight' ? JSON.stringify([startingLocation.trim().toLowerCase(), startDate, endDate, travelers, currency]) : JSON.stringify([latitude, longitude, currency]) }, selection.selectionToken);
      return valid ? { id: selection.id!, name: selection.name!.trim(), price, fetchedAt: selection.fetchedAt!, isLive: selection.isLive === true } : null;
    };
    const normalizedFlight = selectedFlight ? normalizeSelection('flight', selectedFlight) : null;
    if (selectedFlight && !normalizedFlight) return Response.json({ error: 'The selected flight offer is invalid or uses a different currency.' }, { status: 400 });
    if (!Array.isArray(selectedActivities) || selectedActivities.length > 10) return Response.json({ error: 'Select at most 10 activity cost commitments.' }, { status: 400 });
    const normalizedActivities = selectedActivities.map((selection) => normalizeSelection('activity', selection));
    if (normalizedActivities.some((selection) => !selection)) return Response.json({ error: 'A selected activity offer is invalid or uses a different currency.' }, { status: 400 });
    let preTripCosts: PreTripCosts | undefined;
    try {
      preTripCosts = normalizePreTripCosts(requestedPreTripCosts, currency);
      if (preTripCosts?.startingLocation && preTripCosts.startingLocation.trim().toLowerCase() !== startingLocation.toLowerCase()) return Response.json({ error: 'Pre-trip expense origin must match your starting location.' }, { status: 400 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Pre-trip costs are invalid.' }, { status: 400 });
    }
    const selectedTravelCosts: SelectedTravelCosts = {
      ...(normalizedFlight ? { flight: { id: normalizedFlight.id, name: normalizedFlight.name, total: normalizedFlight.price, currency, fetchedAt: normalizedFlight.fetchedAt, source: "amadeus", isLive: normalizedFlight.isLive } } : {}),
      activities: normalizedActivities.map((selection) => ({ id: selection!.id, name: selection!.name, unitCost: selection!.price, travelers, total: roundMoney(selection!.price * travelers,currency), currency, fetchedAt: selection!.fetchedAt, source: selection!.id.startsWith("travelmate:") ? "travelmate" : "amadeus", isLive: selection!.isLive, priceBasis: "per-person-assumption" })),
      ...(preTripCosts ? { preTrip: preTripCosts } : {}),
      total: 0,
    };
    selectedTravelCosts.total = sumMoney([selectedTravelCosts.flight?.total ?? 0,...selectedTravelCosts.activities.map(activity=>activity.total),selectedTravelCosts.preTrip?.total ?? 0],currency);
    const estimates: { foodDailyPerPerson?: number; nightlyRoomEstimate?: number; transportFare?: number; fees?: number; contingencyPercent?: number; transportFareType?: 'shared-fare' | 'per-person' } = {};
    for (const key of ['foodDailyPerPerson', 'nightlyRoomEstimate', 'transportFare', 'fees', 'contingencyPercent'] as const) {
      if (body[key] === undefined) continue;
      const amount = body[key];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > (key === 'contingencyPercent' ? 50 : 10000000) || (key !== 'contingencyPercent' && !hasValidCurrencyPrecision(amount, currency))) return Response.json({ error: `${key} is invalid or uses unsupported currency precision.` }, { status: 400 });
      estimates[key] = amount;
    }
    if (body.transportFareType !== undefined) {
      if (!['shared-fare', 'per-person'].includes(body.transportFareType)) return Response.json({ error: 'Choose a shared or per-person transport fare.' }, { status: 400 });
      estimates.transportFareType = body.transportFareType;
    }
    const explicitFareBasis = estimates.transportFareType ?? (/taxi|ride.hailing|private|rental/i.test(String(transportationPreference)) ? 'shared-fare' : 'per-person');
    const minimumEnteredCosts = accommodationTotal + selectedTravelCosts.total + (accommodation ? 0 : (estimates.nightlyRoomEstimate ?? 0) * Math.max(0, tripDays - 1) * rooms)
      + (estimates.foodDailyPerPerson ?? 0) * travelers * tripDays + (estimates.transportFare ?? 0) * tripDays * (explicitFareBasis === 'shared-fare' ? 1 : travelers) + (estimates.fees ?? 0);
    const preferenceResult = generationPreferencesSchema.safeParse({ pace,
      travelStyle: body.travelStyle,
      accommodation: typeof accommodationPreference === 'string' ? accommodationPreference.trim().toLowerCase() : accommodationPreference,
      transportation: transportationPreference, activities: preferredActivities, interests });
    if (!preferenceResult.success) return Response.json({ error: `Invalid travel preferences: ${preferenceResult.error.issues[0]?.message}. Choose a supported travel style.`, retryable: false }, { status: 400 });
    const preferences = preferenceResult.data;
    const safeInterests = preferences.interests;
    const schedulingOptions = { constraints: scheduleConstraints, interests: safeInterests, preferredActivities: preferences.activities, committedActivityNames: selectedTravelCosts.activities.map(activity => activity.name),
      travelStyle: preferences.travelStyle, transportation: preferences.transportation, currency,
      visitBudget: Math.max(0, budget / (1 + (estimates.contingencyPercent ?? 10) / 100) - minimumEnteredCosts),
      family: partyType === 'family',
      diagnostics: (event: Record<string, unknown>) => console.info(JSON.stringify({ ...event, city: anchor.city, countryCode: anchor.countryCode })) };


    let generation;
    try {
      generation = await beginGeneration(user.id, normalizedDestination, { ...body, pace, travelStyle: preferences.travelStyle, generationPolicyVersion }, request.headers.get('idempotency-key'));
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_IDEMPOTENCY_KEY') return Response.json({ error: 'Idempotency-Key must be 8-100 letters, numbers, dots, colons, underscores, or hyphens.' }, { status: 400 });
      throw error;
    }
    if ('conflict' in generation) return Response.json({ error: generation.conflict, code: 'GENERATION_CONFLICT', retryable: true }, { status: 409 });
    if ('replay' in generation) return Response.json({ ...(generation.replay as Record<string, unknown>), idempotentReplay: true });
    generationRecordId = generation.recordId;
    generationAttemptId = generation.attemptId;

    const resolvedProviders = resolveAIProviders();
    const resolvedProvider = resolvedProviders[0] || { name: 'openai' as const };

    const generationSignal = AbortSignal.timeout(540_000);
    const catalog = await loadGroundedPlaces(anchor, generationSignal, true, { tripDays });
    const permittedPlaces = permittedPlaceCandidates(catalog.places);
    console.info(JSON.stringify({ event: 'generation_place_scope', city: anchor.city, destinationId: anchor.id, latitude: anchor.latitude, longitude: anchor.longitude, countryCode: anchor.countryCode, scope: anchor.scopeType ?? 'locality', available: catalog.places.length, inScope: permittedPlaces.length, nearbyExcluded: catalog.places.length - permittedPlaces.length }));
    let trustedTimeZone: string | undefined;
    const buildPlan = (schedule: GroundedScheduleDay[], source: 'openai' | 'gemini' | 'mock' | 'catalog', generationWarning?: string) => buildGroundedPlan({
      destination: normalizedDestination, anchor, startingLocation, startDate, endDate, budget, currency, travelers, partyType, rooms,
      places: permittedPlaces, placeDataStatus: catalog.status, schedule, source, preferences, transportation: preferences.transportation, pace, familyBuffer: partyType === 'family', timeZone: trustedTimeZone, scheduleConstraints,
      accommodation: accommodation ? { ...accommodation, rooms, quotedTotal: accommodationTotal, nights: accommodationNights, total: accommodationTotal } : undefined,
      selectedTravelCosts, ...estimates,
      generationWarning,
    });

    // Keep provider retries and repairs within the browser request window.
    const weatherCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
      && Number(latitude) >= -90 && Number(latitude) <= 90 && Number(longitude) >= -180 && Number(longitude) <= 180
      ? { latitude: Number(latitude), longitude: Number(longitude) } : undefined;
    let trustedWeatherContext: Array<{ date: string; description: string; precipitationProbability: number; tempMax: number }> = [];
    let weatherProvenance = 'provider-backed';
    try {
      const weatherKey = weatherCoordinates ? `${weatherCoordinates.latitude.toFixed(4)}:${weatherCoordinates.longitude.toFixed(4)}` : normalizedDestination.toLowerCase();
      const weatherResult = await withProviderCache(weatherKey, PROVIDER_CACHE_POLICIES.weather, async () => {
        const resolved = await resolveWeather({ city: normalizedDestination, coordinates: weatherCoordinates }, configuredWeatherProviders());
        if (resolved.source === 'unavailable') throw new Error('Weather providers are unavailable.');
        return resolved;
      });
      const tripWeather = weatherForTripDates(weatherResult.value, startDate, endDate);
      if (tripWeather.timeZone) {
        try { trustedTimeZone = new Intl.DateTimeFormat('en', { timeZone: tripWeather.timeZone }).resolvedOptions().timeZone; } catch { /* Do not invent an IANA zone when the provider reference is invalid. */ }
      }
      trustedWeatherContext = tripWeather.forecast.map((day) => ({ date: day.date, description: day.description, precipitationProbability: day.precipitationProbability, tempMax: day.tempMax }));
      weatherProvenance = weatherResult.freshness.status === 'live' ? 'provider-fetched' : weatherResult.freshness.status === 'fresh-cache' ? 'fresh cached provider' : 'stale cached provider';
    } catch (error) {
      console.warn('[TravelMate] Weather context unavailable for AI generation:', error instanceof Error ? error.message : error);
    }
    const safeWeather = trustedWeatherContext.slice(0, tripDays).flatMap((item) => {
      const date = typeof item?.date === 'string' ? item.date : '';
      const description = typeof item?.description === 'string' ? item.description.trim().slice(0, 60) : '';
      const rain = Number(item?.precipitationProbability);
      const tempMax = Number(item?.tempMax);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && description && Number.isFinite(rain) && Number.isFinite(tempMax) ? [`${date}: ${description}, ${Math.max(0, Math.min(100, Math.round(rain)))}% rain, high ${Math.round(tempMax)}°C`] : [];
    });
    const weatherSummary = safeWeather.length ? `Date-matched ${weatherProvenance} forecast: ${safeWeather.join('; ')}. Prefer indoor alternatives during heavy rain and cooler hours during extreme heat.` : '';
    const crowdSummary = `Low-confidence calendar crowd estimates (not live): ${estimateCrowdRange(startDate, endDate, normalizedDestination).map((condition) => `${condition.date} ${condition.crowdLevel}`).join('; ')}.`;
    const prompt = `${startingLocation ? `Starting location: ${startingLocation}. ` : ''}Dates: ${startDate}–${endDate}. Currency: ${currency}. Total group budget: ${budget}; committed stay/travel: ${accommodationTotal + selectedTravelCosts.total}. ${JSON.stringify(preferences)}. ${preferenceInstructions(preferences)} Explicit selected hotel: ${plannedAccommodation?.name || accommodation?.name || "none; optional"}; preserve it even if a preference conflicts. Interests: ${safeInterests.join(', ')}. ${weatherSummary} ${crowdSummary}. Prices are supplied or explicitly unavailable; do not invent them. Confirm opening hours before travel.`;

    let itinerary: ItineraryResponse | undefined;
    let lastGenerationError: unknown;
    for (const candidate of resolvedProviders) {
      if (!candidate.provider || !permittedPlaces.length) continue;
      try {
        const schedule = await generateGroundedSchedule(candidate.provider!, anchor, permittedPlaces, startDate, tripDays, travelers, prompt, generationSignal, pace, { ...schedulingOptions, weather: trustedWeatherContext, providerUnavailable: catalog.status === 'unavailable', providerPartial: catalog.coverage.outcome === 'partial' });
        itinerary = buildPlan(schedule, candidate.name);
        break;
      } catch (error) {
        lastGenerationError = error;
        console.error(`[TravelMate] ${candidate.name} generation failed after validation/repair.`, error instanceof Error ? error.message : error);
        if (generationSignal.aborted) break;
      }
    }
    if (!itinerary) {
      console.warn('[TravelMate] AI scheduling unavailable; returning only catalog-backed recommendations.', lastGenerationError instanceof Error ? lastGenerationError.message : 'No usable provider response.');
      itinerary = buildPlan(completeGroundedSchedule(anchor, permittedPlaces, [], startDate, tripDays, travelers, pace, { ...schedulingOptions, weather: trustedWeatherContext, providerUnavailable: catalog.status === 'unavailable', providerPartial: catalog.coverage.outcome === 'partial' }), !resolvedProvider.provider && mockItinerariesEnabled() ? 'mock' : 'catalog', 'AI scheduling was unavailable. Recommendations use only verified destination records, interest matching and estimated local schedules. Missing place coverage remains explicitly incomplete; no attractions or provider prices were invented.');
    }

    const completed = { ...itinerary, days: itinerary.days.map(day => {
      const forecast = trustedWeatherContext.find(entry => entry.date === day.date);
      const crowd = estimateCrowd(day.date, normalizedDestination);
      return { ...day, weatherAlert: forecast ? forecastAlert(forecast.description, forecast.precipitationProbability, forecast.tempMax) : undefined,
        crowdLevel: crowd.crowdLevel, crowdSource: crowd.crowdSource, crowdConfidence: crowd.crowdConfidence, crowdNote: crowd.crowdNote, crowdRecommendation: crowd.crowdRecommendation, crowdFetchedAt: crowd.fetchedAt, crowdRefreshAfter: crowd.refreshAfter };
    }) };
    // Return selected attraction photos with the generated plan, under a separate
    // bounded deadline. The plan remains usable when photo providers are offline.
    // Catalog photos are already provider-verified. Save a usable plan immediately;
    // optional missing-photo enrichment runs in the existing display/saved flow.
    const withPhotos = retainSelectedActivityPhotos(completed);
    const response = parseSavedItinerary({ ...withPhotos, groundingProof: signGroundedPlan(withPhotos), preferences, ...(plannedAccommodation ? { plannedAccommodation } : {}) }, { days: tripDays, currency, budget, travelers, partyType, startDate, destination: normalizedDestination }) as unknown as Record<string, unknown>;
    if (!await completeGeneration(generationRecordId, generationAttemptId, response)) return Response.json({ error: 'Another request is handling this itinerary. Please try again.', code: 'GENERATION_CONFLICT', retryable: true }, { status: 409 });
    return Response.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (isDatabaseConnectionError(error)) throw error;
    console.error('[TravelMate] /api/itinerary unexpected error:', error);
    await failGeneration(generationRecordId, generationAttemptId, 'INTERNAL_ERROR');
    return Response.json(
      { error: 'Internal server error. Please try again.' },
      { status: 500 },
    );
  }
}

function refreshableDay(value: unknown): value is DayPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const day = value as Partial<DayPlan>;
  return Number.isInteger(day.day) && Number(day.day) >= 1 && Number(day.day) <= 31
    && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
    && typeof day.theme === 'string' && day.theme.trim().length > 0 && day.theme.length <= 120
    && typeof day.imageUrl === 'string' && day.imageUrl.length <= 2_000
    && Number.isFinite(day.totalCost)
    && Array.isArray(day.activities) && day.activities.length <= 8
    && day.activities.every((activity) => activity && typeof activity === 'object'
      && typeof activity.title === 'string' && activity.title.trim().length > 0 && activity.title.length <= 160);
}

export async function POST_IMAGES(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest(`itinerary-images:${user.id}`, 20, 60_000)) {
      return Response.json({ error: 'Photo refresh limit reached. Try again in one minute.' }, { status: 429 });
    }
    const body = await request.json().catch(() => null) as { destination?: unknown; day?: unknown; itinerary?: ItineraryResponse; lookupOnly?: boolean; googleFailedIndices?: number[]; failedPhotos?: import('../services/itinerary/activity-photo-fallback.ts').FailedActivityPhoto[] } | null;
    const destination = typeof body?.destination === 'string' ? body.destination.trim() : '';
    if (destination.length < 2 || destination.length > 2000 || !refreshableDay(body?.day)) {
      return Response.json({ error: 'A valid destination and itinerary day are required.' }, { status: 400 });
    }
    const failures = body.failedPhotos || [];
    if (!Array.isArray(failures) || failures.length > 8 || failures.some(photo => !Number.isInteger(photo?.index) || photo.index < 0 || photo.index > 7 || typeof photo.imageUrl !== 'string' || photo.imageUrl.length > 1000)) return Response.json({ error: 'Invalid failed photo identities.' }, { status: 400 });
    const googleFailedIndices = body.googleFailedIndices || [];
    if (!Array.isArray(googleFailedIndices) || googleFailedIndices.length > 8 || googleFailedIndices.some(index => !Number.isInteger(index) || index < 0 || index > 7)) return Response.json({ error: 'Invalid Google photo failures.' }, { status: 400 });
    // Read-only display enrichment does not authorize or sign itinerary/budget edits.
    // It works for legacy saved plans and manual drafts without regeneration.
    if (body.lookupOnly === true) {
      return Response.json(await fillDayDisplayPhotos(destination, body.day, AbortSignal.timeout(45000), `preview:${user.id}`, failures, undefined, undefined, googleFailedIndices), { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const plan = body?.itinerary;
    if (!plan?.grounding) {
      return Response.json(await fillDayDisplayPhotos(destination, body.day, AbortSignal.timeout(45000), `preview:${user.id}`, failures, undefined, undefined, googleFailedIndices), { headers: { 'Cache-Control': 'private, no-store' } });
    }
    try {
      parseSavedItinerary(plan, { days: plan.days.length, currency: plan.currency, budget: plan.totalBudget, travelers: plan.travelers!, partyType: plan.partyType!, destination });
    } catch { return Response.json({ error: 'Save your manual changes before refreshing place-linked photos.' }, { status: 400 }); }
    if (!verifyGroundedPlan(plan) || plan.destination !== destination) return Response.json({ error: 'Save your manual changes before refreshing place-linked photos.' }, { status: 400 });
    const requestedDayNumber = body.day.day;
    const original = plan.days.find(day => day.day === requestedDayNumber);
    if (!original) return Response.json({ error: 'Itinerary day was not found.' }, { status: 400 });
    // Reuse the saved place identity; refreshing images never reruns the catalog
    // or changes activities. Valid stored images short-circuit all provider work.
    const { day, googlePhotos } = await fillDayDisplayPhotos(destination, original, AbortSignal.timeout(45000), `preview:${user.id}`, failures, undefined, undefined, googleFailedIndices);
    const updated = { ...plan, days: plan.days.map(entry => entry.day === day.day ? day : entry) };
    return Response.json({ day, googlePhotos, groundingProof: signGroundedPlan(updated) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    if (isDatabaseConnectionError(error)) throw error;
    console.error('[TravelMate] /api/itinerary/images unexpected error:', error);
    return Response.json({ error: 'Activity photos could not be refreshed right now.' }, { status: 502 });
  }
}
