import { createHmac } from 'node:crypto';
import { allocateEqualShares, allocateNightlyCosts, currencyFractionDigits, type CurrencyCode, type PartyType } from '../../schemas/domain.ts';
import { constantTimeEqual } from '../../utils/constant-time-equal.ts';
import type { AccommodationPlan, DayActivity, ItineraryResponse, SelectedTravelCosts } from '../../controllers/itinerary-controller.ts';
import type { GroundedScheduleDay } from '../ai/grounded-schedule.ts';
import type { GroundedPlace } from './grounded-places.ts';
import { distanceKm } from './grounded-places.ts';
import { groundingSchema, type DestinationAnchor, type PlanGrounding, type PriceEvidence } from './grounding-schema.ts';
import { buildBudgetOptimization } from '../budget/budget-optimization-service.ts';

export interface GroundedPlanInput {
  pace?: 'relaxed' | 'balanced' | 'active';
  destination: string; anchor: DestinationAnchor; startingLocation: string; startDate: string; endDate: string;
  budget: number; currency: CurrencyCode; travelers: number; partyType: PartyType; rooms: number;
  places: GroundedPlace[]; placeDataStatus: PlanGrounding['placeDataStatus']; schedule: GroundedScheduleDay[];
  accommodation?: AccommodationPlan; selectedTravelCosts?: SelectedTravelCosts;
  source: 'openai' | 'gemini' | 'mock'; transportation: string;
  foodDailyPerPerson?: number; transportFare?: number; transportFareType?: 'shared-fare' | 'per-person';
  nightlyRoomEstimate?: number; fees?: number; contingencyPercent?: number;
}

const moneyRound = (amount: number, currency: CurrencyCode) => Math.round(amount * 10 ** currencyFractionDigits(currency)) / 10 ** currencyFractionDigits(currency);
const minutesTime = (minutes: number) => `${String(Math.floor(minutes / 60) % 12 || 12).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${minutes >= 720 ? 'PM' : 'AM'}`;
export function calculateExpense(unitAmount: number, quantity: number, participants: number, unit: PriceEvidence['unit'], currency: CurrencyCode) {
  if (![unitAmount, quantity, participants].every(Number.isFinite) || unitAmount < 0 || !Number.isInteger(quantity) || quantity < 0 || !Number.isInteger(participants) || participants < 1) throw new Error('Expense quantities are invalid.');
  return moneyRound(unitAmount * quantity * (unit === 'per-person' || unit === 'daily-per-person' ? participants : 1), currency);
}

