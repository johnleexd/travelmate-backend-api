import { z } from "zod";
import { validateActivitySchedule } from './activity-schedule.ts';
import { SUPPORTED_CURRENCIES, allocateEqualShares, allocateNightlyCosts, currencyFractionDigits, hasValidCurrencyPrecision, type CurrencyCode, type PartyType } from "../../schemas/domain.ts";
import { accommodationQuoteSchema, propertyPhotoSchema } from '../travel/hotel-quote.ts';
import { plannedAccommodationSchema } from '../destination/planned-accommodation.ts';
import { buildBudgetOptimization } from '../budget/budget-optimization-service.ts';
import { groundingSchema, priceEvidenceSchema, placeEvidenceSchema } from './grounding-schema.ts';
import { calculateExpense, refreshGroundedTotals, verifyGroundedPlan } from './grounded-plan.ts';
import { placeMatchesAnchor } from './grounded-places.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { canonicalStoredMedia } from '../../lib/stored-trip-media.ts';
import { isUnsplashActivityPhoto } from './unsplash-activity-photos.ts';

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().finite().min(0).max(1_000_000_000).refine(
  (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  "Use at most two decimal places.",
);
const text = (maximum: number) => z.string().trim().max(maximum);
const savedImageUrl = text(1_000).refine(value => {
  if (!value) return true;
  try { const host = new URL(value).hostname; return host !== 'places.googleapis.com' && !/(^|\.)googleusercontent\.com$/.test(host); }
  catch { return true; } // Existing URL validation/provenance behavior is preserved.
}, 'Google photo URLs are transient and cannot be saved.');

const attributionSchema = z.object({
  creator: text(200), license: text(100), licenseUrl: z.string().url().max(1_000).optional(), sourceUrl: z.string().url().max(1_000),
  provider: z.literal('unsplash').optional(), photoId: text(100).regex(/^[\w-]+$/).optional(),
  photoType: z.enum(['place', 'illustrative', 'destination', 'saved']).optional(),
  photographerUrl: z.string().url().max(1000).optional(), photographerUsername: text(100).optional(),
  illustrative: z.boolean().optional(), match: z.enum(['place', 'destination', 'activity']).optional(),
  downloadLocation: z.string().url().max(1000).optional(), downloadTracked: z.boolean().optional(), selectedAt: isoDateTime.optional(),
}).strict();

const activitySchema = z.object({
  id: text(100).min(1).optional(), status: z.enum(['planned', 'completed', 'skipped', 'rescheduled']).optional(), statusChangedAt: isoDateTime.optional(),
  managementHistory: z.array(z.object({ action: z.enum(['complete', 'skip', 'plan', 'edit', 'reschedule', 'replan']), status: z.enum(['planned', 'completed', 'skipped', 'rescheduled']), at: isoDateTime, fromDate: z.string().regex(isoDate), fromTime: text(30), toDate: z.string().regex(isoDate), toTime: text(30) }).strict()).max(500).optional(),
  time: text(30), title: text(160).min(1), description: text(1_000), estimatedCost: money,
  durationMinutes: z.number().int().min(15).max(720).optional(), travelMinutes: z.number().int().min(0).max(480).optional(), location: text(200).optional(),
  unitCost: money.optional(), category: z.enum(["accommodation", "food", "activity", "transport", "misc"]),
  icon: text(32), imageUrl: savedImageUrl.optional(), imageAttribution: attributionSchema.optional(),
  googlePlaceId: text(255).regex(/^[\w-]{10,255}$/).optional(),
  placeVerification: z.enum(["supporting-source-found", "unverified"]).optional(),
  place: placeEvidenceSchema.optional(), priceEvidence: priceEvidenceSchema.optional(),
  scheduleLabel: z.literal('Suggested').optional(),
}).strict();

const daySchema = z.object({
  day: z.number().int().min(1).max(31), date: z.string().regex(isoDate), theme: text(120).min(1), imageUrl: savedImageUrl,
  imageAttribution: attributionSchema.optional(), travelNote: text(500).optional(), returnToStayAt: text(30).optional(),
  rideFare: money.optional(), totalCost: money, activities: z.array(activitySchema).max(8), weatherAlert: text(500).optional(),
  crowdLevel: z.enum(["low", "moderate", "high"]).optional(), crowdSource: z.literal("estimated").optional(),
  crowdConfidence: z.literal("low").optional(), crowdNote: text(500).optional(), crowdRecommendation: text(500).optional(),
  crowdFetchedAt: isoDateTime.optional(), crowdRefreshAfter: isoDateTime.optional(),
  planningStatus: z.enum(['suggested', 'incomplete', 'rest', 'travel']).optional(), planningReason: text(500).optional(),
  scheduleBlocks: z.array(z.object({ kind: z.enum(['meal', 'free-time', 'unscheduled']), startMinutes: z.number().int().min(0).max(1439), endMinutes: z.number().int().min(1).max(1440), label: text(200) }).strict().refine(block => block.endMinutes > block.startMinutes)).max(20).optional(),
}).strict();

const budgetSummarySchema = z.object({
  accommodation: money, food: money, activities: money, transport: money, reserve: money, dailyAverage: money, total: money,
  accommodationActual: money.optional(), variableBudget: money.optional(), plannedSpend: money.optional(),
  travelOptionsActual: money.optional(), remainingBudget: money.optional(), shortfall: money.optional(),
}).strict();

const costSharingSchema = z.object({
  partyType: z.enum(["solo", "couple", "family", "friends"]), travelers: z.number().int().min(1).max(20),
  groupBudget: money, plannedGroupSpend: money, budgetShares: z.array(money).min(1).max(20),
  plannedSpendShares: z.array(money).min(1).max(20), accommodationShares: z.array(money).min(1).max(20),
  reserveShares: z.array(money).min(1).max(20),
}).strict();

const optimizationSuggestionSchema = z.object({
  id: text(200).min(1), category: z.enum(["accommodation", "food", "activity", "transport"]), title: text(200).min(1),
  description: text(1_000), estimatedSavings: money, tradeoff: text(1_000), affectedDay: z.number().int().min(1).max(31).optional(),
  affectedActivityTitle: text(160).optional(),
}).strict();

const budgetOptimizationSchema = z.object({
  status: z.enum(["within_budget", "near_limit", "over_budget"]), targetSpend: money, amountToTarget: money,
  combinedEstimatedSavings: money, projectedSpendIfAllApplied: money, remainingGapAfterSuggestions: money,
  suggestions: z.array(optimizationSuggestionSchema).max(8), disclaimer: text(1_000),
}).strict();

const accommodationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90).optional(), longitude: z.number().finite().min(-180).max(180).optional(),
  photos: z.array(propertyPhotoSchema).max(5).optional(),
  listingId: text(200).min(1), name: text(200).min(1), address: text(500), nightlyRate: money,
  nights: z.number().int().min(1).max(30), total: money, currency: z.enum(SUPPORTED_CURRENCIES),
  quotedTotal: money.optional(),
  rooms: z.number().int().min(1).max(20).optional(),
  fetchedAt: isoDateTime.optional(),
  providerQuote: accommodationQuoteSchema.optional(),
  source: z.enum(["travelmate", "amadeus", "expedia-rapid", "liteapi"]).optional(), offerId: text(12000).optional(), isLive: z.boolean().optional(),
}).strict();

