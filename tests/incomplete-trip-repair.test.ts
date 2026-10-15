import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { emptyGeneratedDays, repairIncompleteTrip } from '../src/services/itinerary/incomplete-trip-repair.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import type { GroundedPlace } from '../src/services/itinerary/grounded-places.ts';
const anchor = { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 };
const catalog: GroundedPlace[] = Array.from({ length: 6 }, (_, i) => ({ ...anchor, latitude: anchor.latitude + i * 0.001, provider: 'wikidata', placeId: `Q${100 + i}`, name: `Synthetic museum ${i}`, description: 'Synthetic art museum fixture, not real travel data.', fetchedAt: '2026-10-13T00:00:00.000Z', sourceUrl: `https://www.wikidata.org/wiki/Q${100 + i}`, openingHours: 'Opening hours need confirmation', address: 'Not available' }));
const original = () => buildGroundedPlan({ destination: 'Paris, France', anchor, startingLocation: '', startDate: '2040-01-25', endDate: '2040-01-27', budget: 10000, currency: 'EUR', travelers: 1, partyType: 'solo', rooms: 1, places: [], placeDataStatus: 'live', source: 'catalog', transportation: 'Walking', schedule: completeGroundedSchedule(anchor, [], [], '2040-01-25', 3, 1, 'balanced') });
test('repair saves real catalog visits without photos or known hours and retains allowances and totals', () => {
  const before = original(), snapshot = structuredClone(before);
  const repair = repairIncompleteTrip(before, catalog);
  assert.equal(repair.added, 6); assert.deepEqual(repair.days, [1, 2, 3]);
  assert.deepEqual(before, snapshot);
  for (const day of repair.plan.days) {
    assert.deepEqual(day.activities.filter(a => !a.place), before.days[day.day - 1].activities);
    assert.equal(day.activities.filter(a => !!a.place).length, 2);
    assert.ok(day.activities.filter(a => !!a.place).every(a => !a.imageUrl && /Opening hours need confirmation/.test(a.description)));
    assert.equal(day.totalCost, Math.round((before.days[day.day - 1].totalCost + day.activities.filter(a => !!a.place).reduce((sum, a) => sum + a.estimatedCost, 0)) * 100) / 100);
  }
  const reopened = parseSavedItinerary(JSON.parse(JSON.stringify(repair.plan)), { days: 3, currency: 'EUR', budget: 10000, travelers: 1, partyType: 'solo', destination: before.destination, startDate: '2040-01-25' });
  assert.ok(verifyGroundedPlan(reopened)); assert.deepEqual(reopened.days, JSON.parse(JSON.stringify(repair.plan.days)));
  assert.equal(repairIncompleteTrip(reopened, catalog).added, 0);
});
test('populated, rest, user-created and manually edited days are preserved; old explicit empty themes can repair', () => {
  const plan = original();
  plan.days[0].planningStatus = 'rest';
  plan.days[1].planningStatus = undefined;
  plan.days[2].activities.unshift({ id: 'user', title: 'My appointment', time: 'Flexible', description: 'Personal note', estimatedCost: 0, category: 'activity', icon: 'map' });
  assert.deepEqual(emptyGeneratedDays(plan).map(day => day.day), [2]);
  const repaired = repairIncompleteTrip(plan, catalog);
  assert.deepEqual(repaired.plan.days[0], plan.days[0]); assert.deepEqual(repaired.plan.days[2], plan.days[2]);
  assert.equal(emptyGeneratedDays({ ...plan, manuallyEdited: true } as typeof plan).length, 0);
  assert.equal(repairIncompleteTrip(plan, []).added, 0);
});
