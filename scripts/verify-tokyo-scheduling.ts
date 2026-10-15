import fs from 'node:fs';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { loadGroundedPlaces } from '../src/services/itinerary/grounded-places.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { generationDefaults } from '../src/services/itinerary/travel-preferences.ts';
loadBackendEnvironment();
const directory = '../audit/2026-10-15/tokyo-day-one';
const { trip } = JSON.parse(fs.readFileSync(directory + '/saved-capture.json', 'utf8'));
const anchor = trip.itinerary.grounding.destination;
const catalog = await loadGroundedPlaces(anchor, AbortSignal.timeout(120000), false);
if (!catalog.places.length) throw Error('Current verified catalog unavailable; no schedule or saved trip was modified.');
const diagnostics: Record<string, unknown>[] = [];
const schedule = completeGroundedSchedule(anchor, catalog.places, [], trip.start_date, trip.itinerary.days.length, trip.travelers, generationDefaults.pace, {
  interests: trip.interests, preferredActivities: trip.itinerary.preferences.activities,
  travelStyle: generationDefaults.travelStyle, transportation: trip.itinerary.preferences.transportation,
  currency: trip.currency, visitBudget: Number(trip.budget), diagnostics: event => diagnostics.push(event),
});
const result = { note: 'Read-only current-provider scheduler replay. No AI call, trip save, or regeneration.', tripId: trip.id,
  preferences: { ...generationDefaults, interests: trip.interests, activities: trip.itinerary.preferences.activities, transportation: trip.itinerary.preferences.transportation },
  catalog, diagnostics, schedule,
  counts: schedule.map(day => day.visits.length),
  places: schedule.map(day => ({ day: day.day, status: day.planningStatus, reason: day.planningReason, visits: day.visits.map(visit => ({ ...visit, name: catalog.places.find(place => place.placeId === visit.placeId)?.name })) })),
};
fs.writeFileSync(directory + '/current-scheduler-replay.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ catalogStatus: catalog.status, catalogCount: catalog.places.length, counts: result.counts, day1: result.places[0], uniqueVisits: new Set(schedule.flatMap(day => day.visits.map(visit => visit.placeId))).size }, null, 2));
