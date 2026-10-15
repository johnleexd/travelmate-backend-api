import { createHmac, randomUUID } from 'node:crypto';
import { allocateEqualShares, allocateNightlyCosts, currencyFractionDigits, type CurrencyCode, type PartyType } from '../../schemas/domain.ts';
import { constantTimeEqual } from '../../utils/constant-time-equal.ts';
import type { AccommodationPlan, DayActivity, ItineraryResponse, SelectedTravelCosts } from '../../controllers/itinerary-controller.ts';
import type { GroundedScheduleDay } from '../ai/grounded-schedule.ts';
import type { GroundedPlace } from './grounded-places.ts';
import { distanceKm } from './grounded-places.ts';
import { groundingSchema, type DestinationAnchor, type PlanGrounding, type PriceEvidence } from './grounding-schema.ts';
import { stylePolicy, transportPlanning, referencedAdmission, premiumOpportunity, type GenerationPreferences } from './travel-preferences.ts';
import { buildBudgetOptimization } from '../budget/budget-optimization-service.ts';

export interface GroundedPlanInput {
  preferences?: GenerationPreferences;
  pace?: 'relaxed' | 'balanced' | 'active';
  familyBuffer?: boolean;
  timeZone?: string;
  generationWarning?: string;
  destination: string; anchor: DestinationAnchor; startingLocation: string; startDate: string; endDate: string;
  budget: number; currency: CurrencyCode; travelers: number; partyType: PartyType; rooms: number;
  places: GroundedPlace[]; placeDataStatus: PlanGrounding['placeDataStatus']; schedule: GroundedScheduleDay[];
  accommodation?: AccommodationPlan; selectedTravelCosts?: SelectedTravelCosts;
  source: 'openai' | 'gemini' | 'mock' | 'catalog'; transportation: string;
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
  const policy = stylePolicy[input.preferences?.travelStyle || 'balanced'];
  const routing = transportPlanning(input.transportation);
  const foodDaily = input.foodDailyPerPerson ?? 0;
  const nightlyRoom = input.nightlyRoomEstimate ?? 0;
  const stayTotal = input.accommodation?.total ?? calculateExpense(nightlyRoom, nights * rooms, travelers, 'per-room-night', currency);
  const accommodationEvidence: PriceEvidence = {
    status: ['amadeus', 'expedia-rapid', 'liteapi'].includes(input.accommodation?.source || '') && input.accommodation?.isLive ? 'provider-quote' : input.accommodation || input.nightlyRoomEstimate !== undefined || !nights ? 'estimate' : 'unavailable',
    basis: !nights ? 'No overnight accommodation is included: zero nights. An overnight stay requires a separate selection and price confirmation.' : input.accommodation ? input.accommodation.source === 'liteapi' && !input.accommodation.isLive ? 'Sandbox test stay quote; not verified production prices or availability. Budget includes disclosed property-payable charges. Selecting this hotel does not reserve a room.' : ['amadeus', 'expedia-rapid', 'liteapi'].includes(input.accommodation.source || '') ? 'Provider stay quote; exact full-stay total takes precedence over nightly averages. Prices can change until booking.' : 'TravelMate listing rate; availability and real booking price need confirmation.'
      : input.nightlyRoomEstimate !== undefined ? 'User-entered nightly room estimate × rooms × nights.' : 'Accommodation price unavailable. Excluded from known subtotal, not a free stay.',
    source: input.accommodation?.source ?? (input.nightlyRoomEstimate !== undefined ? 'user-entered' : 'unavailable'),
    fetchedAt: input.accommodation?.fetchedAt ?? fetchedAt, currency, unitAmount: input.accommodation ? input.accommodation.total / Math.max(1, nights * rooms) : nightlyRoom,
    quantity: nights * rooms, unit: 'per-room-night', participants: travelers, needsConfirmation: true,
  };
  const makeEvidence = (amount: number, quantity: number, unit: PriceEvidence['unit'], basis: string, source = 'unavailable', participants = travelers): PriceEvidence => ({
    status: source === 'unavailable' ? 'unavailable' : 'estimate', basis, source, fetchedAt, currency, unitAmount: amount, quantity, unit, participants, needsConfirmation: true,
  });
  const lodging = nights ? allocateNightlyCosts(stayTotal, nights, currency) : [];
  
