// app/api/itinerary/route.ts
// ─── Server-only Route Handler ────────────────────────────────────────────────
// Keeps AI provider keys strictly on the server; never bundled to the client.

import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import {
  allocateEqualShares,
  splitBudget,
  travelersForParty,
  type PartyType,
} from '../schemas/domain.ts';
import { readDb } from '../repositories/platform-repository.ts';
import { verifyOfferToken } from '../utils/offer-token.ts';
import { generateValidatedItinerary } from '../services/ai/itinerary-generator.ts';
import { resolveAIProvider } from '../services/ai/provider.ts';
import {
  buildBudgetOptimization,
  type BudgetOptimization,
} from '../services/budget/budget-optimization-service.ts';
import { estimateCrowd } from '../services/crowd/crowd-service.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DayActivity {
  time: string;       // e.g. "09:00 AM"
  title: string;
  description: string;
  estimatedCost: number;
  unitCost?: number;
  category: 'accommodation' | 'food' | 'activity' | 'transport' | 'misc';
  icon: string;       // emoji shorthand
  imageUrl?: string;
  imageAttribution?: ImageAttribution;
}

export interface ImageAttribution {
  creator: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
}

export interface DayPlan {
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
}

export interface AccommodationPlan {
  listingId: string;
  name: string;
  address: string;
  nightlyRate: number;
  nights: number;
  total: number;
  source?: 'travelmate' | 'amadeus';
  offerId?: string;
  isLive?: boolean;
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

function activityImage(title: string, fallback: string): string {
  const value = title.toLowerCase();
  if (/10,000|rose garden/.test(value)) return '/cordova-10000-roses.png';
  if (/cclex|coastal road|local ride|transfer|ride to|ride from/.test(value)) return '/cordova-cclex.png';
  if (/gilutongan|guided snorkeling|reef viewing/.test(value)) return '/cordova-gilutongan.png';
  if (/nalusuan|pier walk|shallow-water/.test(value)) return '/cordova-nalusuan.png';
  if (/breakfast|lunch|dinner|coffee|food|market|delicacy|snack/.test(value)) return '/cordova-seafood.png';
  if (/day-as|coastal walk/.test(value)) return '/cordova-10000-roses.png';
  if (/mangrove|birdwatching|fishing community/.test(value)) return '/cordova-mangrove.png';
  if (/resort|pool|beach leisure|kayak|quiet rest/.test(value)) return '/cordova-resort.png';
  return fallback;
}

type CommonsImage = { imageUrl: string; attribution: ImageAttribution };

function plainText(value: string | undefined): string {
  return (value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
}

async function searchCommonsImages(query: string, limit: number): Promise<CommonsImage[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(Math.min(10, Math.max(1, limit))),
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1200',
    iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl', iiextmetadatalanguage: 'en',
  });
  try {
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': 'TravelMate/1.0 location-photo-search', 'Api-User-Agent': 'TravelMate/1.0 location-photo-search' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { query?: { pages?: Record<string, { pageid: number; index?: number; imageinfo?: Array<{ thumburl?: string; url?: string; extmetadata?: Record<string, { value?: string }> }> }> } };
    return Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).flatMap((page): CommonsImage[] => {
      const info = page.imageinfo?.[0];
      const imageUrl = info?.thumburl || info?.url;
      if (!info || !(imageUrl?.startsWith('https://upload.wikimedia.org/') || imageUrl?.startsWith('https://thumb.wikimedia.org/'))) return [];
      const metadata = info.extmetadata || {};
      return [{
        imageUrl,
        attribution: {
          creator: plainText(metadata.Artist?.value) || plainText(metadata.Credit?.value) || 'Wikimedia Commons contributor',
          license: plainText(metadata.LicenseShortName?.value) || 'See source for license',
          licenseUrl: metadata.LicenseUrl?.value,
          sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}`,
        },
      }];
    });
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

async function attachPlaceImages(itinerary: ItineraryResponse): Promise<ItineraryResponse> {
  const found = await mapWithConcurrency(itinerary.days, 3, async (day) => {
    const specific = await searchCommonsImages(`${day.theme} ${itinerary.destination}`, day.activities.length + 1);
    return specific.length ? specific : searchCommonsImages(itinerary.destination, day.activities.length + 1);
  });
  return {
    ...itinerary,
    days: itinerary.days.map((day, dayIndex) => {
      const dayImages = found[dayIndex] || [];
      const dayImage = dayImages[0];
      return {
        ...day,
        imageUrl: dayImage?.imageUrl || day.imageUrl,
        imageAttribution: dayImage?.attribution || day.imageAttribution,
        activities: day.activities.map((item, activityIndex) => {
          const activityPhoto = dayImages[activityIndex + 1] || dayImage;
          return { ...item, imageUrl: activityPhoto?.imageUrl || item.imageUrl || day.imageUrl, imageAttribution: activityPhoto?.attribution || item.imageAttribution || dayImage?.attribution };
        }),
      };
    }),
  };
}

async function finalizeItinerary(itinerary: ItineraryResponse, budgetSummary: ReturnType<typeof splitBudget>, partyType: PartyType, travelers: number, tripDays: number, startDate: string, accommodation?: Omit<AccommodationPlan, 'nights' | 'total'>): Promise<ItineraryResponse> {
  return attachPlaceImages(normalizeItinerary(itinerary, budgetSummary, partyType, travelers, tripDays, startDate, accommodation));
}

function normalizeItinerary(itinerary: ItineraryResponse, budgetSummary: ReturnType<typeof splitBudget>, partyType: PartyType, travelers: number, tripDays: number, startDate: string, accommodation?: Omit<AccommodationPlan, 'nights' | 'total'>): ItineraryResponse {
  const nights = accommodation ? Math.max(1, tripDays - 1) : 0;
  const accommodationTotal = accommodation ? accommodation.nightlyRate * nights : 0;
  const variableBudget = Math.max(0, budgetSummary.total - accommodationTotal - budgetSummary.reserve);
  const estimatedUnitCosts = itinerary.days.slice(0, tripDays).flatMap((day) => day.activities.map((activity) => Math.max(0, Math.round(Number.isFinite(activity.estimatedCost) ? activity.estimatedCost : 0))));
  let costIndex = 0;
  const days = itinerary.days.slice(0, tripDays).map((day, index) => {
    const fallbackImage = day.imageUrl || DAY_IMAGES[index % DAY_IMAGES.length];
    const activities = day.activities.map((activity) => {
      const unitCost = estimatedUnitCosts[costIndex++] ?? 0;
      return { ...activity, imageUrl: activity.imageUrl || activityImage(activity.title, fallbackImage), unitCost, estimatedCost: unitCost * travelers };
    });
    const activityTotal = activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    const rideFare = activities.filter((activity) => activity.category === 'transport').reduce((sum, activity) => sum + activity.estimatedCost, 0);
    const nightlyCost = accommodation && index < nights ? accommodation.nightlyRate : 0;
    return {
      ...day,
      day: index + 1,
      date: new Date(`${startDate}T00:00:00.000Z`).toISOString().slice(0, 10),
      imageUrl: day.imageUrl || DAY_IMAGES[index % DAY_IMAGES.length],
      returnToStayAt: accommodation ? day.returnToStayAt || '08:00 PM' : undefined,
      rideFare,
      totalCost: activityTotal + nightlyCost,
      activities,
    };
  }).map((day, index) => {
    const date = new Date(`${startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const dateText = date.toISOString().slice(0, 10);
    return { ...day, date: dateText, ...estimateCrowd(dateText, itinerary.destination) };
  });
  const plannedSpend = days.reduce((sum, day) => sum + day.totalCost, 0);
  const budgetOptimization = buildBudgetOptimization({
    budget: budgetSummary.total,
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
    accommodation: accommodation ? { ...accommodation, nights, total: accommodation.nightlyRate * nights } : undefined,
    partyType,
    travelers,
    budgetOptimization,
    costSharing: {
      partyType,
      travelers,
      groupBudget: budgetSummary.total,
      plannedGroupSpend: plannedSpend,
      budgetShares: allocateEqualShares(budgetSummary.total, travelers),
      plannedSpendShares: allocateEqualShares(plannedSpend, travelers),
      accommodationShares: allocateEqualShares(accommodationTotal, travelers),
      reserveShares: allocateEqualShares(Math.max(0, budgetSummary.total - plannedSpend), travelers),
    },
    budgetSummary: {
      ...budgetSummary,
      accommodationActual: accommodationTotal,
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
  currency: string;
  source?: 'openai' | 'gemini' | 'mock';
  partyType?: PartyType;
  travelers?: number;
  preferences?: { travelStyle: string; accommodation: string; transportation: string; activities: string[] };
  accommodation?: AccommodationPlan;
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
    variableBudget?: number;
    plannedSpend?: number;
    remainingBudget?: number;
    shortfall?: number;
    total: number;
  };
}

// ─── Fallback Mock Data ────────────────────────────────────────────────────────

type DayTemplate = Pick<DayPlan, 'theme' | 'imageUrl' | 'travelNote' | 'activities'>;

const activity = (time: string, title: string, description: string, estimatedCost: number, category: DayActivity['category']): DayActivity => ({
  time, title, description, estimatedCost, category, icon: category,
});

const CORDOVA_DAY_TEMPLATES: DayTemplate[] = [
  {
    theme: '10,000 Roses Cafe & Sunset', imageUrl: '/cordova-10000-roses.png', travelNote: 'Day-as area only - includes a 45-minute local travel allowance.', activities: [
      activity('03:30 PM', 'Transfer to Day-as', 'Take local transport to the Cordova Tourism Center area.', 180, 'transport'),
      activity('04:15 PM', 'Cordova coastal walk', 'Walk the waterfront and take photos before sunset.', 80, 'activity'),
      activity('05:00 PM', 'Coffee at 10,000 Roses Cafe', 'Order coffee or a cold drink while waiting for blue hour.', 260, 'food'),
      activity('06:00 PM', 'LED rose garden viewing', 'See the rose field light up after sunset.', 120, 'activity'),
      activity('07:15 PM', 'Seaside dinner in Day-as', 'Finish with a local seafood or Filipino dinner nearby.', 420, 'food'),
    ],
  },
  {
    theme: 'CCLEX Viewpoint & Coastal Cordova', imageUrl: '/cordova-cclex.png', travelNote: 'Nearby town-and-coast route - includes 30 minutes between stops.', activities: [
      activity('07:30 AM', 'Breakfast in Cordova town', 'Start with a local breakfast before the coastal route.', 180, 'food'),
      activity('09:00 AM', 'Ride to CCLEX coastal viewpoint', 'Estimated round-trip local fare to a safe public shoreline viewpoint.', 180, 'transport'),
      activity('10:30 AM', 'Coastal road sightseeing', 'Explore the Cordova coast and fishing communities.', 220, 'activity'),
      activity('12:30 PM', 'Local lunch', 'Eat at a local restaurant within Cordova.', 350, 'food'),
      activity('03:00 PM', 'Town center and pasalubong stop', 'Browse local snacks and small shops before returning.', 300, 'misc'),
    ],
  },
  {
    theme: 'Gilutongan Marine Sanctuary', imageUrl: '/cordova-gilutongan.png', travelNote: 'Single-island route - includes 60 minutes for boat check-in and weather.', activities: [
      activity('06:30 AM', 'Breakfast and pier transfer', 'Eat early and travel to the assigned Cordova boat meeting point.', 300, 'transport'),
      activity('08:00 AM', 'Bangka ride to Gilutongan', 'Ride an accredited local boat to the island sanctuary.', 900, 'transport'),
      activity('09:00 AM', 'Guided snorkeling', 'Snorkel with a guide and follow marine sanctuary rules.', 1000, 'activity'),
      activity('12:00 PM', 'Packed island lunch', 'Have a prepared Filipino lunch and hydrate.', 400, 'food'),
      activity('02:00 PM', 'Reef viewing and return', 'Take a final shallow-water viewing session before returning.', 500, 'activity'),
    ],
  },
  {
    theme: 'Cordova Seafood & Local Flavors', imageUrl: '/cordova-seafood.png', travelNote: 'Market and nearby coast only - no cross-city transfer.', activities: [
      activity('07:30 AM', 'Local ride to Cordova market', 'Estimated local fare from the selected stay to the market area.', 120, 'transport'),
      activity('08:00 AM', 'Local market breakfast', 'Try puto, sikwate, or another available Cebuano breakfast.', 180, 'food'),
      activity('09:30 AM', 'Cordova market visit', 'Browse local produce and seafood sold for the day.', 100, 'activity'),
      activity('12:00 PM', 'Seaside seafood lunch', 'Choose grilled fish or shellfish at a coastal restaurant.', 650, 'food'),
      activity('02:30 PM', 'Local delicacy tasting', 'Sample available Cebuano snacks or desserts.', 250, 'food'),
      activity('05:00 PM', 'Coastal sunset snack', 'End the food trail with a light snack by the coast.', 220, 'food'),
    ],
  },
  {
    theme: 'Nalusuan Island Day', imageUrl: '/cordova-nalusuan.png', travelNote: 'Single-island route - includes 60 minutes for boarding, tides, and return.', activities: [
      activity('06:30 AM', 'Breakfast and boat check-in', 'Prepare at the designated Cordova departure point.', 350, 'food'),
      activity('08:00 AM', 'Boat ride to Nalusuan', 'Travel with an accredited island-hopping operator.', 1000, 'transport'),
      activity('09:30 AM', 'Nalusuan pier walk', 'Walk the island pier and enjoy the clear-water views.', 450, 'activity'),
      activity('10:30 AM', 'Snorkeling or shallow-water swim', 'Choose a guided water activity suited to the weather.', 950, 'activity'),
      activity('12:30 PM', 'Island lunch and return', 'Eat lunch, rest, then return to mainland Cordova.', 650, 'food'),
    ],
  },
  {
    theme: 'Cordova Mangrove & Birdwatching', imageUrl: '/cordova-mangrove.png', travelNote: 'One coastal zone - includes a 45-minute tide and weather allowance.', activities: [
      activity('05:30 AM', 'Ride to the coastal meeting point', 'Estimated early local fare from the selected stay.', 150, 'transport'),
      activity('06:00 AM', 'Early coastal birdwatching', 'Observe shorebirds quietly where public access is permitted.', 350, 'activity'),
      activity('08:00 AM', 'Mangrove nature walk', 'Explore an accessible habitat without disturbing wildlife.', 400, 'activity'),
      activity('10:00 AM', 'Cebuano breakfast', 'Return to town for breakfast and coffee.', 220, 'food'),
      activity('01:00 PM', 'Fishing community visit', 'Learn about Cordova coastal livelihoods with a local host.', 450, 'activity'),
      activity('04:00 PM', 'Free coastal rest time', 'Keep the late afternoon flexible for weather and tides.', 180, 'misc'),
    ],
  },
  {
    theme: 'Cordova Resort & Farewell', imageUrl: '/cordova-resort.png', travelNote: 'One resort for the whole day - no extra transfers after check-in.', activities: [
      activity('07:15 AM', 'Ride to the selected resort', 'Estimated local fare from the accommodation to the resort.', 180, 'transport'),
      activity('08:00 AM', 'Resort day-pass check-in', 'Use a pre-booked day pass at an available Cordova resort.', 900, 'activity'),
      activity('09:00 AM', 'Pool and beach leisure', 'Swim, rest, or use included resort facilities.', 450, 'activity'),
      activity('12:00 PM', 'Resort lunch', 'Have lunch without leaving Cordova.', 600, 'food'),
      activity('02:00 PM', 'Kayak or quiet rest', 'Choose an available light activity based on weather.', 500, 'activity'),
      activity('05:00 PM', 'Farewell coffee and sunset', 'Close the trip with coffee and a final coastal sunset.', 300, 'food'),
    ],
  },
];

const CORDOVA_RETURN_TIMES = ['08:30 PM', '06:30 PM', '05:30 PM', '06:30 PM', '05:30 PM', '05:30 PM', '04:30 PM'] as const;

function buildMockItinerary(destination: string, budget: number, requestedStartDate: string, tripDays: number): ItineraryResponse {
  const startDate = requestedStartDate ? new Date(`${requestedStartDate}T00:00:00`) : new Date();
  const perDay = Math.round(budget / tripDays);

  if (/\bcordova\b/i.test(destination)) {
    const days = Array.from({ length: tripDays }, (_, index): DayPlan => {
      const template = CORDOVA_DAY_TEMPLATES[index % CORDOVA_DAY_TEMPLATES.length];
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + index);
      return {
        day: index + 1,
        date: date.toISOString().split('T')[0],
        theme: template.theme,
        imageUrl: template.imageUrl,
        travelNote: template.travelNote,
        returnToStayAt: CORDOVA_RETURN_TIMES[index % CORDOVA_RETURN_TIMES.length],
        totalCost: perDay,
        activities: template.activities,
      };
    });
    return {
      destination,
      totalBudget: budget,
      currency: 'PHP',
      source: 'mock',
      days,
      budgetSummary: {
        accommodation: Math.round(budget * 0.35),
        food: Math.round(budget * 0.25),
        activities: Math.round(budget * 0.2),
        transport: Math.round(budget * 0.12),
        reserve: Math.round(budget * 0.09),
        dailyAverage: Math.round(budget / tripDays),
        total: budget,
      },
    };
  }

  const themes = [
    'Arrival & City Orientation',
    'Culture & Heritage',
    'Nature & Outdoors',
    'Food & Local Markets',
    'Day Trip & Excursion',
    'Leisure & Shopping',
    'Farewell & Departure',
  ];

  const days: DayPlan[] = Array.from({ length: tripDays }, (_, i) => {
    const theme = themes[i % themes.length];
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    return {
      day: i + 1,
      date: date.toISOString().split('T')[0],
      theme,
      imageUrl: DAY_IMAGES[i % DAY_IMAGES.length],
      totalCost: perDay,
      activities: [
        {
          time: '08:00 AM',
          title: 'Breakfast at local café',
          description: `Start day ${i + 1} with a hearty local breakfast in ${destination}.`,
          estimatedCost: Math.round(perDay * 0.1),
          category: 'food',
          icon: '☕',
        },
        {
          time: '10:00 AM',
          title: `${theme} experience`,
          description: `Explore the highlights of ${destination} focused on today's theme: ${theme}.`,
          estimatedCost: Math.round(perDay * 0.45),
          category: 'activity',
          icon: '🗺️',
        },
        {
          time: '01:00 PM',
          title: 'Lunch',
          description: 'Enjoy local cuisine at a recommended restaurant.',
          estimatedCost: Math.round(perDay * 0.15),
          category: 'food',
          icon: '🍽️',
        },
        {
          time: '07:00 PM',
          title: 'Dinner & Evening',
          description: 'Wind down with dinner and optional evening activity.',
          estimatedCost: Math.round(perDay * 0.3),
          category: 'food',
          icon: '🌆',
        },
      ],
    };
  });

  return {
    destination,
    totalBudget: budget,
    currency: 'PHP',
    source: 'mock',
    days,
    budgetSummary: {
      accommodation: Math.round(budget * 0.35),
      food: Math.round(budget * 0.25),
      activities: Math.round(budget * 0.2),
      transport: Math.round(budget * 0.12),
      reserve: Math.round(budget * 0.09),
      dailyAverage: Math.round(budget / tripDays),
      total: budget,
    },
  };
}

// ─── OpenAI System Prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(tripDays: number): string {
  return `You are TravelMate's expert AI travel planner. 
 Given a destination and total budget (in Philippine pesos), produce a detailed ${tripDays}-day travel itinerary as valid JSON.

The JSON must exactly match this TypeScript interface:

interface DayActivity {
  time: string;          // "HH:MM AM/PM"
  title: string;
  description: string;
  estimatedCost: number; // PHP integer per traveler; the server converts this to a group total exactly once
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
  currency: "PHP";
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
- Use realistic PHP price estimates for each item. Never inflate activity prices merely to consume the full entered budget.
- End each non-departure day with a realistic return time to the selected accommodation.
- Include 3–5 activities per day.
- Respond with ONLY valid JSON, no markdown fences, no explanatory text.`;
}

// ─── Route Handler ─────────────────────────────────────────────────────────────

function travelerPrompt(destination: string, budget: number, partyType: PartyType, travelers: number, startDate: string, endDate: string, interests: string[], accommodationTotal: number, variableBudget: number, tripDays: number, preferences: { travelStyle: string; accommodation: string; transportation: string; activities: string[] }, weatherSummary: string): string {
  const budgetGuidance = variableBudget > 0
    ? `Aim to keep the combined per-traveler food, activity, transport, and miscellaneous estimates within PHP ${Math.floor(variableBudget / travelers)} per traveler without replacing realistic prices with zero.`
    : 'The accommodation already uses the available budget. Still provide a realistic non-zero price for every paid item; TravelMate will clearly report the resulting budget shortfall.';
  return `Plan a ${tripDays}-day trip to ${destination} from ${startDate} through ${endDate} for a ${partyType} party of ${travelers} traveler(s). Interests: ${interests.join(', ') || 'general sightseeing'}. Travel style: ${preferences.travelStyle}. Accommodation preference: ${preferences.accommodation}. Transportation preference: ${preferences.transportation}. Preferred activities: ${preferences.activities.join(', ') || 'any suitable activities'}. ${weatherSummary || 'No date-matched forecast is available; do not invent weather conditions.'} PHP ${budget} is the TOTAL GROUP BUDGET. The selected accommodation costs PHP ${accommodationTotal} for the whole group and is handled separately. ${budgetGuidance} TravelMate will multiply each estimatedCost by ${travelers} exactly once.`;
}

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
  if (tripDays < 1 || tripDays > 14) throw new Error('Trip dates must cover between 1 and 14 days.');
  const today = new Date();
  const todayTime = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (startTime < todayTime) throw new Error('Start date cannot be in the past.');
  return { startDate: start, endDate: end, tripDays };
}

function preference(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return text || fallback;
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    if (!allowRequest(`itinerary:${user.id}`, 6, 60_000)) {
      return Response.json({ error: 'Planner limit reached. Try again in one minute.' }, { status: 429 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
    const { destination, budget, travelers: requestedTravelers = 1, partyType: requestedPartyType, startDate: requestedStartDate, endDate: requestedEndDate, interests = [], preferredActivities = [], travelStyle, accommodationPreference, transportationPreference, weatherContext = [], accommodationListingId, externalAccommodation } = body as { destination: string; budget: number; travelers?: number; partyType?: PartyType; startDate?: string; endDate?: string; interests?: string[]; preferredActivities?: string[]; travelStyle?: string; accommodationPreference?: string; transportationPreference?: string; weatherContext?: Array<{ date?: unknown; description?: unknown; precipitationProbability?: unknown; tempMax?: unknown }>; accommodationListingId?: string; externalAccommodation?: { hotelId?: string; offerId?: string; name?: string; address?: string; nightlyRate?: number; isLive?: boolean; selectionToken?: string } };

    if (typeof destination !== 'string' || destination.trim().length < 2 || typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1_000_000_000) {
      return Response.json(
        { error: 'destination (string) and budget (positive number) are required.' },
        { status: 400 },
      );
    }
    const normalizedDestination = destination.trim();
    if (normalizedDestination.length > 120) return Response.json({ error: 'Destination is too long.' }, { status: 400 });
    let range: { startDate: string; endDate: string; tripDays: number };
    try {
      range = validatedDateRange(requestedStartDate, requestedEndDate);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid trip dates.' }, { status: 400 });
    }
    const { startDate, endDate, tripDays } = range;
    const partyType: PartyType = requestedPartyType || (requestedTravelers === 1 ? 'solo' : requestedTravelers === 2 ? 'couple' : 'friends');
    if (!['solo', 'couple', 'family', 'friends'].includes(partyType)) return Response.json({ error: 'Select a valid party type.' }, { status: 400 });
    let travelers: number;
    try {
      travelers = travelersForParty(partyType, requestedTravelers);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid traveler count.' }, { status: 400 });
    }
    const computedBudget = splitBudget(budget, travelers, tripDays);
    const db = await readDb();
    const stay = db.listings.find((listing) => listing.id === accommodationListingId && listing.category === 'stay' && listing.status === 'approved' && normalizedDestination.toLowerCase().startsWith(listing.municipality.toLowerCase()));
    if (accommodationListingId && !stay) {
      return Response.json({ error: 'Select an approved accommodation in the chosen city or municipality.' }, { status: 400 });
    }
    const externalRate = Number(externalAccommodation?.nightlyRate);
    const hasValidExternalAccommodation = externalAccommodation
      && typeof externalAccommodation.hotelId === 'string' && externalAccommodation.hotelId.length <= 30
      && typeof externalAccommodation.offerId === 'string' && externalAccommodation.offerId.length <= 200
      && typeof externalAccommodation.name === 'string' && externalAccommodation.name.length > 0 && externalAccommodation.name.length <= 150
      && Number.isFinite(externalRate) && externalRate > 0 && externalRate <= 10_000_000
      && verifyOfferToken({ hotelId: externalAccommodation.hotelId, offerId: externalAccommodation.offerId, name: externalAccommodation.name, nightlyRate: Math.round(externalRate), isLive: externalAccommodation.isLive === true }, externalAccommodation.selectionToken);
    if (externalAccommodation && !hasValidExternalAccommodation) {
      return Response.json({ error: 'The selected live accommodation offer is invalid.' }, { status: 400 });
    }
    if (accommodationListingId && externalAccommodation) {
      return Response.json({ error: 'Select either a TravelMate stay or a live hotel offer.' }, { status: 400 });
    }
    const accommodation: Omit<AccommodationPlan, 'nights' | 'total'> | undefined = stay
      ? { listingId: stay.id, name: stay.name, address: stay.address, nightlyRate: stay.price, source: 'travelmate' as const }
      : hasValidExternalAccommodation
        ? { listingId: `amadeus:${externalAccommodation!.hotelId}`, offerId: externalAccommodation!.offerId!, name: externalAccommodation!.name!, address: String(externalAccommodation!.address || normalizedDestination).slice(0, 300), nightlyRate: Math.round(externalRate), source: 'amadeus' as const, isLive: externalAccommodation!.isLive === true }
        : undefined;
    const accommodationNights = accommodation ? Math.max(1, tripDays - 1) : 0;
    const accommodationTotal = accommodation ? accommodation.nightlyRate * accommodationNights : 0;
    const variableBudget = Math.max(0, computedBudget.total - accommodationTotal - computedBudget.reserve);
    const safeInterests = Array.isArray(interests) ? interests.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20) : [];
    const safeActivities = Array.isArray(preferredActivities) ? preferredActivities.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20) : [];
    const preferences = {
      travelStyle: preference(travelStyle, 'balanced'),
      accommodation: preference(accommodationPreference, accommodation ? 'selected accommodation' : 'no preference'),
      transportation: preference(transportationPreference, 'practical local transport'),
      activities: safeActivities,
    };

    const resolvedProvider = resolveAIProvider();

    // ── No API key → return mock data immediately ──────────────────────────
    if (!resolvedProvider.provider) {
      console.warn(`[TravelMate] ${resolvedProvider.name} API key not set - returning mock itinerary.`);
      const fallback = await finalizeItinerary(buildMockItinerary(normalizedDestination, budget, startDate, tripDays), computedBudget, partyType, travelers, tripDays, startDate, accommodation);
      return Response.json({ ...fallback, preferences });
    }

    // ── Call OpenAI ────────────────────────────────────────────────────────
    const safeWeather = Array.isArray(weatherContext) ? weatherContext.slice(0, tripDays).flatMap((item) => {
      const date = typeof item?.date === 'string' ? item.date : '';
      const description = typeof item?.description === 'string' ? item.description.trim().slice(0, 60) : '';
      const rain = Number(item?.precipitationProbability);
      const tempMax = Number(item?.tempMax);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && description && Number.isFinite(rain) && Number.isFinite(tempMax) ? [`${date}: ${description}, ${Math.max(0, Math.min(100, Math.round(rain)))}% rain, high ${Math.round(tempMax)}°C`] : [];
    }) : [];
    const weatherSummary = safeWeather.length ? `Date-matched live forecast: ${safeWeather.join('; ')}. Prefer indoor alternatives during heavy rain and cooler hours during extreme heat.` : '';
    const prompt = travelerPrompt(normalizedDestination, budget, partyType, travelers, startDate, endDate, safeInterests, accommodationTotal, variableBudget, tripDays, preferences, weatherSummary);

    let itinerary: ItineraryResponse;
    try {
      const generated = await generateValidatedItinerary({
        provider: resolvedProvider.provider,
        systemPrompt: buildSystemPrompt(tripDays),
        userPrompt: prompt,
        tripDays,
        startDate,
        totalBudget: budget,
      });
      itinerary = {
        ...generated,
        days: generated.days.map((day, index) => ({
          ...day,
          imageUrl: DAY_IMAGES[index % DAY_IMAGES.length],
        })),
      };
    } catch (error) {
      console.error(`[TravelMate] ${resolvedProvider.name} generation failed after validation/repair - falling back to mock.`, error instanceof Error ? error.message : error);
      const fallback = await finalizeItinerary(buildMockItinerary(normalizedDestination, budget, startDate, tripDays), computedBudget, partyType, travelers, tripDays, startDate, accommodation);
      return Response.json({ ...fallback, preferences });
    }

    const completed = await finalizeItinerary({ ...itinerary, destination: normalizedDestination, totalBudget: budget, source: resolvedProvider.name }, computedBudget, partyType, travelers, tripDays, startDate, accommodation);
    return Response.json({ ...completed, preferences });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    console.error('[TravelMate] /api/itinerary unexpected error:', error);
    return Response.json(
      { error: 'Internal server error. Please try again.' },
      { status: 500 },
    );
  }
}
