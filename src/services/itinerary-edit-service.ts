import { allocateEqualShares } from "../domain.ts";
import { buildBudgetOptimization } from "./budget-optimization-service.ts";

export class ItineraryEditValidationError extends Error {}

type JsonRecord = Record<string, unknown>;

const categories = new Set(["accommodation", "food", "activity", "transport", "misc"]);

function record(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItineraryEditValidationError(message);
  return value as JsonRecord;
}

function finiteMoney(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    throw new ItineraryEditValidationError("Activity cost must be between PHP 0 and PHP 10,000,000.");
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

function activityInput(value: unknown, travelers: number): JsonRecord {
  const activity = record(value, "Every activity must be structured data.");
  const category = typeof activity.category === "string" && categories.has(activity.category) ? activity.category : "activity";
  const estimatedCost = finiteMoney(activity.estimatedCost);
  const imageUrl = optionalImage(activity.imageUrl);
  return {
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

function activitiesFromDay(value: unknown, travelers: number): JsonRecord[] {
  const day = record(value, "Every itinerary day must be structured data.");
  if (!Array.isArray(day.activities)) throw new ItineraryEditValidationError("Every itinerary day must contain an activities list.");
  if (day.activities.length > 8) throw new ItineraryEditValidationError("A day can contain at most 8 activities.");
  return day.activities.map((activity) => activityInput(activity, travelers));
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

  const days = existing.days.map((storedDay, index) => {
    const day = record(storedDay, "The saved itinerary contains an invalid day.");
    const activities = activitiesFromDay(submittedDays[index], travelers);
    const activityTotal = activities.reduce((sum, activity) => sum + Number(activity.estimatedCost), 0);
    const rideFare = activities.filter((activity) => activity.category === "transport").reduce((sum, activity) => sum + Number(activity.estimatedCost), 0);
    return {
      ...day,
      activities,
      rideFare: Math.round(rideFare * 100) / 100,
      totalCost: Math.round((activityTotal + (index < nights ? nightlyRate : 0)) * 100) / 100,
    };
  });

  const plannedSpend = Math.round(days.reduce((sum, day) => sum + Number(day.totalCost), 0) * 100) / 100;
  const accommodationTotal = Math.round(nightlyRate * nights * 100) / 100;
  const remainingBudget = Math.max(0, Math.round((budget - plannedSpend) * 100) / 100);
  const shortfall = Math.max(0, Math.round((plannedSpend - budget) * 100) / 100);
  const previousBudget = existing.budgetSummary && typeof existing.budgetSummary === "object" && !Array.isArray(existing.budgetSummary) ? existing.budgetSummary as JsonRecord : {};
  const previousSharing = existing.costSharing && typeof existing.costSharing === "object" && !Array.isArray(existing.costSharing) ? existing.costSharing as JsonRecord : {};
  const wholePlannedSpend = Math.max(0, Math.round(plannedSpend));
  const wholeAccommodation = Math.max(0, Math.round(accommodationTotal));
  const wholeRemaining = Math.max(0, Math.round(remainingBudget));
  const reserve = safeNumber(previousBudget.reserve);
  const budgetOptimization = buildBudgetOptimization({
    budget,
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

  return {
    ...existing,
    totalBudget: budget,
    travelers,
    manuallyEdited: true,
    days,
    budgetOptimization,
    budgetSummary: { ...previousBudget, total: budget, plannedSpend, remainingBudget, shortfall },
    costSharing: {
      ...previousSharing,
      travelers,
      groupBudget: budget,
      plannedGroupSpend: plannedSpend,
      budgetShares: allocateEqualShares(Math.round(budget), travelers),
      plannedSpendShares: allocateEqualShares(wholePlannedSpend, travelers),
      accommodationShares: allocateEqualShares(wholeAccommodation, travelers),
      reserveShares: allocateEqualShares(wholeRemaining, travelers),
    },
  };
}
