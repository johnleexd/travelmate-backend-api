import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const { prisma } = await import('../src/lib/prisma.ts');
const { createSessionToken } = await import('../src/middlewares/auth-middleware.ts');
const { emptyGeneratedDays } = await import('../src/services/itinerary/incomplete-trip-repair.ts');
const directory = '../audit/2026-10-13/missing-activities';
try {
  const first = JSON.parse(fs.readFileSync(directory + '/repair-live-first-results.json', 'utf8'));
  const second = JSON.parse(fs.readFileSync(directory + '/repair-live-results.json', 'utf8'));
  const repaired = [...first.filter((row: any) => row.applied), ...second.filter((row: any) => row.applied)];
  const results = [];
  for (const item of repaired) {
    const evidence = JSON.parse(fs.readFileSync(`${directory}/repair-${item.id}.json`, 'utf8'));
    const row = await prisma.trip.findUniqueOrThrow({ where: { id: item.id } });
    const plan = row.itinerary as any;
    assert.deepEqual(plan, evidence.proposedItinerary);
    for (const day of evidence.original.itinerary.days) {
      const after = plan.days[day.day - 1];
      if (day.activities.length) assert.deepEqual(after.activities.slice(-day.activities.length), day.activities);
      if (!item.changedDays.includes(day.day)) assert.deepEqual(after, day);
    }
    const versions = await prisma.itineraryVersion.findMany({ where: { tripId: item.id }, orderBy: { version: 'desc' } });
    assert.equal(versions[0].kind, 'regenerated');
    assert.deepEqual((versions[0].itinerary as any).itinerary, plan);
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: row.userId }, select: { sessionVersion: true } });
    const response = await fetch('http://127.0.0.1:5000/api/platform/trips/' + row.id, { headers: { cookie: 'travelmate_session=' + createSessionToken(row.userId, 'traveler', owner.sessionVersion) } });
    assert.equal(response.status, 200);
    const { trip } = await response.json();
    assert.deepEqual(trip.itinerary, plan);
    results.push({ id: row.id, destination: row.destination, dayCounts: plan.days.map((day: any) => day.activities.filter((a: any) => !!a.place).length), version: versions[0].version, databaseMatchesAPI: true, savedEntriesPreserved: true, filledDays: item.changedDays.length, added: item.added });
  }
  const active = await prisma.trip.findMany({ where: { status: 'active' } });
  const remainingEligibleEmptyDays = active.reduce((sum, row) => sum + emptyGeneratedDays(row.itinerary as any).length, 0);
  assert.equal(remainingEligibleEmptyDays, 0);
  const report = { results, repairedTrips: results.length, addedVisits: results.reduce((sum, row) => sum + row.added, 0), filledDays: results.reduce((sum, row) => sum + row.filledDays, 0), remainingEligibleEmptyDays, passed: true };
  fs.writeFileSync(directory + '/storage-api-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await prisma.$disconnect(); }
