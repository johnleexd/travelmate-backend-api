import assert from "node:assert/strict";
import test from "node:test";
import { ItineraryEditValidationError } from "../src/exceptions/index.ts";
import { applyManualItineraryChanges } from "../src/services/itinerary/itinerary-edit-service.ts";

const saved = {
  destination: "Cebu",
  totalBudget: 10_000,
  accommodation: { name: "Test stay", nightlyRate: 1_000, nights: 1, total: 1_000 },
  budgetSummary: { total: 10_000, reserve: 1_000 },
  costSharing: { partyType: "couple" },
  days: [
    { day: 1, date: "2026-10-01", totalCost: 1_300, activities: [{ time: "09:00", title: "Old", description: "", category: "activity", estimatedCost: 300 }] },
    { day: 2, date: "2026-10-02", totalCost: 400, activities: [{ time: "10:00", title: "Old two", description: "", category: "food", estimatedCost: 400 }] },
  ],
};

test("manual itinerary changes recalculate daily and trip totals", () => {
  const result = applyManualItineraryChanges(saved, {
    days: [
      { activities: [{ time: "08:00", title: "Jeepney ride", description: "Transfer", category: "transport", estimatedCost: 500 }] },
      { activities: [{ time: "12:00", title: "Lunch", description: "Local meal", category: "food", estimatedCost: 600 }] },
    ],
  }, 2, 10_000, 2);
  const days = result.days as Array<Record<string, unknown>>;
  assert.equal(days[0].rideFare, 500);
  assert.equal(days[0].totalCost, 1_500);
  assert.equal(days[1].totalCost, 600);
  assert.equal((result.budgetSummary as Record<string, unknown>).plannedSpend, 2_100);
  assert.equal((result.costSharing as Record<string, unknown>).plannedGroupSpend, 2_100);
  assert.deepEqual((result.costSharing as Record<string, unknown>).plannedSpendShares, [1_050, 1_050]);
  assert.equal(result.manuallyEdited, true);
});

test("manual itinerary changes support empty days and preserve server metadata", () => {
  const result = applyManualItineraryChanges(saved, { days: [{ activities: [] }, { activities: [] }] }, 2, 10_000, 2);
  const days = result.days as Array<Record<string, unknown>>;
  assert.equal(result.destination, "Cebu");
  assert.equal(days[0].totalCost, 1_000);
  assert.equal(days[1].totalCost, 0);
});

test("manual itinerary changes reject invalid activity data and day counts", () => {
  assert.throws(() => applyManualItineraryChanges(saved, { days: [] }, 2, 10_000, 2), ItineraryEditValidationError);
  assert.throws(() => applyManualItineraryChanges(saved, { days: [{ activities: [{ title: "", estimatedCost: 1 }] }, { activities: [] }] }, 2, 10_000, 2), ItineraryEditValidationError);
  assert.throws(() => applyManualItineraryChanges(saved, { days: [{ activities: Array.from({ length: 9 }, () => ({ title: "Too many", estimatedCost: 1 })) }, { activities: [] }] }, 2, 10_000, 2), ItineraryEditValidationError);
});

test("manual itinerary changes recalculate canonical budget alternatives", () => {
  const result = applyManualItineraryChanges(saved, {
    days: [
      { activities: [{ time: "08:00", title: "Premium tour", description: "Guided", category: "activity", estimatedCost: 10_000 }] },
      { activities: [{ time: "12:00", title: "Lunch", description: "Local meal", category: "food", estimatedCost: 2_000 }] },
    ],
  }, 2, 10_000, 2);
  const optimization = result.budgetOptimization as Record<string, unknown>;
  assert.equal(optimization.status, "over_budget");
  assert.ok(Number(optimization.amountToTarget) > 0);
  assert.ok(Array.isArray(optimization.suggestions));
});
