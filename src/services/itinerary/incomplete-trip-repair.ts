import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { generationPreferencesSchema, travelStyles } from './travel-preferences.ts';
import { currencyFractionDigits } from '../../schemas/domain.ts';
import { buildGroundedPlan, refreshGroundedTotals } from './grounded-plan.ts';
import { completeGroundedSchedule, type SchedulingOptions } from './generated-day-scheduler.ts';
import type { GroundedPlace } from './grounded-places.ts';

const allowance = (activity: ItineraryResponse['days'][number]['activities'][number]) => !activity.place && !activity.location
  && activity.category !== 'activity' && /^Daily allowance$/i.test(activity.time);

/** Older grounded generators marked incomplete days in the theme, before status existed. */
export function emptyGeneratedDays(plan: ItineraryResponse) {
  if (!plan.grounding || (plan as ItineraryResponse & { manuallyEdited?: boolean }).manuallyEdited) return [];
  return plan.days.filter(day => (day.planningStatus === 'incomplete' || !day.planningStatus && /details need confirmation/i.test(day.theme)) && day.activities.every(allowance));
}

/** Append catalog visits; keep every saved entry, photo, populated day and cost. */
export function repairIncompleteTrip(plan: ItineraryResponse, catalog: GroundedPlace[], interests: string[] = [], diagnostics?: SchedulingOptions['diagnostics']) {
  const empty = emptyGeneratedDays(plan);
  if (!empty.length || !catalog.length) return { plan, added: 0, days: [] as number[] };
  const grounding = plan.grounding!;
  const used = new Set(plan.days.flatMap(day => day.activities.flatMap(activity => activity.place ? [activity.place.placeId] : [])));
  const available = catalog.filter(place => !used.has(place.placeId));
  const pace = plan.preferences?.pace ?? 'balanced';
  const preferenceResult = generationPreferencesSchema.safeParse({ ...plan.preferences, interests: plan.preferences?.interests ?? interests });
  const preferences = preferenceResult.success ? preferenceResult.data : generationPreferencesSchema.parse({ travelStyle: travelStyles.includes(plan.preferences?.travelStyle as typeof travelStyles[number]) ? plan.preferences?.travelStyle : 'balanced', accommodation: 'no preference', transportation: plan.preferences?.transportation, pace, interests, activities: plan.preferences?.activities });
  const visitBudget = Math.max(0, plan.totalBudget / (1 + grounding.contingencyPercent / 100) - grounding.subtotal);
  const schedule = completeGroundedSchedule(grounding.destination, available, [], grounding.startDate, plan.days.length, plan.travelers!, pace, {
    ...preferences, preferredActivities: preferences.activities, committedActivityNames: plan.selectedTravelCosts?.activities.map(activity=>activity.name), currency: plan.currency, visitBudget, family: plan.partyType === 'family', diagnostics,
    constraints: { restDates: plan.days.filter(day => !empty.includes(day)).map(day => day.date) },
  });
  const generated = buildGroundedPlan({ destination: plan.destination, anchor: grounding.destination, startingLocation: grounding.startingLocation,
    startDate: grounding.startDate, endDate: grounding.endDate, budget: plan.totalBudget, currency: plan.currency, travelers: plan.travelers!, partyType: plan.partyType!, rooms: grounding.rooms,
    places: available, placeDataStatus: 'live', schedule, source: 'catalog', transportation: plan.preferences?.transportation ?? '', pace, familyBuffer: plan.partyType === 'family', timeZone: grounding.timeZone,
    selectedTravelCosts: plan.selectedTravelCosts, preferences,
  });
  const added = generated.days.reduce((sum, day) => sum + day.activities.filter(activity => !!activity.place).length, 0);
  if (!added) return { plan, added: 0, days: [] as number[] };
  const round = (value: number) => Math.round(value * 10 ** currencyFractionDigits(plan.currency)) / 10 ** currencyFractionDigits(plan.currency);
  const changedDays: number[] = [];
  const days = plan.days.map(day => {
    if (!empty.includes(day)) return day;
    const suggested = generated.days[day.day - 1];
    const visits = suggested.activities.filter(activity => !!activity.place);
    if (!visits.length) return day;
    changedDays.push(day.day);
    return { ...day, theme: suggested.theme, planningStatus: suggested.planningStatus, planningReason: suggested.planningReason, travelNote: suggested.travelNote, scheduleBlocks: suggested.scheduleBlocks,
      imageUrl: day.imageUrl || suggested.imageUrl, imageAttribution: day.imageUrl ? day.imageAttribution : suggested.imageAttribution,
      activities: [...visits, ...day.activities], totalCost: round(day.totalCost + visits.reduce((sum, activity) => sum + activity.estimatedCost, 0)) };
  });
  const limitations = grounding.limitations.filter(text => !/Place provider returned no city\/country-validated attractions|no suitable city\/country/i.test(text));
  limitations.push('Previously empty generated days were supplemented from verified place records. Suggested 09:00–18:00 sightseeing windows, opening hours, access, prices and selected-transport routes need confirmation. Existing entries and costs were retained.');
  return { plan: refreshGroundedTotals({ ...plan, days, grounding: { ...grounding, placeDataStatus: 'live', limitations: limitations.slice(-20) } }), added, days: changedDays };
}
