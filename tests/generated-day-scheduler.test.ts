import assert from 'node:assert/strict';
import test from 'node:test';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { generateGroundedSchedule, validateGroundedSchedule, dateAt } from '../src/services/ai/grounded-schedule.ts';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { buildTripMapManifest } from '../src/services/navigation/trip-map-service.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import type { GroundedPlace } from '../src/services/itinerary/grounded-places.ts';
import type { SchedulingOptions } from '../src/services/itinerary/generated-day-scheduler.ts';
const anchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
const start = '2040-01-25';
const places = (count: number): GroundedPlace[] => Array.from({ length: count }, (_, i) => ({ ...anchor, latitude: anchor.latitude + i * 0.0002, provider: 'wikidata', placeId: `Q${100 + i}`, name: `Synthetic museum ${i}`, description: 'Synthetic art museum fixture, not real travel data.', fetchedAt: '2026-10-11T00:00:00.000Z', sourceUrl: `https://www.wikidata.org/wiki/Q${100 + i}`, openingHours: 'Not available; confirm with venue', address: 'Not available' }));
const schedule = (catalog: GroundedPlace[], days = 3, pace: 'relaxed' | 'balanced' | 'active' = 'balanced', options: SchedulingOptions = {}) => completeGroundedSchedule(anchor, catalog, [], start, days, 2, pace, options);
function assertSchedule(days: ReturnType<typeof schedule>, catalog: GroundedPlace[], pace: 'relaxed' | 'balanced' | 'active' = 'balanced') {
  const pure = days.map(({ day, date, theme, visits }) => ({ day, date, theme, visits }));
  // Catalog, opening windows, dates, party, overlap and geographic transfers all validated independently.
  validateGroundedSchedule(JSON.stringify({ days: pure }), catalog, start, days.length, 2, new Set(), pace);
  for (const day of days) for (const block of day.scheduleBlocks ?? []) {
    assert.ok(block.startMinutes < block.endMinutes);
    assert.ok(!day.visits.some(v => block.startMinutes < v.startMinutes + v.durationMinutes && block.endMinutes > v.startMinutes));
  }
}
test('sufficient verified places repair a one-visit AI answer into useful multi-day recommendations', async () => {
  const catalog = places(12);
  const ai = { name: 'openai' as const, generate: async () => JSON.stringify({ days: Array.from({ length: 3 }, (_, i) => ({ day: i + 1, date: dateAt(start, i), theme: 'Sparse AI answer', visits: i === 0 ? [{ placeId: 'Q100', startMinutes: 600, durationMinutes: 90, participants: 2 }] : [] })) }) };
  const days = await generateGroundedSchedule(ai, anchor, catalog, start, 3, 2, 'Art and culture, moderate budget');
  assert.deepEqual(days.map(day => day.visits.length), [3, 3, 3]);
  assert.ok(days.every(day => day.planningStatus === 'suggested'));
  assert.ok(days.every(day => day.scheduleBlocks?.some(block => block.kind === 'meal') && day.scheduleBlocks.some(block => block.kind === 'free-time')));
  assert.equal(new Set(days.flatMap(day => day.visits.map(v => v.placeId))).size, 9);
  assertSchedule(days, catalog);
});
test('limited coverage is fairly spread and allowances-only days remain explicitly incomplete', () => {
  const catalog = places(2), days = schedule(catalog, 4);
  assert.deepEqual(days.map(day => day.visits.length), [1, 1, 0, 0]);
  assert.ok(days.every(day => day.planningStatus === 'incomplete'));
  assert.ok(days.at(-1)?.scheduleBlocks?.every(block => block.kind !== 'free-time'));
  const unavailable = schedule([], 3, 'balanced', { providerUnavailable: true });
  assert.ok(unavailable.every(day => day.planningStatus === 'incomplete' && /unavailable/.test(day.planningReason!)));
  assertSchedule(days, catalog);
});
test('unschedulable catalog places do not consume later days allocation', () => {
  const feasible = places(7).map((place, i) => ({ ...place, description: 'temple', latitude: anchor.latitude + 0.02 + i * 0.008, locationScope: 'city' as const }));
  const tooDistant = places(31).map((place, i) => ({ ...place, placeId: `Q${500 + i}`, description: 'temple', latitude: anchor.latitude + 0.20, locationScope: 'city' as const }));
  const events: Record<string, unknown>[] = [];
  const days = schedule([...feasible, ...tooDistant], 7, 'balanced', { diagnostics: event => events.push(event) });
  assert.deepEqual(days.map(day => day.visits.length), [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(events[0].feasibleRemaining, 7);
  assert.equal(events[0].target, 1);
  assert.ok(days.every(day => day.planningStatus === 'incomplete')); // One short visit is not a resolved full sightseeing day.
  assertSchedule(days, [...feasible, ...tooDistant]);
});
test('relaxed pace, arrival/departure buffers and user rest days are respected', () => {
  const catalog = places(20);
  const relaxed = schedule(catalog, 3, 'relaxed');
  assert.deepEqual(relaxed.map(day => day.visits.length), [2, 2, 2]);
  assert.ok(relaxed.every(day => day.visits.every(v => v.durationMinutes === 120)));
  assertSchedule(relaxed, catalog, 'relaxed');
  const bounded = schedule(catalog, 4, 'balanced', { constraints: { arrivalTime: '14:00', departureTime: '13:00', restDates: [dateAt(start, 1)] } });
  assert.ok(bounded[0].visits.every(v => v.startMinutes >= 930));
  assert.equal(bounded[1].planningStatus, 'rest'); assert.equal(bounded[1].visits.length, 0);
  assert.ok(bounded[3].visits.every(v => v.startMinutes + v.durationMinutes <= 660));
  assertSchedule(bounded, catalog);
  const travelOnly = schedule(catalog, 1, 'balanced', { constraints: { arrivalTime: '20:00', departureTime: '21:00', restDates: [] } });
  assert.equal(travelOnly[0].planningStatus, 'travel'); assert.equal(travelOnly[0].visits.length, 0);
});
test('duplicate IDs, wrong cities/countries and bad coordinates never become recommended stops', () => {
  const catalog = places(9);
  const mixed = [...catalog, ...catalog, { ...catalog[0], placeId: 'Q999', city: 'Lyon' }, { ...catalog[0], placeId: 'Q998', countryCode: 'JP' }, { ...catalog[0], placeId: 'Q997', latitude: NaN }];
  const days = schedule(mixed);
  assert.equal(new Set(days.flatMap(day => day.visits.map(v => v.placeId))).size, 9);
  assert.ok(days.flatMap(day => day.visits).every(v => catalog.some(p => p.placeId === v.placeId)));
  assertSchedule(days, catalog);
});
test('nearby grouping, reference hours, long durations and date-matched indoor recommendations', () => {
  const catalog = places(9).map((p, i) => ({ ...p, latitude: anchor.latitude + Math.floor(i / 3) * 0.025 + (i % 3) * 0.0001 }));
  const days = schedule(catalog);
  assert.ok(days.every(day => new Set(day.visits.map(v => Math.floor((Number(v.placeId.slice(1)) - 100) / 3))).size === 1));
  assertSchedule(days, catalog);
  const weekday = new Date(`${start}T00:00:00Z`).getUTCDay();
  const tooShort = { ...catalog[0], openingWindows: [{ weekdays: [weekday], startMinutes: 600, endMinutes: 620 }] };
  assert.equal(schedule([tooShort], 1)[0].visits.length, 0); // Known reference cannot fit this visit's duration.
  const partialHours = { ...catalog[0], openingWindows: [{ weekdays: [(weekday + 1) % 7], startMinutes: 600, endMinutes: 1020 }] };
  assert.equal(schedule([partialHours], 1)[0].visits.length, 1); // An unreferenced weekday is unknown, not closed.
  const long = completeGroundedSchedule(anchor, catalog, [{ day: 1, date: start, theme: 'Long visit', visits: [{ placeId: 'Q100', startMinutes: 540, durationMinutes: 300, participants: 2 }] }], start, 1, 2, 'balanced');
  assert.equal(long[0].visits.length, 1); assert.equal(long[0].visits[0].durationMinutes, 300); assert.equal(long[0].planningStatus, 'suggested'); assertSchedule(long, catalog);
  const wetPlaces = [{ ...catalog[0], name: 'Outdoor art garden', description: 'garden' }, { ...catalog[1], name: 'Indoor art museum', description: 'museum' }];
  const wet = schedule(wetPlaces, 1, 'balanced', { weather: [{ date: start, description: 'thunderstorm', precipitationProbability: 100, tempMax: 29 }] });
  assert.equal(wet[0].visits[0].placeId, 'Q101'); assert.match(wet[0].planningReason!, /indoor/);
  const outOfRangeWeather = schedule(wetPlaces, 1, 'balanced', { weather: [{ date: '2030-01-01', description: 'thunderstorm', precipitationProbability: 100, tempMax: 29 }] });
  assert.doesNotMatch(outOfRangeWeather[0].planningReason!, /indoor/);
});
test('save/reopen retains stable IDs, duration, places, photo/cost evidence and map coordinates without budget duplication', () => {
  const catalog = places(9); catalog[0].imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/test-museum.jpg'; catalog[0].imageAttribution = { creator: 'Fixture photographer', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:test-museum.jpg' };
  const plan = buildGroundedPlan({ destination: 'Paris, France', anchor, startingLocation: '', startDate: start, endDate: dateAt(start, 2), budget: 10000, currency: 'EUR', travelers: 2, partyType: 'couple', rooms: 1, places: catalog, placeDataStatus: 'live', source: 'openai', transportation: 'Walking', schedule: schedule(catalog), timeZone: 'Europe/Paris' });
  const context = { days: 3, currency: 'EUR' as const, budget: 10000, travelers: 2, partyType: 'couple' as const, startDate: start, destination: plan.destination };
  const reopened = parseSavedItinerary(JSON.parse(JSON.stringify(parseSavedItinerary(plan, context))), context);
  assert.deepEqual(reopened.days, JSON.parse(JSON.stringify(plan.days))); assert.equal(reopened.grounding?.timeZone, 'Europe/Paris'); assert.ok(verifyGroundedPlan(reopened));
  const activities = reopened.days.flatMap(day => day.activities);
  assert.equal(new Set(activities.map(a => a.id)).size, activities.length);
  assert.equal(Math.round(reopened.grounding!.categories.activities * 100), Math.round(activities.filter(a => a.category === 'activity').reduce((sum, a) => sum + a.estimatedCost, 0) * 100));
  assert.equal(Math.round(reopened.grounding!.total * 100), Math.round((reopened.days.reduce((sum, day) => sum + day.totalCost, 0) + reopened.grounding!.contingencyAmount) * 100));
  const map = buildTripMapManifest({ id: 'fixture-trip', destination: plan.destination, itinerary: reopened });
  assert.ok(map.days.every(day => day.activities.filter(a => !a.budgetOnly).length === 3));
  assert.deepEqual(map.days[0].activities[0].place?.latitude, reopened.days[0].activities[0].place?.latitude);
  assert.equal(map.days[0].activities[0].activityId, reopened.days[0].activities[0].id);
  for (const item of activities.filter(a => a.category === 'activity')) assert.ok(item.description.includes(`${item.durationMinutes}-minute visit`));
  const edit = structuredClone(reopened); edit.days[0].activities[0].time = '08:00 AM';
  const savedEdit = applyManualItineraryChanges(reopened, edit, 3, 10000, 2, 'EUR') as typeof reopened;
  assert.equal(savedEdit.days[0].activities[0].id, reopened.days[0].activities[0].id); assert.equal(savedEdit.days[0].activities[0].scheduleLabel, undefined);
  assert.equal(plan.days[0].activities[0].time, reopened.days[0].activities[0].time); // No silent regeneration or mutation.
});
