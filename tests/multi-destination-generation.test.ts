import assert from 'node:assert/strict';
import test from 'node:test';
import { destinationReferences, referenceFetcher } from './helpers/multi-destination-references.ts';
import { retrieveGroundedPlaces } from '../src/services/itinerary/grounded-places.ts';
import { generateGroundedSchedule } from '../src/services/ai/grounded-schedule.ts';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { buildTripMapManifest } from '../src/services/navigation/trip-map-service.ts';

for (const reference of destinationReferences) test(`${reference.anchor.city}: provider records survive shared generation, save validation, reopen and map manifest`, async () => {
  const { anchor } = reference;
  const places = await retrieveGroundedPlaces(anchor, referenceFetcher(reference));
  const startDate = '2040-01-25', endDate = '2040-01-31';
  const provider = { name: 'openai' as const, generate: async () => JSON.stringify({ days: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, date: `2040-01-${25 + i}`, theme: 'Sparse AI output', visits: !i && places.length ? [{ placeId: places[0].placeId, startMinutes: 600, durationMinutes: 60, participants: 1 }] : [] })) }) };
  const days = await generateGroundedSchedule(provider, anchor, places, startDate, 7, 1, 'Budget and interests: culture, nature, food', undefined, 'balanced', { interests: ['culture','nature','food'] });
  const plan = buildGroundedPlan({ destination: `${anchor.city}, ${anchor.country}`, anchor, startingLocation: '', startDate, endDate, budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo', rooms: 1, places, placeDataStatus: 'live', source: 'openai', transportation: 'Walking', schedule: days });
  const reopened = parseSavedItinerary(JSON.parse(JSON.stringify(plan)), { budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo', startDate, destination: plan.destination, days: 7 });
  assert.equal(verifyGroundedPlan(reopened), true);
  assert.deepEqual(reopened.days, JSON.parse(JSON.stringify(plan.days)));
  assert.equal(reopened.grounding?.total, plan.grounding?.total);
  const visits = reopened.days.flatMap(day => day.activities.filter(activity => activity.place));
  assert.equal(new Set(visits.map(activity => activity.place!.placeId)).size, visits.length);
  const map = buildTripMapManifest({ id: 'test-only-trip', destination: plan.destination, itinerary: reopened });
  assert.deepEqual(map.days.flatMap(day => day.activities.filter(activity => !activity.budgetOnly).map(activity => activity.activityId)), visits.map(activity => activity.id));
  assert.deepEqual(map.days.flatMap(day => day.activities.filter(activity => !activity.budgetOnly).map(activity => activity.place?.id)), visits.map(activity => activity.place!.placeId));
  if (!places.length) {
    assert.ok(reopened.days.every(day => day.planningStatus === 'incomplete' && /coverage/.test(day.planningReason!)));
    assert.equal(visits.length, 0);
  } else {
    assert.deepEqual(reopened.days.map(day => day.activities.filter(activity => activity.place).length), [3,3,3,3,3,3,3]);
    assert.ok(reopened.days.every(day => day.planningStatus === 'suggested'));
    assert.ok(visits.some(activity => activity.description.startsWith('Opening hours need confirmation.')));
    for (const day of reopened.days) {
      const scheduled = day.activities.filter(activity => activity.place);
      assert.ok(scheduled.every(activity => activity.durationMinutes! >= 60 && activity.scheduleLabel === 'Suggested'));
      assert.ok(day.scheduleBlocks?.some(block => block.kind === 'meal'));
    }
  }
});
