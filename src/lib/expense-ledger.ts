import type { ItineraryResponse, DayActivity } from '../controllers/itinerary-controller.ts';
import { allocateEqualShares, allocateNightlyCosts, currencyFractionDigits, travelersForParty, type CurrencyCode, type PartyType } from '../schemas/domain.ts';

type CategoryKey = 'accommodation' | 'food' | 'transportation' | 'activities' | 'other' | 'contingency';
export type BudgetCategory = {
  key: CategoryKey; label: string; amount: number | null; percentage: number | null;
  status: 'estimated' | 'partial' | 'unavailable' | 'excluded'; allowance: number;
};
export type AccommodationPreview = { selected: boolean; name?: string; amount?: number; currency?: CurrencyCode };
export type BudgetReviewOptions = { budget?: number; accommodation?: AccommodationPreview; party?: { partyType: PartyType; travelers: number } };
type ExpenseUnit = NonNullable<DayActivity['priceEvidence']>['unit'];
export const isPerPersonUnit = (unit: ExpenseUnit) => ['per-person', 'daily-per-person', 'meal'].includes(unit);
/** Unit rates are extended here only. Saved estimatedCost is already extended. */
export function calculateExpense(unitAmount: number, quantity: number, participants: number, unit: ExpenseUnit, currency: CurrencyCode) {
  if (!['per-person','daily-per-person','meal','shared-fare','per-room-night','group','day','night','room','transport-leg'].includes(unit)) throw new Error('Expense basis is unavailable.');
  if (![unitAmount, quantity, participants].every(Number.isFinite) || unitAmount < 0 || !Number.isInteger(quantity) || quantity < 0 || !Number.isInteger(participants) || participants < 1 || participants > 20) throw new Error('Expense quantities are invalid.');
  const scale = 10 ** currencyFractionDigits(currency);
  return Math.round(unitAmount * quantity * (isPerPersonUnit(unit) ? participants : 1) * scale) / scale;
}
/** Recorded metadata only: never infer a party mode from its size. */
export function itineraryParty(plan: ItineraryResponse) {
  const partyType = plan.partyType ?? plan.costSharing?.partyType;
  const travelers = plan.travelers ?? plan.costSharing?.travelers;
  if (!partyType || travelers === undefined || !['solo','couple','family','friends'].includes(partyType)) return null;
  try { if (travelersForParty(partyType, travelers) !== travelers) return null; } catch { return null; }
  if (plan.costSharing && (plan.costSharing.partyType !== partyType || plan.costSharing.travelers !== travelers)) return null;
  return { partyType, travelers };
}
/** Shares describe planning allocations, never an invented adult/child tariff. */
export function expenseCoverage(item: DayActivity, currency: CurrencyCode) {
  const amount = activityExpense(item, currency), price = item.priceEvidence;
  if (amount === null || !price) return null;
  return { total: amount, travelers: price.participants, shares: allocateEqualShares(amount, price.participants, currency),
    equalShare: !isPerPersonUnit(price.unit) || isPlanningAllowance(item), includedElsewhere: price.quantity === 0 };
}
const validAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const labels: Record<CategoryKey, string> = { accommodation: 'Accommodation', food: 'Food', transportation: 'Transportation', activities: 'Activities', other: 'Other estimates & fees', contingency: 'Contingency' };
export function accommodationNights(plan: ItineraryResponse): number {
  const quote = plan.accommodation?.providerQuote;
  if (quote) return Math.max(0,Math.round((Date.parse(quote.checkOutDate)-Date.parse(quote.checkInDate))/86400000));
  // Historical records can specify a stay beyond a day-trip itinerary. Retain
  // that explicit stay duration; otherwise use calendar-date difference.
  if (plan.accommodation?.nights !== undefined) return plan.accommodation.nights;
  const difference = (Date.parse(plan.days.at(-1)?.date || '')-Date.parse(plan.days[0]?.date || ''))/86400000;
  return Number.isFinite(difference) ? Math.max(0,Math.round(difference)) : plan.grounding?.nights ?? Math.max(0,plan.days.length-1);
}

export function isPlanningAllowance(item: DayActivity) {
  return item.priceEvidence?.status === 'allowance' || item.priceEvidence?.source === 'budget-allowance';
}
export function activityExpense(item: DayActivity, currency: CurrencyCode): number | null {
  const price = item.priceEvidence;
  if (!price || price.currency !== currency || price.status === 'unavailable' || !validAmount(item.estimatedCost)) return null;
  try {
    const expected = calculateExpense(price.unitAmount, price.quantity, price.participants, price.unit, currency);
    return Math.abs(expected - item.estimatedCost) < 1 / 10 ** currencyFractionDigits(currency) ? item.estimatedCost : null;
  } catch { return null; }
}
export function isDailyExpenseAllowance(item: DayActivity) {
  return Boolean(item.priceEvidence?.coverage || !item.place && !item.location?.trim()
    && (/^daily\s+(?:meals?|food|transport)/i.test(item.title) || /^(daily allowance|daily budget)$/i.test(item.time))
    && ['food', 'transport'].includes(item.category));
}
/** A daily envelope covers its category's itemized costs; only its unused
 * balance is additional. Repeated daily envelopes are alternatives, not charges. */
