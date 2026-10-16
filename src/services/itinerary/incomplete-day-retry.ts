import { buildGroundedPlan, refreshGroundedTotals } from './grounded-plan.ts';
import { completeGroundedSchedule } from './generated-day-scheduler.ts';
import { isDailyBudgetEntry } from '../navigation/trip-map-service.ts';
import { distanceKm, permittedPlaceCandidates, type GroundedPlace, type PlaceCoverage } from './grounded-places.ts';
import { travelStyles } from './travel-preferences.ts';
import type { DayActivity, ItineraryResponse } from '../../controllers/itinerary-controller.ts';

const visit = (activity: DayActivity) => !isDailyBudgetEntry(activity) && (activity.category === 'activity' || !!activity.place);
const name = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^visit\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Add-only retry: selected days receive unused verified stops; every existing
 * activity (including custom edits, visits, allowances and photos) is retained. */
export function retryIncompleteDays(plan: ItineraryResponse, indices: number[], catalog: { places: GroundedPlace[]; status: 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable'; coverage?: PlaceCoverage }, includeNearby = false, baseline = plan) {
  if (!plan.grounding) throw new Error('The plan has no verified destination.');
  const selected = new Set(indices);
  if (indices.some(index => !plan.days[index])) throw new Error('Choose an existing itinerary day.');
  const existing = plan.days.flatMap(day => day.activities.filter(visit));
  const used = new Set([...(plan.grounding.previousPlaceIds ?? []), ...baseline.days.flatMap(day => day.activities.flatMap(activity => activity.place ? [activity.place.placeId] : [])), ...existing.flatMap(activity => activity.place ? [activity.place.placeId] : [])]);
  const candidates = permittedPlaceCandidates(catalog.places, includeNearby).filter(place => !used.has(place.placeId)
    && !existing.some(activity => name(activity.place?.name ?? activity.title) === name(place.name)
      && (!activity.place || distanceKm(activity.place, place) < 0.1)));
  const occupied = Object.fromEntries(plan.days.map(day => {
    const visits = day.activities.filter(visit);
    const visitMinutes = visits.reduce((sum, activity) => sum + (activity.durationMinutes ?? 90) + (activity.travelMinutes ?? 15), 0);
    const latestReservation = Math.max(540, ...visits.filter(activity => /^\d{2}:\d{2}$/.test(activity.time)).map(activity => Number(activity.time.slice(0, 2)) * 60 + Number(activity.time.slice(3)) + (activity.durationMinutes ?? 90)));
    return [day.date, { visits: visits.length, minutes: Math.max(visitMinutes, latestReservation - 540) }];
  }));
  const travelStyle = travelStyles.find(style => style === plan.preferences?.travelStyle) ?? 'balanced';
  const schedule = completeGroundedSchedule(plan.grounding.destination, candidates, [], plan.days[0].date, plan.days.length, plan.travelers ?? 1, 'balanced', {
    constraints: { ...plan.grounding.scheduleConstraints, restDates: [...new Set([...(plan.grounding.scheduleConstraints?.restDates ?? []), ...plan.days.filter((_, index) => !selected.has(index) || ['rest', 'travel'].includes(plan.days[index].planningStatus ?? '')).map(day => day.date)])] }, occupied,
    transportation: plan.preferences?.transportation, travelStyle, interests: plan.preferences?.interests, preferredActivities: plan.preferences?.activities,
    visitBudget: Math.max(0, plan.budgetSummary.remainingBudget ?? plan.totalBudget),
    currency: plan.currency, providerUnavailable: catalog.status === 'unavailable', providerPartial: catalog.coverage?.outcome === 'partial',
    diagnostics: event => console.info(JSON.stringify({ ...event, city: plan.grounding!.destination.city, operation: 'retry-incomplete-days' })),
  });
  const generated = buildGroundedPlan({ destination: plan.destination, anchor: plan.grounding.destination, startingLocation: plan.grounding.startingLocation,
    startDate: plan.days[0].date, endDate: plan.days.at(-1)!.date, budget: plan.totalBudget, currency: plan.currency, travelers: plan.travelers ?? 1,
    partyType: plan.partyType ?? 'solo', rooms: plan.grounding.rooms, places: candidates, placeDataStatus: catalog.status, schedule, source: 'catalog', transportation: plan.preferences?.transportation ?? '' });
  const updated = structuredClone(plan);
  updated.grounding!.previousPlaceIds = [...used];
  let added = 0;
  for (const index of selected) {
    const day = updated.days[index], proposal = generated.days[index];
    const hadVisits = day.activities.some(visit);
    const additions = proposal.activities.filter(activity => activity.place);
    day.activities.push(...additions); added += additions.length;
    day.planningStatus = proposal.planningStatus;
    day.planningReason = proposal.planningReason;
    day.planningIssue = proposal.planningIssue;
    if (!hadVisits && additions.length) {
      day.theme = proposal.theme;
      day.travelNote = proposal.travelNote;
      day.scheduleBlocks = proposal.scheduleBlocks;
    }
    if (!candidates.length && catalog.places.length && day.planningStatus === 'incomplete' && day.planningIssue !== 'provider-failure') {
      day.planningIssue = 'insufficient-coverage'; day.planningReason = 'No additional unique verified places were found within the selected scope. Existing activities are preserved.';
    }
  }
  return { itinerary: refreshGroundedTotals(updated), added, coverage: catalog.coverage };
}