const selectedTravelCostsSchema = z.object({
  flight: z.object({ id: text(200).min(1), name: text(200).min(1), total: money, currency: z.enum(SUPPORTED_CURRENCIES), fetchedAt: isoDateTime, source: z.literal("amadeus").optional(), isLive: z.boolean().optional() }).strict().optional(),
  activities: z.array(z.object({ id: text(200).min(1), name: text(200).min(1), unitCost: money, travelers: z.number().int().min(1).max(20), total: money, currency: z.enum(SUPPORTED_CURRENCIES), fetchedAt: isoDateTime, source: z.enum(["amadeus", "travelmate"]).optional(), isLive: z.boolean().optional(), priceBasis: z.literal("per-person-assumption").optional() }).strict()).max(10),
  preTrip: z.object({
    startingLocation: text(200).optional(), departureAirport: text(200).optional(), passportCountry: text(200).optional(),
    passportStatus: z.enum(['valid', 'needs_application', 'needs_renewal', 'not_sure']).optional(),
    airportTransferOutbound: money, airportTransferReturn: money, passport: money, visaOrAuthorization: money,
    departureTaxes: money, insurance: money, other: money, total: money, currency: z.enum(SUPPORTED_CURRENCIES), source: z.literal('user-entered-estimate'),
  }).strict().optional(),
  total: money,
}).strict();