export function dayExpenseRows(plan: ItineraryResponse, dayIndex: number) {
  const items = plan.days[dayIndex].activities;
  const explicit = { food: 0, transport: 0 };
  for (const item of items) if (!isDailyExpenseAllowance(item) && (item.category === 'food' || item.category === 'transport')) explicit[item.category] += activityExpense(item, plan.currency) ?? 0;
  const chosen = new Map<string, DayActivity>();
  for (const item of items.filter(isDailyExpenseAllowance)) {
    const prior = chosen.get(item.category);
    if (!prior || (item.priceEvidence?.source === 'user-entered' && prior.priceEvidence?.source !== 'user-entered')
      || (item.priceEvidence?.source === prior.priceEvidence?.source && (activityExpense(item, plan.currency) ?? -1) > (activityExpense(prior, plan.currency) ?? -1))) chosen.set(item.category, item);
  }
  return items.map((item, index) => {
    const original = activityExpense(item, plan.currency);
    const daily = isDailyExpenseAllowance(item);
    const amount = original === null ? null : daily ? chosen.get(item.category) !== item ? 0 : Math.max(0, original - explicit[item.category as 'food' | 'transport']) : original;
    return { item, index, amount, allowance: isPlanningAllowance(item), covered: amount !== null && original !== amount };
  });
}

