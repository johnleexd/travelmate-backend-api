import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { hasValidCurrencyPrecision } from '../../schemas/domain.ts';
import { priceEvidenceSchema } from './grounding-schema.ts';
import { calculateExpense, refreshGroundedTotals } from './grounded-plan.ts';
import { expenseLedger, isDailyExpenseAllowance, accommodationNights } from '../../lib/expense-ledger.ts';

/** Called only by an explicit update, never a trip read. Historical provider
 * objects stay intact; a user estimate takes precedence in planning totals. */
export function applyExpenseEdits(plan: ItineraryResponse, raw: unknown): ItineraryResponse {
  if (raw === undefined) return plan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid expense estimates.');
  const input = raw as Record<string, unknown>;
  if (!Object.keys(input).length) return plan;
  const allowed = ['rooms', 'nightlyRoomEstimate', 'foodDailyPerPerson', 'transportFare', 'transportFareType', 'fees', 'contingencyPercent'];
  for (const [key,value] of Object.entries(input)) {
    if (!allowed.includes(key)) throw Error('Unknown expense estimate.');
    if (key === 'transportFareType') { if (!['shared-fare','per-person'].includes(String(value))) throw Error('Invalid transport estimate basis.'); }
    else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'rooms' ? 20 : key === 'contingencyPercent' ? 50 : 10000000) || key === 'rooms' && (!Number.isInteger(value) || value < 1) || !hasValidCurrencyPrecision(value, plan.currency)) throw Error('Invalid estimate amount or currency precision.');
  }
  const result = structuredClone(plan), travelers = plan.travelers || 1;
  const evidence = (amount: number, quantity: number, unit: 'per-room-night' | 'daily-per-person' | 'shared-fare' | 'per-person', basis: string) => priceEvidenceSchema.parse({ status: 'estimate', currency: plan.currency, source: 'user-entered', basis, fetchedAt: new Date().toISOString(), unitAmount: amount, quantity, participants: travelers, unit, needsConfirmation: true });
  if (input.rooms !== undefined && input.nightlyRoomEstimate === undefined && Number(input.rooms) !== plan.grounding?.rooms) {
    if (!result.grounding || result.grounding.accommodation.status === 'provider-quote') throw Error('Enter a nightly estimate when changing the room count for a recorded property price.');
    result.grounding.rooms = Number(input.rooms);
    result.grounding.accommodation.quantity = Number(input.rooms) * accommodationNights(plan);
    result.grounding.categories.accommodation = calculateExpense(result.grounding.accommodation.unitAmount,result.grounding.accommodation.quantity,travelers,'per-room-night',plan.currency);
  }
  if (input.nightlyRoomEstimate !== undefined) {
    const nights = accommodationNights(plan);
    const rooms = Number(input.rooms ?? plan.grounding?.rooms ?? plan.accommodation?.rooms ?? Math.ceil(travelers / 2));
    result.accommodationEstimate = evidence(Number(input.nightlyRoomEstimate), rooms * nights, 'per-room-night', `User-entered room/night estimate × ${rooms} room(s) × ${nights} stay-date night(s). Historical property quotes are retained separately.`);
    if (result.grounding) { result.grounding.rooms = rooms; result.grounding.nights = nights; result.grounding.accommodation = result.accommodationEstimate; result.grounding.categories.accommodation = calculateExpense(Number(input.nightlyRoomEstimate),rooms*nights,travelers,'per-room-night',plan.currency); }
  }
  for (const [field, category] of [['foodDailyPerPerson','food'],['transportFare','transport']] as const) if (input[field] !== undefined) {
    for (const day of result.days) {
      const unit = category === 'food' ? 'daily-per-person' : input.transportFareType === 'per-person' ? 'per-person' : 'shared-fare';
      const price = { ...evidence(Number(input[field]), 1, unit, 'User-entered daily planning envelope. Itemized expenses use this allowance first; counted once.'), coverage: category === 'food' ? 'daily-food' as const : 'daily-transport' as const };
      const item = { title: category === 'food' ? 'Daily meals allowance' : 'Daily transport allowance', time: 'Daily allowance', description: 'Editable daily planning estimate.', category, icon: category, estimatedCost: calculateExpense(price.unitAmount,1,travelers,unit,plan.currency), unitCost: price.unitAmount, priceEvidence: price };
      const index = day.activities.findIndex(activity => activity.category === category && isDailyExpenseAllowance(activity));
      if (index >= 0) day.activities[index] = { ...day.activities[index], estimatedCost: item.estimatedCost, unitCost: item.unitCost, priceEvidence: price };
      else { if (day.activities.length >= 8) throw Error('This day is full. Edit an existing expense instead.'); day.activities.push(item); }
    }
  }
  if (result.grounding) {
    if (input.fees !== undefined) result.grounding.additionalFees = Number(input.fees);
    if (input.contingencyPercent !== undefined) result.grounding.contingencyPercent = Number(input.contingencyPercent);
    result.grounding.estimationVersion = 'planning-v1';
    return refreshGroundedTotals(result);
  }
  const review = expenseLedger(result);
  result.days = result.days.map((day,index)=>({ ...day, totalCost: review.days[index].amount ?? 0 }));
  result.budgetSummary = { ...result.budgetSummary, plannedSpend: review.total ?? 0, remainingBudget: Math.max(0,review.remaining ?? 0), shortfall: Math.max(0,-(review.remaining ?? 0)) };
  return result;
}