const itinerarySchema = z.object({
  destination: text(2000).min(2), totalBudget: money.positive(), currency: z.enum(SUPPORTED_CURRENCIES),
  source: z.enum(["openai", "gemini", "mock", "catalog"]).optional(), partyType: z.enum(["solo", "couple", "family", "friends"]).optional(),
  travelers: z.number().int().min(1).max(20).optional(), preferences: z.object({
    pace: z.enum(['relaxed', 'balanced', 'active']).optional(),
    travelStyle: text(80), accommodation: text(120), transportation: text(120), activities: z.array(text(160)).max(20), interests: z.array(text(200)).max(20).optional(),
  }).strict().optional(), accommodation: accommodationSchema.optional(), plannedAccommodation: plannedAccommodationSchema.optional(), budgetOptimization: budgetOptimizationSchema.optional(),
  selectedTravelCosts: selectedTravelCostsSchema.optional(), costSharing: costSharingSchema.optional(), manuallyEdited: z.boolean().optional(), days: z.array(daySchema).min(1).max(31),
  budgetSummary: budgetSummarySchema,
  grounding: groundingSchema.optional(), groundingProof: text(200).optional(),
}).strict();

const freshnessSchema = z.object({
  source: z.enum(["flights", "hotels", "activities", "weather", "exchange-rates"]),
  status: z.enum(["live", "fresh-cache", "stale-cache", "unavailable"]), isStale: z.boolean(),
  fetchedAt: isoDateTime, expiresAt: isoDateTime, staleUntil: isoDateTime, policy: text(500),
}).strict();

const forecastSchema = z.object({
  date: z.string().regex(isoDate), tempMin: z.number().finite(), tempMax: z.number().finite(), description: text(200),
  icon: text(20), iconUrl: text(1_000), precipitationProbability: z.number().finite().min(0).max(100), weatherAlert: text(500).optional(),
}).strict();

const crowdSchema = z.object({
  date: z.string().regex(isoDate), crowdLevel: z.enum(["low", "moderate", "high"]), crowdSource: z.literal("estimated"),
  crowdConfidence: z.literal("low"), crowdNote: text(500), crowdRecommendation: text(500),
  fetchedAt: isoDateTime, refreshAfter: isoDateTime,
}).strict();

const weatherSchema = z.object({
  timeZone: text(100).optional(),
  source: z.enum(["openweathermap", "open-meteo", "unavailable", "mock"]), city: text(120).min(1), country: text(100),
  temperature: z.number().finite(), feelsLike: z.number().finite(), humidity: z.number().finite().min(0).max(100),
  windSpeed: z.number().finite().min(0), description: text(200), icon: text(20), iconUrl: text(1_000),
  alerts: z.array(text(500)).max(20), forecast: z.array(forecastSchema).max(31), forecastAvailable: z.boolean(),
  forecastMessage: text(500).optional(), fetchedAt: isoDateTime, refreshAfter: isoDateTime, freshness: freshnessSchema,
  crowd: z.array(crowdSchema).max(31),
}).strict();