  const fareType = input.transportFareType ?? (/taxi|ride.hailing|private|rental/i.test(input.transportation) ? 'shared-fare' : 'per-person');
  const fare = input.transportFare ?? 0;
  const days = input.schedule.map(day => {
    let previous: GroundedPlace | undefined;
    const visits: DayActivity[] = day.visits.map(visit => {
      const place = input.places.find(candidate => candidate.placeId === visit.placeId)!;
      if (!place) throw new Error('Unsupported itinerary place.');
      const buffer = (input.pace === 'relaxed' || input.familyBuffer ? 30 : 15) + policy.buffer;
      const transfer = previous ? Math.ceil(distanceKm(previous, place) / routing.speed * 60) + buffer : 0;
      previous = place;
      const commitment = input.selectedTravelCosts?.activities.find(item => item.name.normalize('NFKC').trim().toLowerCase() === place.name.normalize('NFKC').trim().toLowerCase());
      const fee = referencedAdmission(place, currency);
      const priceEvidence: PriceEvidence = commitment ? { ...makeEvidence(commitment.unitCost, 0, 'per-person', 'Exact-name activity commitment is included once under selected travel costs, for the selected party. No second admission allowance is charged here; confirm the offer coverage and visit time.', 'selected-activity', visit.participants), status: commitment.isLive && !commitment.priceBasis ? 'provider-quote' : input.accommodation || input.nightlyRoomEstimate !== undefined || !nights ? 'estimate' : 'unavailable', fetchedAt: commitment.fetchedAt }
        : fee ? { ...makeEvidence(fee.amount, 1, 'per-person', 'Published Wikidata admission reference; date, eligibility and current price need confirmation. Not a live quote.', fee.sourceUrl, visit.participants), fetchedAt: fee.fetchedAt, sourceUrl: fee.sourceUrl } : makeEvidence(0, 1, 'per-person', 'Admission price unavailable. Excluded from known subtotal; this does not imply free entry.', 'unavailable', visit.participants);
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const hoursNeedConfirmation = !place.openingWindows?.some(window => window.weekdays.includes(weekday));
      return { id: randomUUID(), status: 'planned', scheduleLabel: 'Suggested', durationMinutes: visit.durationMinutes, travelMinutes: transfer, time: minutesTime(visit.startMinutes), title: `Visit ${place.name}`.slice(0, 160),
        description: `${place.locationScope === 'nearby' ? `Nearby attraction — ${place.city === 'Locality unconfirmed' ? 'Municipality unconfirmed; ' : place.city + ', '}outside ${input.anchor.city}. ${place.distanceFromDestinationKm} km straight-line from the selected city centre; ${Math.ceil(distanceKm(input.anchor, place) / routing.speed * 60) + buffer} minutes each way using ${routing.label}, including a ${buffer}-minute buffer. Return time is reserved; confirm the actual route and transport. ` : ''}${hoursNeedConfirmation ? 'Opening hours need confirmation. ' : ''}${place.description}. Suggested ${visit.durationMinutes}-minute visit. ${transfer ? `Allow at least ${transfer} minutes from the previous stop (${routing.label}, straight-line estimate plus ${buffer}-minute buffer; confirm the real route). ` : ''}${place.openingHours === 'Opening hours need confirmation' ? '' : `Opening hours: ${place.openingHours}. `}Address: ${place.address}.`.slice(0, 1000),
        category: 'activity', icon: 'map', estimatedCost: calculateExpense(priceEvidence.unitAmount, priceEvidence.quantity, visit.participants, 'per-person', currency), unitCost: priceEvidence.unitAmount,
        imageUrl: place.imageUrl, imageAttribution: place.imageAttribution ? { ...place.imageAttribution, photoType: 'place' } : undefined, placeVerification: 'supporting-source-found',
        place: { provider: place.provider, placeId: place.placeId, name: place.name, city: place.city, country: place.country, countryCode: place.countryCode, latitude: place.latitude, longitude: place.longitude, sourceUrl: place.sourceUrl, fetchedAt: place.fetchedAt, openingHours: place.openingHours, address: place.address,
          ...(place.locationScope ? { locationScope: place.locationScope, selectedCity: place.selectedCity, distanceFromDestinationKm: place.distanceFromDestinationKm, membershipSourceUrl: place.membershipSourceUrl } : {}), ...(place.coordinateSourceUrl ? { coordinateSourceUrl: place.coordinateSourceUrl } : {}) }, priceEvidence };
    });
    const foodEvidence = makeEvidence(foodDaily, 1, 'daily-per-person', input.foodDailyPerPerson !== undefined ? 'User-entered daily food estimate per person × travelers × days.' : 'Restaurant/menu prices are unavailable; not included in known subtotal. Confirm locally.', input.foodDailyPerPerson !== undefined ? 'user-entered' : 'unavailable');
    const food: DayActivity = { time: 'Daily allowance', title: `Daily meals in ${input.anchor.city}`.slice(0, 160), description: `${policy.meal} Food interests: ${[...(input.preferences?.interests || []), ...(input.preferences?.activities || [])].filter(value => /food|meal|dining|cuisine|vegetarian|vegan/i.test(value)).join(', ') || 'none specified'}. Venues, dietary suitability and menu prices need confirmation; no restaurant was invented.`.slice(0, 1000), category: 'food', icon: 'food', estimatedCost: calculateExpense(foodDaily, 1, travelers, 'daily-per-person', currency), unitCost: foodDaily, priceEvidence: foodEvidence };
    const transportEvidence = makeEvidence(fare, 1, fareType, input.transportFare !== undefined ? 'User-entered daily fare estimate. Confirm fare coverage, route, vehicle capacity, tolls, and fees.' : 'No verified route fare is available. Excluded from known subtotal; confirm fares, tolls and transfers.', input.transportFare !== undefined ? 'user-entered' : 'unavailable');
    const transport: DayActivity = { time: 'Daily allowance', title: `Daily transport in ${input.anchor.city}`.slice(0, 160), description: `${input.transportation || 'Mode: Not available'}. ${fareType === 'shared-fare' ? 'One shared daily fare for the party; not multiplied by travelers.' : 'Daily fare per traveler, multiplied by the party size.'} Route, timetable and capacity require confirmation.`, category: 'transport', icon: 'bus', estimatedCost: calculateExpense(fare, 1, travelers, fareType, currency), unitCost: fare, priceEvidence: transportEvidence };
    const activities = [...visits, { ...food, id: randomUUID() }, { ...transport, id: randomUUID() }];
    const planningStatus = day.planningStatus ?? (visits.length ? 'suggested' : 'incomplete');
    const themeCity = input.anchor.city.length > 80 ? input.anchor.city.slice(0, 77).replace(/[\uD800-\uDBFF]$/, '') + '…' : input.anchor.city;
    const planningReason = day.planningReason ?? (visits.length ? 'Suggested destination-local visits; confirm current hours and access.' : 'Not enough city/country-verified places are available; no attractions were invented.');
    return { day: day.day, date: day.date, planningStatus, planningReason, scheduleBlocks: day.scheduleBlocks,
      theme: visits.length ? `${input.anchor.city}: ${visits.map(visit => visit.place?.name).join(', ')}`.slice(0, 120) : planningStatus === 'rest' ? `${themeCity}: rest day` : planningStatus === 'travel' ? `${themeCity}: travel day` : `${themeCity}: details need confirmation`,
      imageUrl: visits.find(visit => visit.imageUrl)?.imageUrl ?? '', imageAttribution: visits.find(visit => visit.imageUrl)?.imageAttribution,
      travelNote: `${planningReason} Stops use verified city/country records. Transfers use ${routing.label}, straight-line plus ${(input.pace === 'relaxed' || input.familyBuffer ? 30 : 15) + policy.buffer} minutes; real routes, hours and traffic need confirmation.`.slice(0, 500).trim(),
      returnToStayAt: input.accommodation ? '08:30 PM' : undefined, rideFare: transport.estimatedCost,
      totalCost: round(activities.reduce((sum, activity) => sum + activity.estimatedCost, 0) + (lodging[day.day - 1] ?? 0)), activities };
  });
  const base = round(days.reduce((sum, day) => sum + day.totalCost, 0) + (input.selectedTravelCosts?.total ?? 0) + (input.fees ?? 0));
  const contingencyPercent = input.contingencyPercent ?? 10;
  const remainingForReferences = Math.max(0, budget / (1 + contingencyPercent / 100) - base);
  const scheduledIds = new Set(days.flatMap(day=>day.activities.flatMap(activity=>activity.place ? [activity.place.placeId] : [])));
  const unaffordable = input.places.filter(place=>!scheduledIds.has(place.placeId) && referencedAdmission(place,currency) && referencedAdmission(place,currency)!.amount * travelers > remainingForReferences);

