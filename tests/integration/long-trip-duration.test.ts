import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { searchDestinationIndex } from '../../src/services/destination/destination-index.ts';
import { POST } from '../../src/controllers/itinerary-controller.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
after(() => prisma.$disconnect());

test('authenticated generation, saving, reloading and editing preserve every date through day 31', { timeout: 60000 }, async t => {
  const startDate = '2040-01-25';
  const dateAt = (offset: number) => new Date(Date.parse(startDate) + offset * 86400000).toISOString().slice(0, 10);
  const keys = ['AI_PROVIDER', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_MOCK_FALLBACK'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-fixture-only', AI_MOCK_FALLBACK: 'false' });
  delete process.env.GEMINI_API_KEY;
  t.after(() => { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).includes('api.openai.com')) {
      calls++;
      const body = JSON.parse(String(init?.body));
      const [, countText, firstDate] = body.messages[1].content.match(/Plan (\d+) days, starting (\d{4}-\d{2}-\d{2})/);
      const count = Number(countText);
      const days = Array.from({ length: count }, (_, i) => ({ day: i + 1, date: new Date(Date.parse(firstDate) + i * 86400000).toISOString().slice(0, 10), theme: 'Flexible supported day', visits: [] }));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ days }) } }] });
    }
    return Response.json({}, { status: 503 });
  });
  const row = await prisma.user.create({ data: { email: `long-trip-${Date.now()}@example.test`, name: 'Duration Integration', role: 'traveler', emailVerified: true } });
  const user = publicUser(row);
  const headers = { cookie: `travelmate_session=${createSessionToken(row.id, row.role)}`, 'Content-Type': 'application/json' };
  try {
    for (const count of [1, 14, 21, 28, 31]) {
      const paris = searchDestinationIndex('Paris, France').find(place => place.name === 'Paris')!;
      const body = { destination: 'Paris, France', startingLocation: 'Toronto, Canada', latitude: paris.latitude, longitude: paris.longitude, destinationDetails: { city: paris.name, country: paris.country, countryCode: paris.countryCode, latitude: paris.latitude, longitude: paris.longitude }, startDate, endDate: dateAt(count - 1), budget: 100000, currency: 'EUR', partyType: 'friends', travelers: 3 };
      const result = await POST(new Request('http://localhost/api/itinerary', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': `long-trip-${row.id}-${count}` },
        body: JSON.stringify(body),
      }));
      assert.equal(result.status, 200);
      const itinerary = await result.json();
      assert.equal(itinerary.days.length, count); assert.equal(itinerary.days.at(-1).date, body.endDate);
      assert.ok(itinerary.budgetSummary.plannedSpend <= body.budget);
      assert.ok(itinerary.days.every((day: { weatherAlert?: string }) => !day.weatherAlert));
      const saved = await executePlatformAction(user, 'save-trip', { ...body, itinerary });
      const stored = await prisma.trip.findUniqueOrThrow({ where: { id: saved.id } });
      assert.equal(stored.endDate.toISOString().slice(0, 10), body.endDate);
      assert.equal((stored.itinerary as typeof itinerary).days.length, count);
      const edited = structuredClone(itinerary); edited.days.at(-1).activities[0].estimatedCost = 75;
      await executePlatformAction(user, 'update-trip-itinerary', { id: saved.id, itinerary: edited });
      const reloaded = await prisma.trip.findUniqueOrThrow({ where: { id: saved.id } });
      assert.equal((reloaded.itinerary as typeof itinerary).days.at(-1).date, body.endDate);
      assert.equal((reloaded.itinerary as typeof itinerary).days.at(-1).activities[0].estimatedCost, 75);
    }
    assert.equal(calls, 1 + 2 + 3 + 4 + 5);
    const invalid = await POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers, body: JSON.stringify({ destination: 'Paris', startDate, endDate: dateAt(31), budget: 100000, currency: 'EUR' }) }));
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /1 and 31/);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { actorId: row.id } });
    await prisma.trip.deleteMany({ where: { userId: row.id } });
    await prisma.itineraryGeneration.deleteMany({ where: { userId: row.id } });
    await prisma.user.delete({ where: { id: row.id } });
  }
});
