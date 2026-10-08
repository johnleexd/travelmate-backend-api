import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { manualPlaceKey, visitDate } from '../src/services/platform/visited-place-service.ts';
import { saveIdentity } from '../src/services/platform/save-idempotency.ts';
import { validateActivitySchedule, rescheduleActivities, timeMinutes } from '../src/services/itinerary/activity-schedule.ts';
import { prisma } from '../src/lib/prisma.ts';
after(() => prisma.$disconnect());

test('visit dates reject nonexistent days and future dates using the traveler time zone', () => {
  const now = new Date('2026-10-08T00:30:00Z');
  assert.equal(visitDate('2026-10-08', 'Asia/Shanghai', now).toISOString().slice(0, 10), '2026-10-08');
  assert.throws(() => visitDate('2026-10-08', 'America/Los_Angeles', now), /already happened/);
  for (const value of ['2026-02-30', '2026-10-09', 'invalid']) assert.throws(() => visitDate(value, 'UTC', now));
  assert.throws(() => visitDate('2026-10-07', 'not-a-time-zone', now), /time zone/);
});
test('manual place identities normalize spelling case and whitespace, retaining distinct destinations', () => {
  assert.equal(manualPlaceKey('  National  Museum ', 'Manila, Philippines'), manualPlaceKey('national museum', 'MANILA, PHILIPPINES'));
  assert.notEqual(manualPlaceKey('National Museum', 'Manila'), manualPlaceKey('National Museum', 'Tokyo'));
});
test('save requests use stable content hashes and bind explicit keys to their payload', () => {
  const a = saveIdentity({ action: 'save-trip', itinerary: { title: 'Paris', days: [1, 2] }, budget: 100 });
  const b = saveIdentity({ budget: 100, itinerary: { days: [1, 2], title: 'Paris' }, action: 'save-trip' });
  assert.deepEqual(a, b);
  assert.notEqual(a.hash, saveIdentity({ itinerary: { title: 'Rome', days: [1, 2] }, budget: 100 }).hash);
  assert.equal(saveIdentity({ saveKey: 'request-123', budget: 100 }).key, 'request-123');
  assert.throws(() => saveIdentity({ saveKey: '../../bad' }));
});
test('activity schedules preserve geographic buffers, reject overlaps, and reschedule reorder operations', () => {
  assert.equal(timeMinutes('02:15 PM'), 855); assert.equal(timeMinutes('00:15'), 15); assert.equal(timeMinutes('24:00'), null);
  const a = { title: 'A', time: '09:00', durationMinutes: 60, place: { latitude: 0, longitude: 0 } };
  const b = { title: 'B', time: '10:15', durationMinutes: 60, travelMinutes: 0, place: { latitude: 0, longitude: 0.01 } };
  assert.throws(() => validateActivitySchedule([a, b]), /overlaps/);
  const checked = validateActivitySchedule([a, { ...b, time: '11:00' }]);
  assert.ok(checked[1].travelMinutes! > 15);
  const reordered = rescheduleActivities([{ ...b, time: '11:00' }, a]);
  assert.equal(reordered[0].time, '09:00'); assert.ok(timeMinutes(reordered[1].time)! >= 630);
  assert.throws(() => validateActivitySchedule([{ title: 'Late', time: '23:30', durationMinutes: 60 }]), /same day/);
  assert.throws(() => validateActivitySchedule([{ title: 'Bad', time: 'morning-ish', durationMinutes: 60 }]), /valid time/);
  assert.equal(validateActivitySchedule([{ title: 'Flexible stop', time: 'Flexible', durationMinutes: 60 }]).length, 1);
});