  const contingency = round(base * contingencyPercent / 100);
  const plan: ItineraryResponse = {
    preferences: input.preferences, destination: input.destination, totalBudget: budget, currency, travelers, partyType: input.partyType, source: input.source,
    accommodation: input.accommodation, selectedTravelCosts: input.selectedTravelCosts, days,
    budgetSummary: { accommodation: stayTotal, food: round(foodDaily * travelers * count), activities: round(visitsCost(days)), transport: round(fare * count * (fareType === 'shared-fare' ? 1 : travelers)), reserve: contingency, dailyAverage: round(base / count), total: budget, accommodationActual: stayTotal, plannedSpend: base, remainingBudget: round(Math.max(0, budget - base)), shortfall: round(Math.max(0, base + contingency - budget)) },
    costSharing: { partyType: input.partyType, travelers, groupBudget: budget, plannedGroupSpend: base, budgetShares: allocateEqualShares(budget, travelers, currency), plannedSpendShares: allocateEqualShares(base, travelers, currency), accommodationShares: allocateEqualShares(stayTotal, travelers, currency), reserveShares: allocateEqualShares(Math.max(0, budget - base), travelers, currency) },
    grounding: { version: 1, destination: input.anchor, startingLocation: input.startingLocation, startDate: input.startDate, endDate: input.endDate, fetchedAt, timeZone: input.timeZone,
      placeDataStatus: input.placeDataStatus, currency, rooms, nights, foodDailyPerPerson: foodDaily, accommodation: accommodationEvidence, contingencyPercent, contingencyAmount: contingency,
      additionalFees: input.fees ?? 0, categories: { accommodation: stayTotal, food: 0, activities: 0, transportation: 0, fees: input.fees ?? 0, contingency }, subtotal: base, total: base + contingency, verifiedAmount: 0, estimatedAmount: 0, unknownPriceCount: 0, budgetStatus: 'needs-confirmation',
      limitations: [
        ...(input.generationWarning ? [input.generationWarning] : []),
        ...(unaffordable.length ? [`Referenced admission for ${unaffordable.slice(0,3).map(p=>p.name).join(', ')} exceeds the remaining recorded spending limit. Consider the suggested suitable alternatives or revise the limit. Unpriced alternatives still need price confirmation.`.slice(0,1000)] : []),
        ...(input.selectedTravelCosts?.activities.some(activity => activity.priceBasis) ? ['Selected activity group costs assume the provider headline fare is per person. The provider does not confirm date/party fare coverage; these multiplied amounts are estimates, even with production data.'] : []),
        'Budget is a spending ceiling. Unavailable accommodation, meals, transport and admissions are excluded from the known subtotal, not priced as free. Affordability remains unconfirmed.',
        `Travel style: ${input.preferences?.travelStyle || 'balanced'}. ${policy.instruction} ${policy.meal}`,
        ...(input.preferences?.travelStyle === 'luxury' && input.places.some(p=>premiumOpportunity(p) && !referencedAdmission(p,currency)) ? ['Some source-identified premium opportunities have no comparable admission price. They cannot be confirmed affordable; use suitable standard visits or obtain current prices before choosing premium options.'] : []),
        ...(input.preferences?.travelStyle === 'luxury' && !input.places.some(premiumOpportunity) ? ['No source-identified premium experience is available in this catalogue. Suitable standard visits are suggested; compare verified premium options and prices separately.'] : []),
        ...(input.preferences?.travelStyle === 'luxury' && input.places.some(p => premiumOpportunity(p) && referencedAdmission(p, currency) && referencedAdmission(p, currency)!.amount * travelers > budget) ? ['Some referenced premium admissions exceed the whole-group budget. Consider the suitable standard visits or revise the spending limit.'] : []),
        ...(input.preferences ? [`Stay preference: ${input.preferences.accommodation}; applies to suggestions. An explicitly selected hotel is preserved; its actual price and fit must be confirmed.`] : []),
        'Opening hours, street routes, venue access, transport capacity and unquoted taxes/fees need confirmation.',
        'Schedules use destination-local calendar dates and wall clocks. Supplied arrival/departure times reserve estimated 90-minute arrival and 120-minute departure buffers; booking and hotel check-in times still need confirmation.',
        ...(!input.timeZone ? ['An IANA destination time-zone reference is unavailable. Suggested local clocks are not converted to UTC or the browser time zone.'] : []),
        ...(!input.selectedTravelCosts?.flight ? ['Travel from the starting location to the destination is not priced; compare flights or supply pre-trip estimates.'] : []),
        ...(input.placeDataStatus === 'stale-cache' ? ['Place references are stale cached data; confirm all details.'] : []),
        ...(!input.places.length ? ['Place provider returned no city/country-validated attractions; no venues were invented.'] : []),
      ] },
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
  const unpricedExpenseCount = (grounding.nights && grounding.accommodation.status === 'unavailable' ? 1 : 0) + plan.days.flatMap(day => day.activities).filter(activity => activity.priceEvidence?.status === 'unavailable').length + (!plan.selectedTravelCosts?.flight ? 1 : 0);
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
  const evidence = groundingSchema.parse({ ...grounding, categories, subtotal, total, verifiedAmount: round(verifiedAmount), estimatedAmount: round(total - verifiedAmount), contingencyAmount: categories.contingency, unknownPriceCount, unpricedExpenseCount,
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
    plan.days.map(day => [day.date, day.theme, day.travelNote, day.returnToStayAt, day.imageUrl, day.imageAttribution, day.totalCost, day.rideFare, day.activities.map(activity => [activity.time, activity.title, activity.description, activity.category, activity.estimatedCost, activity.unitCost, activity.priceEvidence, activity.place, activity.imageUrl, activity.imageAttribution, ...(activity.durationMinutes !== undefined || activity.travelMinutes !== undefined || activity.location !== undefined ? [activity.durationMinutes, activity.travelMinutes, activity.location] : []), ...(day.planningStatus ? [activity.id, activity.scheduleLabel] : [])]), ...(day.planningStatus ? [day.planningStatus, day.planningReason, day.scheduleBlocks] : [])])]);
}
export function signGroundedPlan(plan: Parameters<typeof proofPayload>[0]) {
  return createHmac('sha256', process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me').update(proofPayload(plan)).digest('base64url');
}
export function verifyGroundedPlan(plan: ItineraryResponse) {
  return typeof plan.groundingProof === 'string' && constantTimeEqual(signGroundedPlan(plan), plan.groundingProof);
}