export function buildGroundedPlan(input: GroundedPlanInput): ItineraryResponse {
  const { currency, travelers, budget, rooms } = input;
  const fetchedAt = new Date().toISOString();
  const count = input.schedule.length;
  const nights = input.accommodation?.nights ?? Math.max(0, count - 1);
  const round = (value: number) => moneyRound(value, currency);
  const foodDaily = input.foodDailyPerPerson ?? round(budget * 0.22 / travelers / count);
  const nightlyRoom = input.nightlyRoomEstimate ?? (nights ? round(budget * 0.34 / nights / rooms) : 0);
  const stayTotal = input.accommodation?.total ?? calculateExpense(nightlyRoom, nights * rooms, travelers, 'per-room-night', currency);
  const accommodationEvidence: PriceEvidence = {
    status: ['amadeus', 'expedia-rapid', 'liteapi'].includes(input.accommodation?.source || '') && input.accommodation?.isLive ? 'provider-quote' : 'estimate',
    basis: !nights ? 'No overnight accommodation is included: zero nights. An overnight stay requires a separate selection and price confirmation.' : input.accommodation ? input.accommodation.source === 'liteapi' && !input.accommodation.isLive ? 'Sandbox test stay quote; not verified production prices or availability. Budget includes disclosed property-payable charges. Selecting this hotel does not reserve a room.' : ['amadeus', 'expedia-rapid', 'liteapi'].includes(input.accommodation.source || '') ? 'Provider stay quote; exact full-stay total takes precedence over nightly averages. Prices can change until booking.' : 'TravelMate listing rate; availability and real booking price need confirmation.'
      : input.nightlyRoomEstimate !== undefined ? 'User-entered nightly room estimate × rooms × nights.' : 'Planning allowance: 34% of the entered budget divided by rooms and nights. Not a researched hotel price.',
    source: input.accommodation?.source ?? (input.nightlyRoomEstimate !== undefined ? 'user-entered' : 'budget-allowance'),
    fetchedAt: input.accommodation?.fetchedAt ?? fetchedAt, currency, unitAmount: input.accommodation ? input.accommodation.total / Math.max(1, nights * rooms) : nightlyRoom,
    quantity: nights * rooms, unit: 'per-room-night', participants: travelers, needsConfirmation: true,
  };
  const makeEvidence = (amount: number, quantity: number, unit: PriceEvidence['unit'], basis: string, source = 'budget-allowance', participants = travelers): PriceEvidence => ({
    status: 'estimate', basis, source, fetchedAt, currency, unitAmount: amount, quantity, unit, participants, needsConfirmation: true,
  });
  const lodging = nights ? allocateNightlyCosts(stayTotal, nights, currency) : [];
  const totalVisits = input.schedule.reduce((sum, day) => sum + day.visits.length, 0);
  const activityAllowance = totalVisits ? round(budget * 0.20 / totalVisits / travelers) : 0;
  const fareType = input.transportFareType ?? (/taxi|ride.hailing|private|rental/i.test(input.transportation) ? 'shared-fare' : 'per-person');
  const fare = input.transportFare ?? round(budget * 0.14 / count / (fareType === 'shared-fare' ? 1 : travelers));
  const days = input.schedule.map(day => {
    let previous: GroundedPlace | undefined;
    const visits: DayActivity[] = day.visits.map(visit => {
      const place = input.places.find(candidate => candidate.placeId === visit.placeId)!;
      if (!place) throw new Error('Unsupported itinerary place.');
      const transfer = previous ? Math.ceil(distanceKm(previous, place) / 4 * 60) + (input.pace === 'relaxed' ? 30 : 15) : 0;
      previous = place;
      const commitment = input.selectedTravelCosts?.activities.find(item => item.name.normalize('NFKC').trim().toLowerCase() === place.name.normalize('NFKC').trim().toLowerCase());
      const priceEvidence: PriceEvidence = commitment ? { ...makeEvidence(commitment.unitCost, 0, 'per-person', 'Exact-name activity commitment is included once under selected travel costs, for the selected party. No second admission allowance is charged here; confirm the offer coverage and visit time.', 'selected-activity', visit.participants), status: commitment.isLive && !commitment.priceBasis ? 'provider-quote' : 'estimate', fetchedAt: commitment.fetchedAt }
        : makeEvidence(activityAllowance, 1, 'per-person', 'Planning allowance: 20% of the entered budget divided across catalog visits and participants. Admission prices are unavailable; this does not imply free entry.', 'budget-allowance', visit.participants);
      return { durationMinutes: visit.durationMinutes, travelMinutes: transfer, time: minutesTime(visit.startMinutes), title: `Visit ${place.name}`.slice(0, 160),
        description: `${place.description}. Proposed ${visit.durationMinutes}-minute visit. ${transfer ? `Allow at least ${transfer} minutes from the previous stop (straight-line walking estimate plus ${input.pace === 'relaxed' ? 30 : 15}-minute buffer; confirm the real route). ` : ''}Opening hours: ${place.openingHours}. Address: ${place.address}.`,
        category: 'activity', icon: 'map', estimatedCost: calculateExpense(priceEvidence.unitAmount, priceEvidence.quantity, visit.participants, 'per-person', currency), unitCost: priceEvidence.unitAmount,
        imageUrl: place.imageUrl, imageAttribution: place.imageAttribution, placeVerification: 'supporting-source-found',
        place: { provider: place.provider, placeId: place.placeId, name: place.name, city: place.city, country: place.country, countryCode: place.countryCode, latitude: place.latitude, longitude: place.longitude, sourceUrl: place.sourceUrl, fetchedAt: place.fetchedAt, openingHours: place.openingHours, address: place.address }, priceEvidence };
    });
    const foodEvidence = makeEvidence(foodDaily, 1, 'daily-per-person', input.foodDailyPerPerson !== undefined ? 'User-entered daily food estimate per person × travelers × days.' : 'Planning allowance: 22% of the entered budget divided by travelers and days. Restaurant/menu prices and venues are not available.', input.foodDailyPerPerson !== undefined ? 'user-entered' : 'budget-allowance');
    const food: DayActivity = { time: 'Daily allowance', title: `Daily meals in ${input.anchor.city}`.slice(0, 160), description: 'Daily allowance for all meals, not the price of one restaurant visit. Venue and menu: Not available; choose and confirm locally.', category: 'food', icon: 'food', estimatedCost: calculateExpense(foodDaily, 1, travelers, 'daily-per-person', currency), unitCost: foodDaily, priceEvidence: foodEvidence };
    const transportEvidence = makeEvidence(fare, 1, fareType, input.transportFare !== undefined ? 'User-entered daily fare estimate. Confirm fare coverage, route, vehicle capacity, tolls, and fees.' : 'Planning allowance: 14% of the entered budget divided by days and fare basis. No verified route fare is available.', input.transportFare !== undefined ? 'user-entered' : 'budget-allowance');
    const transport: DayActivity = { time: 'Daily allowance', title: `Daily transport in ${input.anchor.city}`.slice(0, 160), description: `${input.transportation || 'Mode: Not available'}. ${fareType === 'shared-fare' ? 'One shared daily fare for the party; not multiplied by travelers.' : 'Daily fare per traveler, multiplied by the party size.'} Route, timetable and capacity require confirmation.`, category: 'transport', icon: 'bus', estimatedCost: calculateExpense(fare, 1, travelers, fareType, currency), unitCost: fare, priceEvidence: transportEvidence };
    const activities = [...visits, food, transport];
    return { day: day.day, date: day.date, theme: visits.length ? `${input.anchor.city}: ${visits.map(visit => visit.place?.name).join(', ')}`.slice(0, 120) : `${input.anchor.city}: details need confirmation`,
      imageUrl: visits.find(visit => visit.imageUrl)?.imageUrl ?? '', imageAttribution: visits.find(visit => visit.imageUrl)?.imageAttribution,
      travelNote: visits.length ? 'Proposed local times. Stops checked against catalog coordinates and city/country hierarchy. Walking estimates use straight-line distance at 4 km/h plus 15 minutes; routes, access, opening hours and traffic need confirmation.' : 'No additional supported attraction data is available. Leave this day flexible; confirm venues before adding them. No invented attraction is scheduled.',
      returnToStayAt: input.accommodation ? '08:30 PM' : undefined, rideFare: transport.estimatedCost,
      totalCost: round(activities.reduce((sum, activity) => sum + activity.estimatedCost, 0) + (lodging[day.day - 1] ?? 0)), activities };
  });
  const base = round(days.reduce((sum, day) => sum + day.totalCost, 0) + (input.selectedTravelCosts?.total ?? 0) + (input.fees ?? 0));
  const contingencyPercent = input.contingencyPercent ?? 10;
  const contingency = round(base * contingencyPercent / 100);
  const plan: ItineraryResponse = {
    destination: input.destination, totalBudget: budget, currency, travelers, partyType: input.partyType, source: input.source,
    accommodation: input.accommodation, selectedTravelCosts: input.selectedTravelCosts, days,
    budgetSummary: { accommodation: stayTotal, food: round(foodDaily * travelers * count), activities: round(visitsCost(days)), transport: round(fare * count * (fareType === 'shared-fare' ? 1 : travelers)), reserve: contingency, dailyAverage: round(base / count), total: budget, accommodationActual: stayTotal, plannedSpend: base, remainingBudget: round(Math.max(0, budget - base)), shortfall: round(Math.max(0, base + contingency - budget)) },
    costSharing: { partyType: input.partyType, travelers, groupBudget: budget, plannedGroupSpend: base, budgetShares: allocateEqualShares(budget, travelers, currency), plannedSpendShares: allocateEqualShares(base, travelers, currency), accommodationShares: allocateEqualShares(stayTotal, travelers, currency), reserveShares: allocateEqualShares(Math.max(0, budget - base), travelers, currency) },
    grounding: { version: 1, destination: input.anchor, startingLocation: input.startingLocation, startDate: input.startDate, endDate: input.endDate, fetchedAt,
      placeDataStatus: input.placeDataStatus, currency, rooms, nights, foodDailyPerPerson: foodDaily, accommodation: accommodationEvidence, contingencyPercent, contingencyAmount: contingency,
      additionalFees: input.fees ?? 0, categories: { accommodation: stayTotal, food: 0, activities: 0, transportation: 0, fees: input.fees ?? 0, contingency }, subtotal: base, total: base + contingency, verifiedAmount: 0, estimatedAmount: 0, unknownPriceCount: 0, budgetStatus: 'needs-confirmation',
      limitations: [...(input.selectedTravelCosts?.activities.some(activity => activity.priceBasis) ? ['Selected activity group costs assume the provider headline fare is per person. The provider does not confirm date/party fare coverage; these multiplied amounts are estimates, even with production data.'] : []), 'Food, local transport and admission allowances are not researched market prices. Missing prices do not mean free entry.', 'Opening hours, street routes, venue access, transport capacity and unquoted taxes/fees need confirmation.', 'Proposed local visits do not incorporate verified arrival/departure or hotel check-in times; confirm those before following the first and last day schedules.', ...(!input.selectedTravelCosts?.flight ? ['Travel from the starting location to the destination is not priced; compare flights or supply pre-trip estimates.'] : []), ...(input.placeDataStatus === 'stale-cache' ? ['Place references are stale cached data; confirm all details.'] : []), ...(!input.places.length ? ['Place provider returned no city/country-validated attractions; no venues were invented.'] : [])] },
  };
  return refreshGroundedTotals(plan);
}
function visitsCost(days: ItineraryResponse['days']) { return days.flatMap(day => day.activities).filter(activity => activity.category === 'activity').reduce((sum, activity) => sum + activity.estimatedCost, 0); }

