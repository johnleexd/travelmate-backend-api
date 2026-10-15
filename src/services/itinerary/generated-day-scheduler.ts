import { z } from 'zod';
import { distanceKm, placeMatchesAnchor, type GroundedPlace } from './grounded-places.ts';
import type { DestinationAnchor } from './grounding-schema.ts';
import type { GroundedScheduleDay } from '../ai/grounded-schedule.ts';
import { MAX_PLACE_DISTANCE_KM } from './place-search-policy.ts';
import { reusableStoredActivityPhoto } from './activity-photo-fallback.ts';
import { stylePolicy, transportPlanning, premiumOpportunity, familyOpportunity, referencedAdmission, type TravelStyle } from './travel-preferences.ts';

const localClock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const generationConstraintsSchema = z.object({
  arrivalTime: localClock.optional(), departureTime: localClock.optional(),
  restDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(31).default([]),
}).strict();
export type GenerationConstraints = z.infer<typeof generationConstraintsSchema>;
export interface ScheduleBlock { kind: 'meal' | 'free-time' | 'unscheduled'; startMinutes: number; endMinutes: number; label: string }
export interface ScheduleMetadata {
  planningStatus?: 'suggested' | 'incomplete' | 'rest' | 'travel';
  planningReason?: string;
  scheduleBlocks?: ScheduleBlock[];
}
export interface SchedulingOptions {
  constraints?: GenerationConstraints;
  interests?: string[];
  preferredActivities?: string[];
  committedActivityNames?: string[];
  travelStyle?: TravelStyle;
  transportation?: string;
  currency?: string;
  visitBudget?: number;
  family?: boolean;
  weather?: Array<{ date: string; description: string; precipitationProbability: number; tempMax: number }>;
  providerUnavailable?: boolean;
  diagnostics?: (event: Record<string, unknown>) => void;
}
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const genre = (place: GroundedPlace) => /museum|gallery|library/i.test(place.description) ? 'culture' : /park|garden|beach/i.test(place.description) ? 'nature' : /market|food/i.test(place.description) ? 'food' : /church|temple|mosque|cathedral/i.test(place.description) ? 'religious' : place.placeId;
const indoor = (place: GroundedPlace) => /museum|gallery|aquarium|library|theatre|theater/i.test(place.description);
const durationFor = (place: GroundedPlace, relaxed: boolean) => /zoo|aquarium/i.test(place.description) ? 180 : /museum|gallery|garden|park|castle|palace|fortress/i.test(place.description) ? relaxed ? 120 : 90 : relaxed ? 90 : 60;
const dateAt = (start: string, offset: number) => new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

