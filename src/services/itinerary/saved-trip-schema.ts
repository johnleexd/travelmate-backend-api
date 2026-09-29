import { z } from "zod";
import { SUPPORTED_CURRENCIES, type CurrencyCode, type PartyType } from "../../schemas/domain.ts";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().finite().min(0).max(1_000_000_000).refine(
  (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  "Use at most two decimal places.",
);
const text = (maximum: number) => z.string().trim().max(maximum);

const attributionSchema = z.object({
  creator: text(200), license: text(100), licenseUrl: z.string().url().max(1_000).optional(), sourceUrl: z.string().url().max(1_000),
}).strict();

const activitySchema = z.object({
  time: text(30), title: text(160).min(1), description: text(1_000), estimatedCost: money,
  unitCost: money.optional(), category: z.enum(["accommodation", "food", "activity", "transport", "misc"]),
  icon: text(32), imageUrl: text(1_000).optional(), imageAttribution: attributionSchema.optional(),
  placeVerification: z.enum(["supporting-source-found", "unverified"]).optional(),
}).strict();

const daySchema = z.object({
  day: z.number().int().min(1).max(14), date: z.string().regex(isoDate), theme: text(120).min(1), imageUrl: text(1_000),
  imageAttribution: attributionSchema.optional(), travelNote: text(500).optional(), returnToStayAt: text(30).optional(),
  rideFare: money.optional(), totalCost: money, activities: z.array(activitySchema).max(8), weatherAlert: text(500).optional(),
  crowdLevel: z.enum(["low", "moderate", "high"]).optional(), crowdSource: z.literal("estimated").optional(),
  crowdConfidence: z.literal("low").optional(), crowdNote: text(500).optional(), crowdRecommendation: text(500).optional(),
  crowdFetchedAt: isoDateTime.optional(), crowdRefreshAfter: isoDateTime.optional(),
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
  description: text(1_000), estimatedSavings: money, tradeoff: text(1_000), affectedDay: z.number().int().min(1).max(14).optional(),
  affectedActivityTitle: text(160).optional(),
}).strict();

const budgetOptimizationSchema = z.object({
  status: z.enum(["within_budget", "near_limit", "over_budget"]), targetSpend: money, amountToTarget: money,
  combinedEstimatedSavings: money, projectedSpendIfAllApplied: money, remainingGapAfterSuggestions: money,
  suggestions: z.array(optimizationSuggestionSchema).max(8), disclaimer: text(1_000),
}).strict();

const accommodationSchema = z.object({
  listingId: text(200).min(1), name: text(200).min(1), address: text(500), nightlyRate: money,
  nights: z.number().int().min(1).max(14), total: money, currency: z.enum(SUPPORTED_CURRENCIES),
  source: z.enum(["travelmate", "amadeus"]).optional(), offerId: text(200).optional(), isLive: z.boolean().optional(),
}).strict();

const selectedTravelCostsSchema = z.object({
  flight: z.object({ id: text(200).min(1), name: text(200).min(1), total: money, currency: z.enum(SUPPORTED_CURRENCIES), fetchedAt: isoDateTime }).strict().optional(),
  activities: z.array(z.object({ id: text(200).min(1), name: text(200).min(1), unitCost: money, travelers: z.number().int().min(1).max(20), total: money, currency: z.enum(SUPPORTED_CURRENCIES), fetchedAt: isoDateTime }).strict()).max(10),
  total: money,
}).strict();

const itinerarySchema = z.object({
  destination: text(120).min(2), totalBudget: money.positive(), currency: z.enum(SUPPORTED_CURRENCIES),
  source: z.enum(["openai", "gemini", "mock"]).optional(), partyType: z.enum(["solo", "couple", "family", "friends"]).optional(),
  travelers: z.number().int().min(1).max(20).optional(), preferences: z.object({
    travelStyle: text(80), accommodation: text(120), transportation: text(120), activities: z.array(text(160)).max(20),
  }).strict().optional(), accommodation: accommodationSchema.optional(), budgetOptimization: budgetOptimizationSchema.optional(),
  selectedTravelCosts: selectedTravelCostsSchema.optional(), costSharing: costSharingSchema.optional(), manuallyEdited: z.boolean().optional(), days: z.array(daySchema).min(1).max(14),
  budgetSummary: budgetSummarySchema,
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
  source: z.enum(["openweathermap", "open-meteo", "unavailable", "mock"]), city: text(120).min(1), country: text(100),
  temperature: z.number().finite(), feelsLike: z.number().finite(), humidity: z.number().finite().min(0).max(100),
  windSpeed: z.number().finite().min(0), description: text(200), icon: text(20), iconUrl: text(1_000),
  alerts: z.array(text(500)).max(20), forecast: z.array(forecastSchema).max(14), forecastAvailable: z.boolean(),
  forecastMessage: text(500).optional(), fetchedAt: isoDateTime, refreshAfter: isoDateTime, freshness: freshnessSchema,
  crowd: z.array(crowdSchema).max(14),
}).strict();

function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.length ? issue.path.join(".") : "root"}: ${issue.message}`;
}

export function parseSavedItinerary(value: unknown, context: { days: number; currency: CurrencyCode; budget: number; travelers: number; partyType: PartyType }) {
  const parsed = itinerarySchema.safeParse(value);
  if (!parsed.success) throw new Error(`Itinerary is invalid (${issueMessage(parsed.error)}).`);
  const itinerary = parsed.data;
  if (itinerary.days.length !== context.days) throw new Error(`Itinerary must contain exactly ${context.days} days.`);
  if (itinerary.currency !== context.currency) throw new Error("Itinerary currency must match the trip currency.");
  if (Math.round(itinerary.totalBudget * 100) !== Math.round(context.budget * 100)) throw new Error("Itinerary budget must match the trip budget.");
  itinerary.days.forEach((day, index) => {
    if (day.day !== index + 1) throw new Error(`Itinerary day ${index + 1} is out of sequence.`);
    const activityTotal = day.activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    const accommodation = index < (itinerary.accommodation?.nights ?? 0) ? itinerary.accommodation?.nightlyRate ?? 0 : 0;
    if (Math.abs(day.totalCost - activityTotal - accommodation) > 0.011) throw new Error(`Itinerary day ${index + 1} total does not match its item costs.`);
  });
  if (itinerary.partyType && itinerary.partyType !== context.partyType) throw new Error("Itinerary party type must match the trip party type.");
  if (itinerary.travelers && itinerary.travelers !== context.travelers) throw new Error("Itinerary traveler count must match the trip traveler count.");
  if (itinerary.selectedTravelCosts) {
    if (itinerary.selectedTravelCosts.flight?.currency !== undefined && itinerary.selectedTravelCosts.flight.currency !== context.currency) throw new Error("Selected flight currency must match the trip currency.");
    for (const activity of itinerary.selectedTravelCosts.activities) {
      if (activity.currency !== context.currency || activity.travelers !== context.travelers) throw new Error("Selected activity costs must match the trip currency and traveler count.");
      if (Math.abs(activity.total - activity.unitCost * activity.travelers) > 0.011) throw new Error("Selected activity total is inconsistent.");
    }
    const selectedTotal = (itinerary.selectedTravelCosts.flight?.total ?? 0) + itinerary.selectedTravelCosts.activities.reduce((sum, activity) => sum + activity.total, 0);
    if (Math.abs(selectedTotal - itinerary.selectedTravelCosts.total) > 0.011) throw new Error("Selected travel cost total is inconsistent.");
  }
  if (itinerary.costSharing) {
    if (itinerary.costSharing.travelers !== context.travelers || itinerary.costSharing.partyType !== context.partyType) throw new Error("Itinerary cost sharing does not match the trip party.");
    for (const [name, shares] of Object.entries({ budgetShares: itinerary.costSharing.budgetShares, plannedSpendShares: itinerary.costSharing.plannedSpendShares, accommodationShares: itinerary.costSharing.accommodationShares, reserveShares: itinerary.costSharing.reserveShares })) {
      if (shares.length !== context.travelers) throw new Error(`Itinerary ${name} must contain one share per traveler.`);
    }
  }
  return itinerary;
}

export function parseSavedWeather(value: unknown) {
  if (value === undefined || value === null) return null;
  const parsed = weatherSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Weather snapshot is invalid (${issueMessage(parsed.error)}).`);
  return parsed.data;
}