function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.length ? issue.path.join(".") : "root"}: ${issue.message}`;
}

export function parseSavedItinerary(value: unknown, context: { days: number; currency: CurrencyCode; budget: number; travelers: number; partyType: PartyType; startDate?: string; destination?: string }) {
  const raw = value as Partial<ItineraryResponse> | null;
  // Signed plans must retain exactly the fields covered by their proof. Older
  // unsigned photo aliases can be upgraded locally through the ordinary schema.
  const compatible = raw && !raw.grounding && Array.isArray(raw.days) ? { ...raw, days: raw.days.map(day => ({ ...canonicalStoredMedia(day as unknown as Record<string, unknown>), activities: Array.isArray(day.activities) ? day.activities.map(activity => canonicalStoredMedia(activity as unknown as Record<string, unknown>, true)) : day.activities })) } : value;
  const parsed = itinerarySchema.safeParse(compatible);
  if (!parsed.success) throw new Error(`Itinerary is invalid (${issueMessage(parsed.error)}).`);
  const itinerary = parsed.data;
  if (itinerary.grounding && !verifyGroundedPlan(value as ItineraryResponse)) throw new Error('Grounded itinerary evidence or prices were changed. Regenerate or save edits through the manual-edit action.');
  const destinationKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (context.destination && destinationKey(itinerary.destination) !== destinationKey(context.destination)) throw new Error('Itinerary destination must match the trip destination.');
  if (itinerary.days.length !== context.days) throw new Error(`Itinerary must contain exactly ${context.days} days.`);
  if (itinerary.currency !== context.currency) throw new Error("Itinerary currency must match the trip currency.");
  if (!hasValidCurrencyPrecision(context.budget, context.currency)) throw new Error('Trip budget has invalid currency precision.');
  if (Math.round(itinerary.totalBudget * 100) !== Math.round(context.budget * 100)) throw new Error("Itinerary budget must match the trip budget.");
  const stay = itinerary.accommodation;
  if (stay?.providerQuote) {
    const quote = stay.providerQuote;
    const guests = quote.occupancy.reduce((sum, room) => sum + room.adults + room.childAges.length, 0);
    const start = context.startDate ?? itinerary.days[0].date;
    const checkout = new Date(start + 'T00:00:00.000Z');
    checkout.setUTCDate(checkout.getUTCDate() + Math.max(1, context.days - 1));
    if (stay.source !== quote.provider || stay.listingId !== (quote.provider === 'liteapi' ? 'liteapi:' : 'rapid:') + quote.propertyId || stay.offerId !== quote.offerId
      || stay.currency !== quote.currency || stay.quotedTotal !== (quote.budgetTotal ?? quote.total) || stay.total !== (quote.budgetTotal ?? quote.total)
      || (stay.rooms !== undefined && stay.rooms !== quote.occupancy.length) || guests !== context.travelers
      || quote.checkInDate !== start || quote.checkOutDate !== checkout.toISOString().slice(0, 10)
      || stay.isLive !== quote.isLive || !hasValidCurrencyPrecision(quote.total, quote.currency)) {
      throw new Error('Saved accommodation quote must match its property, offer, dates, guests, currency and total.');
    }
  }
  if (stay && stay.currency !== context.currency) throw new Error('Accommodation currency must match the trip currency.');
  if (stay && stay.nights !== Math.max(1, context.days - 1)) throw new Error('Accommodation nights must match the trip dates.');
  const lodgingByNight = stay ? allocateNightlyCosts(stay.quotedTotal ?? Math.round(stay.nightlyRate * stay.nights * (stay.rooms ?? 1) * 100)/100, stay.nights, context.currency)
    : itinerary.grounding?.nights ? allocateNightlyCosts(itinerary.grounding.categories.accommodation, itinerary.grounding.nights, context.currency) : [];
  if (stay && Math.abs(stay.total - lodgingByNight.reduce((a,b) => a+b,0)) > 0.011) throw new Error('Accommodation total does not match its quoted cost.');
  itinerary.days.forEach((day, index) => {
    day.activities = validateActivitySchedule(day.activities, itinerary.preferences?.transportation);
    if (day.day !== index + 1) throw new Error(`Itinerary day ${index + 1} is out of sequence.`);
    const expected = new Date(`${context.startDate ?? itinerary.days[0].date}T00:00:00.000Z`);
    if (!Number.isFinite(expected.getTime())) throw new Error('Itinerary start date is invalid.');
    expected.setUTCDate(expected.getUTCDate() + index);
    if (day.date !== expected.toISOString().slice(0, 10)) throw new Error(`Itinerary day ${index + 1} must use the corresponding trip date.`);
    const activityTotal = day.activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    if (day.activities.some(activity => !hasValidCurrencyPrecision(activity.estimatedCost, context.currency))) throw new Error('Activity costs have invalid currency precision.');
    const accommodation = lodgingByNight[index] || 0;
    if (!hasValidCurrencyPrecision(day.totalCost, context.currency)) throw new Error('Day costs have invalid currency precision.');
    if (Math.abs(day.totalCost - activityTotal - accommodation) > 0.011) throw new Error(`Itinerary day ${index + 1} total does not match its item costs.`);
  });
  if (itinerary.partyType && itinerary.partyType !== context.partyType) throw new Error("Itinerary party type must match the trip party type.");
  if (itinerary.travelers && itinerary.travelers !== context.travelers) throw new Error("Itinerary traveler count must match the trip traveler count.");
  if (!itinerary.grounding && itinerary.days.some(day => day.activities.some(activity => activity.priceEvidence || activity.place))) throw new Error('Price/place evidence requires a signed grounded plan.');
  if (itinerary.grounding) {
    const grounding = itinerary.grounding;
    if (grounding.currency !== context.currency || grounding.startDate !== itinerary.days[0].date || grounding.endDate !== itinerary.days.at(-1)!.date) throw new Error('Grounding context does not match the trip.');
    if (grounding.nights !== (stay?.nights ?? Math.max(0, context.days - 1)) || grounding.accommodation.quantity !== grounding.rooms * grounding.nights || grounding.accommodation.unit !== 'per-room-night'
      || grounding.accommodation.currency !== context.currency || Math.abs(calculateExpense(grounding.accommodation.unitAmount, grounding.rooms * grounding.nights, context.travelers, 'per-room-night', context.currency) - grounding.categories.accommodation) > 0.001) throw new Error('Accommodation total does not match rooms, nights and the nightly price basis.');
    for (const activity of itinerary.days.flatMap(day => day.activities)) {
      const price = activity.priceEvidence;
      if (!price || price.currency !== context.currency || price.participants > context.travelers || !hasValidCurrencyPrecision(price.unitAmount, context.currency)) throw new Error('Activity price basis is missing or inconsistent.');
      const expected = calculateExpense(price.unitAmount, price.quantity, price.participants, price.unit, context.currency);
      if (Math.abs(expected - activity.estimatedCost) > 0.001) throw new Error('Activity total does not match its price basis.');
      const place = activity.place;
      if (place && !placeMatchesAnchor(place, grounding.destination)) throw new Error('Attraction location does not match the selected city and country or verified nearby boundary.');
      if (activity.imageUrl) {
        const commons = Boolean((place || activity.location?.trim() || activity.imageAttribution?.photoType === 'place') && activity.imageAttribution && activity.imageAttribution.provider !== 'unsplash' && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(activity.imageUrl));
        const unsplash = Boolean((place || activity.location?.trim() || activity.imageAttribution?.illustrative) && activity.category !== 'accommodation' && isUnsplashActivityPhoto(activity));
        if (!commons && !unsplash) throw new Error('Attraction photo requires place-linked source attribution.');
      }
    }
    const recomputed = refreshGroundedTotals(itinerary as ItineraryResponse).grounding!;
    if (Object.keys(grounding.categories).some(key => Math.abs(grounding.categories[key as keyof typeof grounding.categories] - recomputed.categories[key as keyof typeof grounding.categories]) > 0.001)
      || Math.abs(grounding.total - recomputed.total) > 0.001 || Math.abs(grounding.subtotal - recomputed.subtotal) > 0.001) throw new Error('Grounded expense totals are inconsistent.');
  }
  if (itinerary.selectedTravelCosts) {
    const costs = itinerary.selectedTravelCosts;
    const amounts = [costs.total, costs.flight?.total ?? 0, ...costs.activities.flatMap(activity => [activity.unitCost, activity.total]),
      ...Object.entries(costs.preTrip ?? {}).filter(([, amount]) => typeof amount === 'number').map(([, amount]) => amount as number)];
    if (amounts.some(amount => !hasValidCurrencyPrecision(amount, context.currency))) throw new Error('Selected travel costs have invalid currency precision.');
    if (itinerary.selectedTravelCosts.flight?.currency !== undefined && itinerary.selectedTravelCosts.flight.currency !== context.currency) throw new Error("Selected flight currency must match the trip currency.");
    for (const activity of itinerary.selectedTravelCosts.activities) {
      if (activity.currency !== context.currency || activity.travelers !== context.travelers) throw new Error("Selected activity costs must match the trip currency and traveler count.");
      if (Math.abs(activity.total - activity.unitCost * activity.travelers) > 0.011) throw new Error("Selected activity total is inconsistent.");
    }
    const preTrip = itinerary.selectedTravelCosts.preTrip;
    if (preTrip) {
      if (preTrip.currency !== context.currency) throw new Error('Pre-trip currency must match the trip currency.');
      const preTripTotal = preTrip.airportTransferOutbound + preTrip.airportTransferReturn + preTrip.passport + preTrip.visaOrAuthorization + preTrip.departureTaxes + preTrip.insurance + preTrip.other;
      if (Math.abs(preTripTotal - preTrip.total) > 0.011) throw new Error('Pre-trip cost total is inconsistent.');
    }
    const selectedTotal = (itinerary.selectedTravelCosts.flight?.total ?? 0) + itinerary.selectedTravelCosts.activities.reduce((sum, activity) => sum + activity.total, 0) + (preTrip?.total ?? 0);
    if (Math.abs(selectedTotal - itinerary.selectedTravelCosts.total) > 0.011) throw new Error("Selected travel cost total is inconsistent.");
  }
  if (itinerary.costSharing) {
    if (itinerary.costSharing.travelers !== context.travelers || itinerary.costSharing.partyType !== context.partyType) throw new Error("Itinerary cost sharing does not match the trip party.");
    for (const [name, shares] of Object.entries({ budgetShares: itinerary.costSharing.budgetShares, plannedSpendShares: itinerary.costSharing.plannedSpendShares, accommodationShares: itinerary.costSharing.accommodationShares, reserveShares: itinerary.costSharing.reserveShares })) {
      if (shares.length !== context.travelers) throw new Error(`Itinerary ${name} must contain one share per traveler.`);
    }
  }
  const scale = 10 ** currencyFractionDigits(context.currency);
  const round = (amount: number) => Math.round(amount * scale) / scale;
  const accommodationActual = round(lodgingByNight.reduce((sum, amount) => sum + amount, 0));
  const travelOptionsActual = itinerary.selectedTravelCosts?.total ?? 0;
  if (!hasValidCurrencyPrecision(travelOptionsActual, context.currency)) throw new Error('Selected travel costs have invalid currency precision.');
  const plannedSpend = round(itinerary.days.reduce((sum, day) => sum + day.totalCost, 0) + travelOptionsActual);
  if (plannedSpend > 1_000_000_000) throw new Error('Planned spending exceeds the supported limit.');
  const remainingBudget = round(Math.max(0, context.budget - plannedSpend));
  const shortfall = round(Math.max(0, plannedSpend - context.budget));
  // Budget categories are allocation targets. Actual spending comes only from
  // validated day items, selected accommodation, and selected travel costs.
  const units = Math.round(context.budget * scale);
  const [accommodation, food, activities, transport] = [34, 22, 20, 14].map(weight => Math.floor(units * weight / 100) / scale);
  const reserve = round(context.budget - accommodation - food - activities - transport);
  itinerary.budgetSummary = {
    accommodation, food, activities, transport, reserve, total: context.budget,
    dailyAverage: round(context.budget / context.days), accommodationActual, travelOptionsActual,
    variableBudget: round(Math.max(0, context.budget - accommodationActual - travelOptionsActual - reserve)),
    plannedSpend, remainingBudget, shortfall,
  };
  itinerary.partyType = context.partyType;
  itinerary.travelers = context.travelers;
  itinerary.costSharing = {
    partyType: context.partyType, travelers: context.travelers,
    groupBudget: context.budget, plannedGroupSpend: plannedSpend,
    budgetShares: allocateEqualShares(context.budget, context.travelers, context.currency),
    plannedSpendShares: allocateEqualShares(plannedSpend, context.travelers, context.currency),
    accommodationShares: allocateEqualShares(accommodationActual, context.travelers, context.currency),
    reserveShares: allocateEqualShares(remainingBudget, context.travelers, context.currency),
  };
  itinerary.budgetOptimization = buildBudgetOptimization({
    budget: context.budget, currency: context.currency, reserve, plannedSpend, travelers: context.travelers,
    accommodation: stay ? { nightlyRate: stay.nightlyRate, nights: stay.nights } : undefined,
    days: itinerary.days,
  });
  return itinerary.grounding ? refreshGroundedTotals(itinerary as ItineraryResponse) : itinerary;
}

export function parseSavedWeather(value: unknown) {
  if (value === undefined || value === null) return null;
  const parsed = weatherSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Weather snapshot is invalid (${issueMessage(parsed.error)}).`);
  return parsed.data;
}