/** New generation only: balance catalog-backed recommendations, never modify saved plans. */
export function completeGroundedSchedule(anchor: DestinationAnchor, catalog: GroundedPlace[], aiDays: GroundedScheduleDay[], startDate: string, count: number, travelers: number, pace: 'relaxed' | 'balanced' | 'active', options: SchedulingOptions = {}): GroundedScheduleDay[] {
  const ids = new Set<string>();
  const places = catalog.filter(place => {
    if (ids.has(place.placeId) || !/^Q\d+$/.test(place.placeId) || !placeMatchesAnchor(place, anchor)
      || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180 || distanceKm(place, anchor) > MAX_PLACE_DISTANCE_KM) return false;
    ids.add(place.placeId); return true;
  });
  const policy=stylePolicy[options.travelStyle || 'balanced'],transport=transportPlanning(options.transportation);
  const cap = Math.min(policy.maxVisits, pace === 'relaxed' ? 2 : pace === 'active' ? 4 : 3);
  let remainingBudget=options.visitBudget ?? Infinity;
  const constraints = options.constraints ?? { restDates: [] };
  const windows = Array.from({ length: count }, (_, index) => {
    const date = dateAt(startDate, index);
    const start = index === 0 && constraints.arrivalTime ? Math.max(540, minutes(constraints.arrivalTime) + 90) : 540;
    const end = index === count - 1 && constraints.departureTime ? Math.min(1080, minutes(constraints.departureTime) - 120) : 1080;
    return { date, start, end, rest: constraints.restDates.includes(date) };
  });
  const used = new Set<string>();
  const result: GroundedScheduleDay[] = [];
  const expandedWords = (values:string[]) => {
    const text=normalize(values.join(' '));
    const singular:Record<string,string>={museums:'museum',parks:'park',gardens:'garden',galleries:'gallery',temples:'temple',churches:'church',beaches:'beach',markets:'market'};
    return [...new Set([...text.split(' ').map(word=>singular[word] || word),
      ...(/food|dining|cuisine/.test(text)?['market']:[]), ...(/nature|outdoor/.test(text)?['park','garden','beach']:[]),
      ...(/culture|history/.test(text)?['museum','historic','heritage','temple','church']:[]), ...(/\bart\b/.test(text)?['gallery','museum']:[])])].filter(word=>word.length>2 && !['local','sightseeing','activities'].includes(word));
  };
  const words = expandedWords(options.interests ?? []);
  const preferredWords = expandedWords(options.preferredActivities ?? []);
  // AI preferences and long visit durations are retained as hints, not as permission to invent catalog facts.
  const hints = new Map(aiDays.flatMap(day => day.visits.map(visit => [visit.placeId, visit] as const)));
  for (const [index, window] of windows.entries()) {
    const day: GroundedScheduleDay = { day: index + 1, date: window.date, theme: '', visits: [], scheduleBlocks: [] };
    if (window.rest || window.end - window.start < 60) {
      day.planningStatus = window.rest ? 'rest' : 'travel';
      day.planningReason = window.rest ? 'Rest day selected by you.' : 'Arrival/departure buffers leave no usable sightseeing window.';
      day.theme = window.rest ? 'Rest day' : 'Travel day';
      if (window.rest) day.scheduleBlocks!.push({ kind: 'free-time', startMinutes: 540, endMinutes: 1080, label: 'Rest and personal time — selected by you' });
      result.push(day); continue;
    }
    const forecast = options.weather?.find(entry => entry.date === window.date);
    const badWeather = !!forecast && (forecast.precipitationProbability >= 70 || /thunderstorm/i.test(forecast.description) || forecast.tempMax >= 35);
    let previous: GroundedPlace | undefined, finish = window.start, lunch: { start: number; end: number } | undefined;
    const evaluate = (place: GroundedPlace, candidateWindow = window, from = previous, after = finish, existingMeal = lunch) => {
        const hint = hints.get(place.placeId);
        const duration = hint?.durationMinutes ?? durationFor(place, pace === 'relaxed');
        const buffer = (pace === 'relaxed' || options.family ? 30 : 15)+policy.buffer;
        const needsCityTransfer = !!place.locationScope && distanceKm(anchor, place) > 1;
        const transfer = from ? Math.ceil(distanceKm(from, place) / transport.speed * 60) + buffer : needsCityTransfer ? Math.ceil(distanceKm(anchor, place) / transport.speed * 60) + buffer : 0;
        const returnBuffer = needsCityTransfer ? Math.ceil(distanceKm(anchor, place) / transport.speed * 60) + buffer : 0;
        let earliest = after + transfer;
        let meal = existingMeal;
        if (!meal && from && after >= 720) { meal = { start: after, end: after + 45 }; earliest = meal.end + transfer; }
        // Reserve lunch instead of scheduling a short visit through it. Long visits keep their duration intact.
        if (!meal && duration <= 180 && earliest < 780 && earliest + duration > 720) {
          const mealStart = Math.max(720, from ? after : earliest);
          meal = { start: mealStart, end: mealStart + 45 };
          earliest = Math.max(earliest, meal.end + (from ? transfer : 0));
        }
        const weekday = new Date(`${candidateWindow.date}T00:00:00Z`).getUTCDay();
        const references = place.openingWindows?.filter(w => w.weekdays.includes(weekday));
        // A reference for another weekday does not prove this day's opening or closure.
        const hours = references?.length ? references : undefined;
        const starts = hours ? hours.map(w => Math.max(earliest, w.startMinutes)).filter((start, i) => start + duration <= hours[i].endMinutes) : [earliest];
        const start = starts.filter(start => start + duration + returnBuffer + (returnBuffer && !meal ? 45 : 0) <= candidateWindow.end).sort((a, b) => a - b)[0];
        const referenceText = normalize(place.name + ' ' + place.description);
        const interest = words.filter(word => referenceText.includes(word)).length;
        const requested=preferredWords.filter(word=>referenceText.includes(word)).length;
        const fee=referencedAdmission(place,options.currency),cost=options.committedActivityNames?.some(name=>normalize(name)===normalize(place.name))?0:fee?fee.amount*Math.min(travelers,hint?.participants ?? travelers):undefined;
        const affordable=cost===undefined || cost<=remainingBudget;
        const premium=options.travelStyle==='luxury' && premiumOpportunity(place) && cost!==undefined && affordable?3:0;
        const family=options.travelStyle==='family-friendly' && familyOpportunity(place)?3:0;
        const lowCost=options.travelStyle==='budget' && cost!==undefined?2/(1+cost/Math.max(1,(options.visitBudget ?? 100)/Math.max(1,count))):0;
        const preferred = aiDays[index]?.visits.some(visit => visit.placeId === place.placeId) ? 1 : 0;
        const distance = distanceKm(from ?? anchor, place);
        // Geography dominates after the first stop; weather and interests choose suitable nearby stops.
        const variety = options.travelStyle === 'balanced' && day.visits.some(visit => genre(places.find(p => p.placeId === visit.placeId)!) === genre(place)) ? -1 : 0;
        const score = variety + interest * 2 + requested * 4 + preferred + premium + family + lowCost + (badWeather && indoor(place) ? 4 : 0) - distance * (from ? 3 : policy.distanceWeight);
        return { place, duration, transfer, returnBuffer, start:affordable?start:undefined, meal, score, cost, interest, requested, premium, family, lowCost, variety, participants: hint?.participants ?? travelers,
          rejectionReason: !affordable ? 'referenced-fee-exceeds-remaining-budget' : start !== undefined ? undefined : !starts.length ? 'known-opening-window-too-short' : 'visit-transfers-and-return-exceed-day-window' };
    };
    const remainingWindows = windows.slice(index).filter(w => !w.rest && w.end - w.start >= 60);
    // Count only visits that can actually fit a remaining day. Counting distant,
    // unschedulable catalog entries spends the usable visits on early days.
    const unused = places.filter(place => !used.has(place.placeId));
    const firstFits = unused.map(place => ({ place, fits: remainingWindows.some(w => evaluate(place, w, undefined, w.start, undefined).start !== undefined) }));
    const feasibleRemaining = firstFits.filter(candidate => candidate.fits).length;
    const target = Math.min(cap, Math.ceil(feasibleRemaining / remainingWindows.length));
    options.diagnostics?.({ event: 'schedule_day_allocation', day: day.day, catalog: places.length, unused: unused.length, feasibleRemaining, remainingDays: remainingWindows.length, target,
      rejected: firstFits.filter(candidate => !candidate.fits).map(({ place }) => ({ placeId: place.placeId, reason: evaluate(place, window, undefined, window.start, undefined).rejectionReason })) });
    for (let slot = 0; slot < target; slot++) {
      const evaluated = places.filter(place => !used.has(place.placeId)).map(place => evaluate(place));
      const candidates = evaluated.filter(candidate => candidate.start !== undefined).sort((a, b) => b.score - a.score || a.place.placeId.localeCompare(b.place.placeId));
      options.diagnostics?.({ event: 'schedule_slot_filter', day: day.day, slot: slot + 1, considered: evaluated.length, feasible: candidates.length,
        rejected: evaluated.filter(candidate => candidate.start === undefined).map(candidate => ({ placeId: candidate.place.placeId, reason: candidate.rejectionReason, duration: candidate.duration, transfer: candidate.transfer, returnBuffer: candidate.returnBuffer })) });
      // Actual provider photos break only close relevance ties; missing photos
      // never remove eligible places from the schedule.
      const best = candidates[0]; if (!best) break;
      const chosen = candidates.filter(candidate => candidate.score >= best.score - 0.25)
        .sort((a, b) => Number(reusableStoredActivityPhoto(b.place)) - Number(reusableStoredActivityPhoto(a.place)) || b.score - a.score || a.place.placeId.localeCompare(b.place.placeId))[0];
      day.visits.push({ placeId: chosen.place.placeId, startMinutes: chosen.start!, durationMinutes: chosen.duration, participants: Math.min(travelers, chosen.participants) });
      if(chosen.cost!==undefined)remainingBudget-=chosen.cost;
      options.diagnostics?.({event:'preference_selection',style:options.travelStyle || 'balanced',day:day.day,placeId:chosen.place.placeId,relevance:chosen.interest,requestedActivities:chosen.requested,knownCost:chosen.cost ?? null,lowCost:chosen.lowCost,premium:chosen.premium,family:chosen.family,variety:chosen.variety,transport:transport.mode,remainingBudget:Number.isFinite(remainingBudget)?remainingBudget:null});
      used.add(chosen.place.placeId); previous = chosen.place; finish = chosen.start! + chosen.duration; lunch = chosen.meal;
      if (chosen.duration >= 240) break; // A long visit can be the day's main recommendation.
    }
    const visitMinutes = day.visits.reduce((sum, visit) => sum + visit.durationMinutes, 0);
    const expected = window.end - window.start < 240 ? 1 : 2;
    const enough = day.visits.length >= expected || visitMinutes >= (pace === 'relaxed' ? 120 : 180);
    day.planningStatus = enough ? 'suggested' : 'incomplete';
    day.planningReason = enough ? 'Suggested verified city and nearby visits; visit durations and transport transfers are estimates. Nearby visits reserve return travel to the selected city. Confirm current hours and access.'
      : options.providerUnavailable ? 'Place providers are unavailable; no attractions were invented.' : !places.length ? 'Place-provider coverage returned no suitable city/country-verified places within the supported search area. No attractions were invented.' : 'Not enough unused, city/country-verified places are available for this day, or known opening windows and travel gaps do not fit. Missing opening hours alone do not exclude places.';
    day.planningReason += ` Style: ${options.travelStyle || 'balanced'}; ${transport.label} plus ${((pace==='relaxed'||options.family)?30:15)+policy.buffer}-minute transfer buffers; actual routes, fares and access need confirmation.`;
    if (badWeather) day.planningReason += day.visits.some(visit => indoor(places.find(place => place.placeId === visit.placeId)!)) ? ' Verified indoor venues are prioritized; confirm access and use the visible weather alerts.' : ' No suitable verified indoor alternative is available; review the weather alert before outdoor visits.';
    day.theme = day.visits.length ? 'Suggested visits' : 'More places needed';
    // Time blocks are schedule context, never cost-bearing activity entries or map pins.
    let cursor = window.start;
    const busy = day.visits.map((visit, i) => ({ start: visit.startMinutes - (i ? Math.ceil(distanceKm(places.find(p => p.placeId === day.visits[i - 1].placeId)!, places.find(p => p.placeId === visit.placeId)!) / transport.speed * 60) + (pace === 'relaxed' || options.family ? 30 : 15) + policy.buffer : 0), end: visit.startMinutes + visit.durationMinutes }));
    if (day.visits.length) {
      const first = places.find(place => place.placeId === day.visits[0].placeId)!;
      const last = places.find(place => place.placeId === day.visits.at(-1)!.placeId)!;
      const buffer = (pace === 'relaxed' || options.family ? 30 : 15)+policy.buffer;
      if (first.locationScope && distanceKm(anchor, first) > 1) busy[0].start = window.start;
      if (last.locationScope && distanceKm(anchor, last) > 1) busy.at(-1)!.end += Math.ceil(distanceKm(anchor, last) / transport.speed * 60) + buffer + (lunch && lunch.start >= finish ? 45 : 0);
    }
    if (!lunch) { const start = finish <= 720 ? Math.max(720, finish) : finish; if (start + 45 <= window.end) lunch = { start, end: start + 45 }; }
    if (lunch) busy.push(lunch);
    busy.sort((a, b) => a.start - b.start);
    for (const interval of busy) {
      if (interval.start - cursor >= 30 && day.visits.length) day.scheduleBlocks!.push({ kind: 'free-time', startMinutes: cursor, endMinutes: interval.start, label: 'Free time / rest — optional' });
      cursor = Math.max(cursor, interval.end);
    }
    if (lunch) day.scheduleBlocks!.push({ kind: 'meal', startMinutes: lunch.start, endMinutes: lunch.end, label: 'Meal break — venue not selected; meal prices need confirmation' });
    if (window.end - cursor >= 30) day.scheduleBlocks!.push({ kind: enough ? 'free-time' : 'unscheduled', startMinutes: cursor, endMinutes: window.end, label: enough ? 'Free time / rest — optional' : 'Unplanned time — additional verified places needed' });
    day.scheduleBlocks!.sort((a, b) => a.startMinutes - b.startMinutes);
    result.push(day);
  }
  return result;
}
