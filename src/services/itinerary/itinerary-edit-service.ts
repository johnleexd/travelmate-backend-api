import { validateActivitySchedule } from './activity-schedule.ts';
import { allocateEqualShares, allocateNightlyCosts, formatMoney, hasValidCurrencyPrecision, roundMoney, sumMoney, type CurrencyCode } from "../../schemas/domain.ts";
import { ItineraryEditValidationError } from "../../exceptions/index.ts";
import { buildBudgetOptimization } from "../budget/budget-optimization-service.ts";
import { refreshGroundedTotals } from './grounded-plan.ts';
import { expenseLedger } from '../../lib/expense-ledger.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { canonicalStoredMedia } from '../../lib/stored-trip-media.ts';
import { cachedActivityPhoto } from './activity-photo-fallback.ts';

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
  if (!hasValidCurrencyPrecision(amount,currency)) throw new ItineraryEditValidationError("Activity cost has invalid currency precision.");
  return roundMoney(amount,currency);
}

function text(value: unknown, field: string, maximum: number, required = false): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if ((required && !normalized) || normalized.length > maximum) {
    throw new ItineraryEditValidationError(`${field} ${required ? "is required and " : ""}must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function activityInput(value: unknown, travelers: number, currency: CurrencyCode, stored: JsonRecord[] = [], grounded = false): JsonRecord {
  const activity = canonicalStoredMedia(record(value, "Every activity must be structured data."), true);
  const category = typeof activity.category === "string" && categories.has(activity.category) ? activity.category : "activity";
  const estimatedCost = finiteMoney(activity.estimatedCost, currency);
  const managementSource = activity.id !== undefined ? stored.find(candidate => candidate.id === activity.id) : stored.find(candidate => candidate.id && ['title', 'description'].every(key => candidate[key] === activity[key]) && (candidate.location || '') === (activity.location || ''));
  if (activity.id !== undefined && !managementSource) throw new ItineraryEditValidationError('An activity identifier does not belong to this saved itinerary.');
  if (managementSource?.status === 'completed' && ['time', 'title', 'description', 'location', 'durationMinutes', 'estimatedCost', 'category'].some(key => (managementSource[key] ?? '') !== (activity[key] ?? ''))) throw new ItineraryEditValidationError('Undo completion before editing this activity. Completed records are protected.');
  if (managementSource?.status === 'completed') return structuredClone(managementSource);
  const management = managementSource ? { id: managementSource.id, status: managementSource.status, statusChangedAt: managementSource.statusChangedAt, managementHistory: managementSource.managementHistory } : {};
  const identity = (managementSource ? [managementSource] : stored).find(candidate => candidate.title === activity.title && (candidate.location || '') === (activity.location || '') && JSON.stringify(candidate.place) === JSON.stringify(activity.place));
  const original = identity && identity.estimatedCost === activity.estimatedCost && identity.category === activity.category ? identity : undefined;
  const timing = { ...(activity.durationMinutes !== undefined || identity?.durationMinutes !== undefined ? { durationMinutes: Number(activity.durationMinutes ?? identity?.durationMinutes) } : {}), ...(activity.travelMinutes !== undefined ? { travelMinutes: Number(activity.travelMinutes) } : {}), ...(activity.location !== undefined ? { location: text(activity.location, 'Activity location', 200) } : {}) };
  if (grounded) {
    const result = {
      ...timing, ...management,
      ...(identity && identity.time === activity.time && identity.durationMinutes === activity.durationMinutes ? { scheduleLabel: identity.scheduleLabel } : {}),
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
    ...timing, ...management,
    time: text(activity.time, "Activity time", 30) || "Flexible",
    title: text(activity.title, "Activity title", 160, true),
    description: text(activity.description, "Activity description", 1_000),
    estimatedCost,
    unitCost: original?.unitCost ?? estimatedCost,
    ...(original?.priceEvidence ? { priceEvidence: original.priceEvidence } : !original ? { priceEvidence: { status: 'estimate', basis: 'User-entered whole-group estimate after editing.', source: 'user-entered', fetchedAt: new Date().toISOString(), currency, unitAmount: estimatedCost, quantity: 1, unit: 'group', participants: travelers, needsConfirmation: true } } : {}),
    category,
    icon: category,
    ...(identity ? { imageUrl: identity.imageUrl, imageAttribution: identity.imageAttribution } : {}),
  };
}

function activitiesFromDay(value: unknown, travelers: number, currency: CurrencyCode, stored: JsonRecord[] = [], grounded = false, transportation?: string): JsonRecord[] {
  const day = record(value, "Every itinerary day must be structured data.");
  if (!Array.isArray(day.activities)) throw new ItineraryEditValidationError("Every itinerary day must contain an activities list.");
  if (day.activities.length > 8) throw new ItineraryEditValidationError("A day can contain at most 8 activities.");
  try { return validateActivitySchedule(day.activities.map((activity) => activityInput(activity, travelers, currency, stored, grounded)) as unknown as import('../../controllers/itinerary-controller.ts').DayActivity[], transportation) as unknown as JsonRecord[]; }
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
  const allStored = existing.days.flatMap(value => Array.isArray((value as JsonRecord).activities) ? ((value as JsonRecord).activities as JsonRecord[]).map(activity => canonicalStoredMedia(activity, true)) : []);
  const allSubmitted = submittedDays.flatMap(value => Array.isArray((value as JsonRecord).activities) ? (value as JsonRecord).activities as JsonRecord[] : []);
  const ids = allSubmitted.flatMap(activity => typeof activity.id === 'string' ? [activity.id] : []);
  if (new Set(ids).size !== ids.length) throw new ItineraryEditValidationError('Duplicate activity identifiers are not allowed.');
  for (const activity of allStored) if (activity.id && ['completed', 'skipped'].includes(String(activity.status)) && !allSubmitted.some(item => item.id === activity.id || !item.id && item.title === activity.title && item.description === activity.description)) throw new ItineraryEditValidationError('Completed and skipped activities must remain recorded. Undo their status before removing them.');

  const accommodation = existing.accommodation && typeof existing.accommodation === "object" && !Array.isArray(existing.accommodation)
    ? existing.accommodation as JsonRecord
    : undefined;
  const nightlyRate = safeNumber(accommodation?.nightlyRate);
  const nights = Math.min(expectedDays, Math.floor(safeNumber(accommodation?.nights)));
  const grounding = existing.grounding as ItineraryResponse['grounding'];
  const accommodationTotal = accommodation ? safeNumber(accommodation.quotedTotal ?? roundMoney(nightlyRate * nights,currency)) : grounding?.categories.accommodation ?? 0;
  const lodgingNights = nights || grounding?.nights || 0;
  const lodgingByNight = lodgingNights ? allocateNightlyCosts(accommodationTotal, lodgingNights, currency) : [];

  const days = existing.days.map((storedDay, index) => {
    const day = canonicalStoredMedia(record(storedDay, "The saved itinerary contains an invalid day."));
    const activities = activitiesFromDay(submittedDays[index], travelers, currency, allStored, Boolean(grounding), (existing.preferences as ItineraryResponse['preferences'])?.transportation);
    // Only adopt provider selections from our cache, never arbitrary client URLs.
    // Cache access is synchronous: saving never waits for an image search.
    for (const activity of activities) if (!activity.imageUrl) {
      const photo = cachedActivityPhoto(activity as unknown as import('../../controllers/itinerary-controller.ts').DayActivity, String(existing.destination));
      if (photo) Object.assign(activity, photo);
    }
    if (grounding && activities.some(activity => activity.category === 'accommodation')) throw new ItineraryEditValidationError('Accommodation is already calculated from rooms and nights. Add any extra one-off lodging charge as a miscellaneous expense to avoid counting the stay twice.');
    if (accommodation) for (const activity of activities) {
      if (activity.category === 'accommodation') { activity.unitCost = 0; activity.estimatedCost = 0; }
    }
    const activityTotal = sumMoney(activities.map(activity => Number(activity.estimatedCost)),currency);
    const rideFare = sumMoney(activities.filter(activity => activity.category === "transport").map(activity => Number(activity.estimatedCost)),currency);
    const removedCover = day.imageUrl && allStored.some(activity => activity.imageUrl === day.imageUrl)
      && !activities.some(activity => activity.imageUrl === day.imageUrl);
    const cover = removedCover ? activities.find(activity => activity.imageUrl) : undefined;
    return {
      ...day,
      ...(removedCover ? { imageUrl: cover?.imageUrl || '', imageAttribution: cover?.imageAttribution } : {}),
      activities,
      rideFare: roundMoney(rideFare,currency),
      totalCost: sumMoney([activityTotal,lodgingByNight[index] || 0],currency),
    };
  });

  const selectedTravelCosts = existing.selectedTravelCosts && typeof existing.selectedTravelCosts === 'object' && !Array.isArray(existing.selectedTravelCosts) ? existing.selectedTravelCosts as JsonRecord : undefined;
  const review = expenseLedger({ ...existing, days } as unknown as ItineraryResponse);
  const plannedSpend = review.total ?? 0;
  for (const [index,day] of days.entries()) day.totalCost = review.days[index].amount ?? 0;
  const remainingBudget = Math.max(0, roundMoney(budget-plannedSpend,currency));
  const shortfall = Math.max(0, roundMoney(plannedSpend-budget,currency));
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
      partyType: existing.partyType ?? (travelers === 1 ? 'solo' : travelers === 2 ? 'couple' : 'friends'),
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