/** Read group expense amounts, never the budget-allocation targets in budgetSummary. */
export function expenseLedger(plan: ItineraryResponse, options: BudgetReviewOptions = {}) {
  const party = itineraryParty(plan);
  const partyDraft = Boolean(options.party && (!party || options.party.partyType !== party.partyType || options.party.travelers !== party.travelers));
  let needsBudgetRefresh = !party || plan.days.some(day => day.activities.some(item => !item.priceEvidence || item.priceEvidence.participants !== party.travelers
    || item.priceEvidence.status !== 'unavailable' && item.priceEvidence.currency === plan.currency && activityExpense(item, plan.currency) === null));
  const stayBasis = plan.accommodationEstimate ?? plan.grounding?.accommodation;
  if (party && stayBasis && stayBasis.participants !== party.travelers) needsBudgetRefresh = true;
  const occupancy = plan.accommodation?.providerQuote?.occupancy;
  if (party && occupancy && occupancy.reduce((sum, room) => sum + room.adults + room.childAges.length, 0) !== party.travelers) needsBudgetRefresh = true;
  const scale = 10 ** currencyFractionDigits(plan.currency);
  const round = (value: number) => Math.round(value * scale) / scale;
  const buckets = Object.fromEntries(Object.keys(labels).map(key => [key, { units: 0, priced: 0, missing: 0, allowance: 0 }])) as Record<CategoryKey, { units: number; priced: number; missing: number; allowance: number }>;
  let mixedCurrency = false, inconsistent = false;
  const add = (key: CategoryKey, value: unknown, currency: string = plan.currency, unavailable = false, allowance = false) => {
    const bucket = buckets[key];
    if (currency !== plan.currency) mixedCurrency = true;
    if (unavailable || currency !== plan.currency || !validAmount(value)) { bucket.missing++; return; }
    bucket.units += Math.round(value * scale); bucket.priced++;
    if (allowance) bucket.allowance += Math.round(value * scale);
  };
  const grounding = plan.grounding?.currency === plan.currency ? plan.grounding : undefined;
  const stayEstimate = plan.accommodationEstimate;
  if (plan.grounding && !grounding) mixedCurrency = true;
  const stay = plan.accommodation;
  const recordedStayTotal = (stayEstimate ? stayEstimate.unitAmount * stayEstimate.quantity : undefined) ?? (grounding?.estimationVersion && grounding.accommodation.status !== 'unavailable' ? grounding.categories.accommodation : undefined) ?? stay?.quotedTotal ?? stay?.total
    ?? (grounding?.accommodation.status !== 'unavailable' ? grounding?.categories.accommodation : undefined)
    ?? (stay && validAmount(stay.nightlyRate) && validAmount(stay.nights) ? round(stay.nightlyRate * stay.nights * (stay.rooms ?? 1)) : undefined);
  const lodgingItems = plan.days.flatMap(day => day.activities).filter(item => item.category === 'accommodation');
  const selectedAccommodation = options.accommodation?.selected ?? Boolean(stayEstimate || stay || plan.plannedAccommodation || grounding?.accommodation.status === 'allowance' || grounding?.accommodation.source === 'user-entered' || lodgingItems.some(item => item.estimatedCost > 0));
  const accommodationName = options.accommodation?.name ?? stay?.name ?? plan.plannedAccommodation?.name;
  if (options.accommodation) {
    if (selectedAccommodation) add('accommodation', options.accommodation.amount, options.accommodation.currency);
  } else if (stayEstimate) add('accommodation', recordedStayTotal, stayEstimate.currency, stayEstimate.status === 'unavailable', stayEstimate.status === 'allowance');
  else if (selectedAccommodation && (stay || plan.plannedAccommodation)) {
    add('accommodation', recordedStayTotal, stay?.currency ?? grounding?.accommodation.currency,
      (grounding?.accommodation.status !== 'allowance' && grounding?.accommodation.source !== 'user-entered' && (stay?.isLive === false || stay?.providerQuote?.isLive === false)) || grounding?.accommodation.status === 'unavailable'
      || recordedStayTotal === 0 && !grounding && stay?.quotedTotal === undefined && !stay?.providerQuote, grounding?.accommodation.status === 'allowance');
  }
  else if (!options.accommodation && grounding?.estimationVersion && grounding.nights > 0) add('accommodation', recordedStayTotal, grounding.accommodation.currency, grounding.accommodation.status === 'unavailable', grounding.accommodation.status === 'allowance');
  const dayRows = plan.days.map((_, index) => dayExpenseRows(plan, index));
  for (const rows of dayRows) for (const { item, amount, allowance } of rows) {
    const key: CategoryKey = item.category === 'transport' ? 'transportation' : item.category === 'activity' ? 'activities' : ['accommodation','food'].includes(item.category) ? item.category as 'accommodation' | 'food' : 'other';
    // A selected stay is allocated into day totals already. Never add it again.
    if (key === 'accommodation' && (stay || plan.plannedAccommodation || options.accommodation)) continue;
    if (key === 'accommodation' && !selectedAccommodation) continue;
    const price = item.priceEvidence;
    // estimatedCost is already the extended group amount, including its recorded
    // daily/participant/shared-fare basis. quantity=0 is included in selected costs.
    add(key, amount, price?.currency, amount === null, allowance);
  }
  const selected = plan.selectedTravelCosts;
  if (selected?.flight) add('transportation', selected.flight.total, selected.flight.currency, selected.flight.isLive === false);
  const selectedIds = new Set<string>();
  for (const item of selected?.activities ?? []) { if (selectedIds.has(item.id)) continue; selectedIds.add(item.id); add('activities', item.total, item.currency, item.isLive === false); }
  const preTrip = selected?.preTrip;
  if (preTrip) {
    const transfers = preTrip.airportTransferOutbound + preTrip.airportTransferReturn;
    const other = preTrip.passport + preTrip.visaOrAuthorization + preTrip.departureTaxes + preTrip.insurance + preTrip.other;
    if (transfers > 0) add('transportation', transfers, preTrip.currency);
    if (other > 0) add('other', other, preTrip.currency);
    if (!validAmount(transfers) || !validAmount(other)) buckets.other.missing++;
  }
  if (selected && !selected.flight && !selected.activities.length && !preTrip && selected.total > 0) buckets.other.missing++;
  if (grounding && grounding.additionalFees > 0) add('other', grounding.additionalFees);
  // Older day totals can include additional recorded costs. Remove the original
  // lodging allocation before reconciling; a draft stay change must not restore it.
  const legacyExtras: number[] = [];
  if (!grounding) {
    let lodging: number[] = [];
    const nights = stay?.nights ?? plan.grounding?.nights ?? 0;
    const allocated = stay?.quotedTotal ?? stay?.total ?? (stay ? round(stay.nightlyRate * stay.nights * (stay.rooms ?? 1)) : undefined) ?? plan.budgetSummary?.accommodationActual;
    if (nights && validAmount(allocated)) {
      try { lodging = allocateNightlyCosts(allocated, nights, plan.currency); } catch { inconsistent = true; }
    }
    plan.days.forEach((day, index) => {
      const items = day.activities.reduce((sum, item) => sum + (validAmount(item.estimatedCost) ? item.estimatedCost : 0), 0);
      if (!validAmount(day.totalCost)) { inconsistent = true; return; }
      const removedOverlap = items - dayRows[index].reduce((sum,row)=>sum+(row.amount ?? 0),0);
      const rawRemainder = round(day.totalCost - items - (lodging[index] ?? 0));
      const remainder = rawRemainder < 0 && Math.abs(rawRemainder + removedOverlap) < 1 / scale ? 0 : rawRemainder;
      legacyExtras[index] = remainder;
      // A historical remainder has no unit/party basis. Retain the record, but
      // do not reinterpret it as a known party expense.
      if (remainder > 0) { legacyExtras[index] = 0; buckets.other.missing++; needsBudgetRefresh = true; }
      if (remainder < 0) { inconsistent = true; legacyExtras[index] = 0; }
    });
  }
  for (const key of ['food', 'transportation', 'activities'] as const) if (!buckets[key].priced && !buckets[key].missing) buckets[key].missing++;
  const subtotalUnits = Object.values(buckets).reduce((sum, bucket) => sum + bucket.units, 0);
  if (grounding && grounding.contingencyPercent > 0 && Object.values(buckets).some(bucket => bucket.priced > 0)) add('contingency', round(subtotalUnits / scale * grounding.contingencyPercent / 100), plan.currency, false, true);
  const totalUnits = Object.values(buckets).reduce((sum, bucket) => sum + bucket.units, 0);
  const hasPrices = Object.values(buckets).some(bucket => bucket.priced > 0);
  const total = hasPrices ? totalUnits / scale : null;
  const budgetValue = options.budget ?? plan.totalBudget;
  const budget = validAmount(budgetValue) && budgetValue > 0 ? round(budgetValue) : null;
  const nights = accommodationNights(plan);
  const incomplete = Object.values(buckets).some(bucket => bucket.missing > 0)
    || Boolean(grounding && !grounding.estimationVersion && grounding.unpricedExpenseCount)
    || Boolean(grounding && (!grounding.estimationVersion || grounding.startingLocation?.trim()) && !selected?.flight && !selected?.preTrip)
    || !selectedAccommodation && nights > 0 || mixedCurrency || inconsistent || !hasPrices || needsBudgetRefresh || partyDraft;
  const remaining = budget !== null && total !== null ? round(budget - total) : null;
  const categories = (Object.keys(labels) as CategoryKey[]).filter(key => !['other', 'contingency'].includes(key) || buckets[key].units > 0 || buckets[key].missing > 0).map((key): BudgetCategory => {
    const bucket = buckets[key], excluded = key === 'accommodation' && !selectedAccommodation;
    return { key, label: labels[key], amount: excluded || !bucket.priced ? null : bucket.units / scale,
      percentage: !excluded && bucket.priced && totalUnits > 0 ? bucket.units / totalUnits * 100 : null,
      status: excluded ? 'excluded' : !bucket.priced ? 'unavailable' : bucket.missing ? 'partial' : 'estimated', allowance: excluded ? 0 : bucket.allowance / scale };
  });
  const accommodationAmount = categories.find(item => item.key === 'accommodation')?.amount;
  const nightly = nights && validAmount(accommodationAmount) ? allocateNightlyCosts(accommodationAmount, nights, plan.currency) : [];
  const days = dayRows.map((rows, index) => {
    const priced = rows.filter(row => row.amount !== null && !(row.item.category === 'accommodation' && (stay || grounding)));
    const amount = round(priced.reduce((sum, row) => sum + row.amount!, 0) + (nightly[index] ?? 0) + (legacyExtras[index] ?? 0));
    const missing = rows.filter(row => row.amount === null).length + (index < nights && accommodationAmount == null ? 1 : 0);
    return { amount: priced.length || nightly[index] !== undefined || legacyExtras[index] ? amount : null, unpriced: missing,
      allowance: round(priced.filter(row => row.allowance).reduce((sum, row) => sum + row.amount!, 0) + (grounding?.accommodation.status === 'allowance' ? nightly[index] ?? 0 : 0)), rows };
  });
  const allowanceTotal = round(categories.reduce((sum, item) => sum + item.allowance, 0));
  const unpriced = Object.values(buckets).reduce((sum, bucket) => sum + bucket.missing, 0) + (grounding && (!grounding.estimationVersion || grounding.startingLocation?.trim()) && !selected?.flight && !selected?.preTrip ? 1 : 0);
  return { currency: plan.currency, budget, total, remaining, categories, incomplete, mixedCurrency, inconsistent,
    party, partyDraft, needsBudgetRefresh, shares: total !== null && party && !needsBudgetRefresh && !partyDraft ? allocateEqualShares(total, party.travelers, plan.currency) : null,
    days, allowanceTotal, unpriced,
    selectedAccommodation, accommodationName, nights,
    budgetDraft: budget !== null && budget !== plan.totalBudget,
    accommodationDraft: options.accommodation !== undefined,
    status: remaining !== null && remaining < 0 ? 'over-budget' as const : incomplete || remaining === null ? 'incomplete' as const : 'within-budget' as const };
}