export function refreshGroundedTotals(plan: ItineraryResponse): ItineraryResponse {
  if (!plan.grounding) return plan;
  const grounding = plan.grounding;
  const round = (value: number) => moneyRound(value, plan.currency);
  const categories = { accommodation: grounding.categories.accommodation, food: 0, activities: 0, transportation: 0, fees: grounding.additionalFees, contingency: 0 };
  let verifiedAmount = grounding.accommodation.status === 'provider-quote' ? categories.accommodation : 0;
  let unknownPriceCount = (grounding.accommodation.status === 'provider-quote' ? 0 : grounding.nights ? 1 : 0) + (grounding.additionalFees > 0 ? 1 : 0);
  for (const activity of plan.days.flatMap(day => day.activities)) {
    const category = activity.category === 'food' ? 'food' : activity.category === 'transport' ? 'transportation' : activity.category === 'activity' ? 'activities' : activity.category === 'accommodation' ? 'accommodation' : 'fees';
    categories[category] += activity.estimatedCost;
    if (activity.priceEvidence?.status === 'provider-quote') verifiedAmount += activity.estimatedCost;
    else unknownPriceCount++;
  }
  const selected = plan.selectedTravelCosts;
  categories.transportation += selected?.flight?.total ?? 0;
  categories.activities += selected?.activities.reduce((sum, activity) => sum + activity.total, 0) ?? 0;
  categories.fees += selected?.preTrip?.total ?? 0;
  for (const cost of [selected?.flight, ...(selected?.activities ?? [])]) {
    if (!cost) continue;
    if (cost.isLive && !('priceBasis' in cost && cost.priceBasis)) verifiedAmount += cost.total; else unknownPriceCount++;
  }
  if (selected?.preTrip?.total) unknownPriceCount++;
  const subtotal = round(Object.values(categories).reduce((sum, amount) => sum + amount, 0));
  categories.contingency = round(subtotal * grounding.contingencyPercent / 100);
  for (const key of Object.keys(categories) as Array<keyof typeof categories>) categories[key] = round(categories[key]);
  const total = round(Object.values(categories).reduce((sum, amount) => sum + amount, 0));
  const evidence = groundingSchema.parse({ ...grounding, categories, subtotal, total, verifiedAmount: round(verifiedAmount), estimatedAmount: round(total - verifiedAmount), contingencyAmount: categories.contingency, unknownPriceCount,
    budgetStatus: total > plan.totalBudget ? 'exceeds-budget' : unknownPriceCount || !selected?.flight || grounding.placeDataStatus !== 'live' ? 'needs-confirmation' : 'within-quoted-budget' });
  const remaining = round(Math.max(0, plan.totalBudget - total));
  const withEvidence = { ...plan, grounding: evidence,
    budgetSummary: { ...plan.budgetSummary, plannedSpend: total, remainingBudget: remaining, shortfall: round(Math.max(0, total - plan.totalBudget)), dailyAverage: round(total / plan.days.length) },
    costSharing: { ...plan.costSharing!, plannedGroupSpend: total, plannedSpendShares: allocateEqualShares(total, plan.travelers!, plan.currency), reserveShares: allocateEqualShares(remaining, plan.travelers!, plan.currency) },
    budgetOptimization: buildBudgetOptimization({ budget: plan.totalBudget, currency: plan.currency, travelers: plan.travelers!, reserve: 0, plannedSpend: total, days: plan.days }),
  };
  return { ...withEvidence, groundingProof: signGroundedPlan(withEvidence) };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function proofPayload(plan: Pick<ItineraryResponse, 'grounding' | 'days' | 'destination' | 'currency' | 'totalBudget' | 'travelers' | 'accommodation' | 'selectedTravelCosts'>) {
  return stable([plan.destination, plan.currency, plan.totalBudget, plan.travelers, plan.grounding, plan.accommodation, plan.selectedTravelCosts,
    plan.days.map(day => [day.date, day.theme, day.travelNote, day.returnToStayAt, day.imageUrl, day.imageAttribution, day.totalCost, day.rideFare, day.activities.map(activity => [activity.time, activity.title, activity.description, activity.category, activity.estimatedCost, activity.unitCost, activity.priceEvidence, activity.place, activity.imageUrl, activity.imageAttribution, ...(activity.durationMinutes !== undefined || activity.travelMinutes !== undefined || activity.location !== undefined ? [activity.durationMinutes, activity.travelMinutes, activity.location] : [])])])]);
}
export function signGroundedPlan(plan: Parameters<typeof proofPayload>[0]) {
  return createHmac('sha256', process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me').update(proofPayload(plan)).digest('base64url');
}
export function verifyGroundedPlan(plan: ItineraryResponse) {
  return typeof plan.groundingProof === 'string' && constantTimeEqual(signGroundedPlan(plan), plan.groundingProof);
}
