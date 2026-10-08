import { validateActivitySchedule } from './activity-schedule.ts';
import { allocateEqualShares, allocateNightlyCosts, formatMoney, type CurrencyCode } from "../../schemas/domain.ts";
import { ItineraryEditValidationError } from "../../exceptions/index.ts";
import { buildBudgetOptimization } from "../budget/budget-optimization-service.ts";
import { refreshGroundedTotals } from './grounded-plan.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';

type JsonRecord = Record<string, unknown>;

const categories = new Set(["accommodation", "food", "activity", "transport", "misc"]);

function record(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItineraryEditValidationError(message);
  return value as JsonRecord;
}

function finiteMoney(value: unknown, currency: CurrencyCode): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    throw new ItineraryEditValidationError(`Activity cost must be between ${formatMoney(0, currency)} and ${formatMoney(10_000_000, currency)}.`);
  }
  return Math.round(amount * 100) / 100;
}

function text(value: unknown, field: string, maximum: number, required = false): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if ((required && !normalized) || normalized.length > maximum) {
    throw new ItineraryEditValidationError(`${field} ${required ? "is required and " : ""}must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function optionalImage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1_000) return undefined;
  return value.startsWith("/") || value.startsWith("https://upload.wikimedia.org/") || value.startsWith("https://thumb.wikimedia.org/") ? value : undefined;
}

function activityInput(value: unknown, travelers: number, currency: CurrencyCode, stored: JsonRecord[] = [], grounded = false): JsonRecord {
  const activity = record(value, "Every activity must be structured data.");
  const category = typeof activity.category === "string" && categories.has(activity.category) ? activity.category : "activity";
  const estimatedCost = finiteMoney(activity.estimatedCost, currency);
  const imageUrl = optionalImage(activity.imageUrl);
  const identity = grounded ? stored.find(candidate => ['title', 'description'].every(key => candidate[key] === activity[key]) && (candidate.location || '') === (activity.location || '')) : undefined;
  const original = identity && identity.estimatedCost === activity.estimatedCost && identity.category === activity.category ? identity : undefined;
  const timing = { ...(activity.durationMinutes !== undefined || identity?.durationMinutes !== undefined ? { durationMinutes: Number(activity.durationMinutes ?? identity?.durationMinutes) } : {}), ...(activity.travelMinutes !== undefined ? { travelMinutes: Number(activity.travelMinutes) } : {}), ...(activity.location !== undefined ? { location: text(activity.location, 'Activity location', 200) } : {}) };
  if (grounded) {
    const result = {
      ...timing,
      ...(identity ? { place: identity.place, imageUrl: identity.imageUrl, imageAttribution: identity.imageAttribution, placeVerification: identity.placeVerification } : {}),
      time: text(activity.time, 'Activity time', 30) || 'Flexible', title: text(activity.title, 'Activity title', 160, true),
      description: text(activity.description, 'Activity description', 1000), estimatedCost, category, icon: category,
      unitCost: original?.unitCost ?? estimatedCost,
      ...(original ? { priceEvidence: original.priceEvidence, place: original.place, imageUrl: original.imageUrl, imageAttribution: original.imageAttribution, placeVerification: original.placeVerification } : {
        priceEvidence: { status: 'estimate', basis: 'User-entered whole-group estimate after manual editing; venue and price are not verified.', source: 'user-entered', fetchedAt: new Date().toISOString(), currency, unitAmount: estimatedCost, quantity: 1, unit: 'group', participants: travelers, needsConfirmation: true },
        placeVerification: identity?.placeVerification ?? 'unverified',
      }),
    };
    return result;
  }
  return {
    ...timing,
    time: text(activity.time, "Activity time", 30) || "Flexible",
    title: text(activity.title, "Activity title", 160, true),
    description: text(activity.description, "Activity description", 1_000),
    estimatedCost,
    unitCost: Math.round((estimatedCost / travelers) * 100) / 100,
    category,
    icon: category,
    ...(imageUrl ? { imageUrl } : {}),
    ...(activity.imageAttribution && typeof activity.imageAttribution === "object" ? { imageAttribution: activity.imageAttribution } : {}),
  };
}

function activitiesFromDay(value: unknown, travelers: number, currency: CurrencyCode, stored: JsonRecord[] = [], grounded = false): JsonRecord[] {
  const day = record(value, "Every itinerary day must be structured data.");
  if (!Array.isArray(day.activities)) throw new ItineraryEditValidationError("Every itinerary day must contain an activities list.");
  if (day.activities.length > 8) throw new ItineraryEditValidationError("A day can contain at most 8 activities.");
  try { return validateActivitySchedule(day.activities.map((activity) => activityInput(activity, travelers, currency, stored, grounded)) as unknown as import('../../controllers/itinerary-controller.ts').DayActivity[]) as unknown as JsonRecord[]; }
  catch (error) { throw new ItineraryEditValidationError(error instanceof Error ? error.message : 'Activity schedule is invalid.'); }
}

function safeNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Applies only activity-list changes to an existing saved itinerary. All other
 * trip and itinerary metadata comes from the server-owned stored record.
 */
export function applyManualItineraryChanges(
  existingValue: unknown,
  submittedValue: unknown,
  expectedDays: number,
  budget: number,
  travelers: number,
  currency: CurrencyCode,
): JsonRecord {
  const existing = record(existingValue, "The saved itinerary is invalid.");
  const submitted = record(submittedValue, "The edited itinerary is invalid.");
  if (!Array.isArray(existing.days) || existing.days.length !== expectedDays) {
    throw new ItineraryEditValidationError("The saved itinerary does not match the trip dates.");
  }
  if (!Array.isArray(submitted.days) || submitted.days.length !== expectedDays) {
    throw new ItineraryEditValidationError(`Itinerary must contain exactly ${expectedDays} day${expectedDays === 1 ? "" : "s"}.`);
  }
  const submittedDays = submitted.days;

  const accommodation = existing.accommodation && typeof existing.accommodation === "object" && !Array.isArray(existing.accommodation)
    ? existing.accommodation as JsonRecord
    : undefined;
  const nightlyRate = safeNumber(accommodation?.nightlyRate);
  const nights = Math.min(expectedDays, Math.floor(safeNumber(accommodation?.nights)));
  const grounding = existing.grounding as ItineraryResponse['grounding'];
  const accommodationTotal = accommodation ? safeNumber(accommodation.quotedTotal ?? Math.round(nightlyRate * nights * 100)/100) : grounding?.categories.accommodation ?? 0;
  const lodgingNights = nights || grounding?.nights || 0;
  const lodgingByNight = lodgingNights ? allocateNightlyCosts(accommodationTotal, lodgingNights, currency) : [];

  const days = existing.days.map((storedDay, index) => {
    const day = record(storedDay, "The saved itinerary contains an invalid day.");
    const activities = activitiesFromDay(submittedDays[index], travelers, currency, Array.isArray(day.activities) ? day.activities as JsonRecord[] : [], Boolean(grounding));
    if (grounding && activities.some(activity => activity.category === 'accommodation')) throw new ItineraryEditValidationError('Accommodation is already calculated from rooms and nights. Add any extra one-off lodging charge as a miscellaneous expense to avoid counting the stay twice.');
    if (accommodation) for (const activity of activities) {
      if (activity.category === 'accommodation') { activity.unitCost = 0; activity.estimatedCost = 0; }
    }
    const activityTotal = activities.reduce((sum, activity) => sum + Number(activity.estimatedCost), 0);
    const rideFare = activities.filter((activity) => activity.category === "transport").reduce((sum, activity) => sum + Number(activity.estimatedCost), 0);
    return {
      ...day,
      activities,
      rideFare: Math.round(rideFare * 100) / 100,
      totalCost: Math.round((activityTotal + (lodgingByNight[index] || 0)) * 100) / 100,
    };
  });

  const selectedTravelCosts = existing.selectedTravelCosts && typeof existing.selectedTravelCosts === 'object' && !Array.isArray(existing.selectedTravelCosts) ? existing.selectedTravelCosts as JsonRecord : undefined;
  const plannedSpend = Math.round((days.reduce((sum, day) => sum + Number(day.totalCost), 0) + safeNumber(selectedTravelCosts?.total)) * 100) / 100;
  const remainingBudget = Math.max(0, Math.round((budget - plannedSpend) * 100) / 100);
  const shortfall = Math.max(0, Math.round((plannedSpend - budget) * 100) / 100);
  const previousBudget = existing.budgetSummary && typeof existing.budgetSummary === "object" && !Array.isArray(existing.budgetSummary) ? existing.budgetSummary as JsonRecord : {};
  const previousSharing = existing.costSharing && typeof existing.costSharing === "object" && !Array.isArray(existing.costSharing) ? existing.costSharing as JsonRecord : {};
  const reserve = safeNumber(previousBudget.reserve);
  const budgetOptimization = buildBudgetOptimization({
    budget,
    currency,
    reserve,
    plannedSpend,
    travelers,
    accommodation: accommodation ? { nightlyRate, nights } : undefined,
    days: days.map((day, index) => ({
      day: index + 1,
      activities: day.activities.map((activity) => ({
        title: String(activity.title || "Activity"),
        estimatedCost: safeNumber(activity.estimatedCost),
        category: String(activity.category || "activity"),
      })),
    })),
  });

  const edited = {
    ...existing,
    totalBudget: budget,
    travelers,
    manuallyEdited: true,
    days,
    budgetOptimization,
    budgetSummary: { ...previousBudget, total: budget, accommodationActual: accommodationTotal, travelOptionsActual: safeNumber(selectedTravelCosts?.total), plannedSpend, remainingBudget, shortfall },
    costSharing: {
      ...previousSharing,
      travelers,
      groupBudget: budget,
      plannedGroupSpend: plannedSpend,
      budgetShares: allocateEqualShares(budget, travelers, currency),
      plannedSpendShares: allocateEqualShares(plannedSpend, travelers, currency),
      accommodationShares: allocateEqualShares(accommodationTotal, travelers, currency),
      reserveShares: allocateEqualShares(remainingBudget, travelers, currency),
    },
  };
  return grounding ? refreshGroundedTotals(edited as unknown as ItineraryResponse) as unknown as JsonRecord : edited;
}
