import fs from 'node:fs';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { retrieveGroundedPlaces, distanceKm } from '../src/services/itinerary/grounded-places.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
loadBackendEnvironment();
const directory = '../audit/2026-10-13/missing-activities';
const before = JSON.parse(fs.readFileSync(directory + '/affected-trip-before.json', 'utf8'));
const plan = before.trip.itinerary, anchor = plan.grounding.destination;
const events: any[] = [], requests: any[] = [], pages: any[] = [], entities: Record<string, any> = {};
const originalInfo = console.info;
console.info = (...args) => { for (const arg of args) { try { const event = JSON.parse(arg); if (event.event) events.push(event); } catch {} } originalInfo(...args); };
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), response = await fetch(input, init);
  const payload = await response.clone().text();
  const index = requests.push({ host: url.hostname, action: url.searchParams.get('action'), generator: url.searchParams.get('generator'), status: response.status }) - 1;
  fs.writeFileSync(`${directory}/provider-${index}.json`, payload);
  try { const data = JSON.parse(payload); if (data.entities) Object.assign(entities, data.entities); if (url.hostname.endsWith('.wikipedia.org')) pages.push(...Object.values(data.query?.pages ?? {})); } catch {}
  return response;
};
try {
  const places = await retrieveGroundedPlaces(anchor, fetcher);
  const unique = [...new Map(pages.map(page => [page.pageprops?.wikibase_item || page.title, page])).entries()];
  const validation = events.find(event => event.event === 'place_catalog_validation');
  const reasons = new Map(validation.rejected.map((entry: any) => [entry.placeId, entry.reason]));
  const rejected = unique.flatMap(([id, page]) => reasons.has(id) ? [{ placeId: id, title: entities[id]?.labels?.en?.value || page.title, description: entities[id]?.descriptions?.en?.value, reason: reasons.get(id) }] : []);
  const filters = ['missing-id-or-invalid-coordinates', 'outside-supported-radius', 'not-a-supported-attraction', 'no-longer-existing-or-proposed', 'conflicting-country-evidence', 'conflicting-coordinate-evidence', 'city-or-country-membership-unverified', 'conflicting-city-boundary-evidence', 'part-of-visit'];
  let remaining = unique.length;
  const stages = filters.map(filter => { const removed = rejected.filter(entry => String(entry.reason).startsWith(filter)).length; remaining -= removed; return { filter, removed, remaining }; });
  const schedule = completeGroundedSchedule(anchor, places, [], plan.grounding.startDate, plan.days.length, before.trip.travelers, plan.preferences?.pace || 'balanced', { interests: before.trip.interests });
  const result = { tripId: before.trip.id, anchor, requests, returnedArticles: pages.length, uniqueCandidates: unique.length, stages, rejected, catalog: places.map(place => ({ ...place, distanceKm: distanceKm(anchor, place) })), photoCount: places.filter(place => place.imageUrl).length, missingHours: places.filter(place => !place.openingWindows?.length).length, schedule, scheduledCount: schedule.reduce((sum, day) => sum + day.visits.length, 0), events };
  fs.writeFileSync(directory + '/live-diagnosis.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ tripId: result.tripId, returnedArticles: result.returnedArticles, uniqueCandidates: result.uniqueCandidates, stages, accepted: places.length, photoCount: result.photoCount, missingHours: result.missingHours, places: places.map(place => ({ id: place.placeId, name: place.name, distanceKm: distanceKm(anchor, place), scope: place.locationScope })), dayCounts: schedule.map(day => day.visits.length), scheduledCount: result.scheduledCount }, null, 2));
} finally { console.info = originalInfo; }
