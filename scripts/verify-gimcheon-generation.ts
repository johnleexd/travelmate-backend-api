import fs from 'node:fs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
loadBackendEnvironment();
if (process.env.TRAVELMATE_ALLOW_ISOLATED_SCHEMA !== '1') throw new Error('This verification requires an isolated test schema.');
const directory = process.argv.includes('--membership') ? '../audit/2026-10-11/gimcheon-membership' : '../audit/2026-10-11/gimcheon-generation';
fs.mkdirSync(directory, { recursive: true });
const databaseUrl = new URL(process.env.DATABASE_URL!);
if (databaseUrl.hostname.endsWith('.neon.tech')) databaseUrl.hostname = databaseUrl.hostname.replace('-pooler.', '.');
const schema = 'travelmate_gimcheon_test_' + Date.now();
const pool = new pg.Pool({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 10000, max: 1, options: '-c search_path=' + schema });
let created = false;
let prisma: any;
const requests: any[] = [];
const fetchOriginal = globalThis.fetch;
try {
  const client = await pool.connect();
  try {
    // Inspect existing Gimcheon records without exposing account data or modifying them.
    const existing = await client.query('SELECT id, destination, itinerary, created_at AS "createdAt" FROM public.trips WHERE destination ILIKE $1 ORDER BY created_at DESC LIMIT 3', ['%Gimcheon%']);
    console.log(JSON.stringify({ event: 'existing_gimcheon_trips', trips: existing.rows.map(row => ({ id: row.id, destination: row.destination, createdAt: row.createdAt, source: row.itinerary?.source, placeDataStatus: row.itinerary?.grounding?.placeDataStatus, activityCounts: row.itinerary?.days?.map((day: any) => day.activities.filter((activity: any) => activity.place).length), photoCounts: row.itinerary?.days?.map((day: any) => day.activities.filter((activity: any) => activity.imageUrl).length) })) }));
    await client.query('CREATE SCHEMA "' + schema + '"'); created = true;
    for (const dir of fs.readdirSync('prisma/migrations').filter(name => fs.existsSync(`prisma/migrations/${name}/migration.sql`)).sort()) await client.query(fs.readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8'));
  } finally { client.release(); }
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/client.ts');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), options: '-c search_path=' + schema }, { schema }) });
  globalThis.travelmatePrisma = prisma;
  const { POST } = await import('../src/controllers/itinerary-controller.ts');
  const { GET_TRIP } = await import('../src/controllers/platform-controller.ts');
  const { executePlatformAction } = await import('../src/services/platform/platform-service.ts');
  const { publicUser } = await import('../src/schemas/domain.ts');
  const { createSessionToken } = await import('../src/middlewares/auth-middleware.ts');
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const started = Date.now();
    const response = await fetchOriginal(input, init);
    // Store complete public Wikimedia responses only; never store AI prompts or keys.
    const entry = { provider: url.hostname, path: url.pathname, status: response.status, durationMs: Date.now() - started,
      action: url.searchParams.get('action'), generator: url.searchParams.get('generator') };
    const index = requests.push(entry) - 1;
    if (url.hostname.endsWith('.wikipedia.org') || ['www.wikidata.org', 'commons.wikimedia.org', 'nominatim.openstreetmap.org'].includes(url.hostname)) fs.writeFileSync(`${directory}/generation-response-${index}.json`, await response.clone().text());
    console.log(JSON.stringify({ event: 'verification_provider_request', ...entry }));
    return response;
  };
  const owner = await prisma.user.create({ data: { name: 'Isolated Gimcheon tester', email: 'gimcheon-test@example.test', role: 'traveler', emailVerified: true } });
  const selected = searchDestinationIndex('Gimcheon').find(place => place.countryCode === 'KR')!;
  const anchor = { city: selected.name, country: selected.country, countryCode: selected.countryCode, latitude: selected.latitude, longitude: selected.longitude };
  const headers = { 'content-type': 'application/json', cookie: 'travelmate_session=' + createSessionToken(owner.id, 'traveler') };
  const body = { destination: selected.label, destinationDetails: anchor, latitude: anchor.latitude, longitude: anchor.longitude, startDate: '2026-10-11', endDate: '2026-10-17', budget: 1000000, currency: 'KRW', travelers: 1, partyType: 'solo', interests: ['culture', 'nature'], travelPace: 'balanced' };
  const response = await POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers, body: JSON.stringify(body) }));
  const plan = await response.json();
  assert.equal(response.status, 200, JSON.stringify(plan));
  const visits = plan.days.flatMap((day: any) => day.activities.filter((activity: any) => activity.place));
  assert.ok(visits.length > 0, 'No verified activity scheduled');
  const pictured = visits.filter((activity: any) => activity.imageUrl);
  assert.ok(pictured.length > 0, 'No exact-place photo returned');
  assert.ok(pictured.every((activity: any) => activity.imageAttribution?.sourceUrl.startsWith('https://commons.wikimedia.org/')));
  for (const activity of pictured) {
    const picture = await globalThis.fetch(activity.imageUrl, { signal: AbortSignal.timeout(15000) });
    const contentType = picture.headers.get('content-type');
    fs.writeFileSync(`${directory}/photo-${activity.place.placeId}.jpg`, Buffer.from(await picture.arrayBuffer()));
    assert.equal(picture.status, 200);
    assert.ok(contentType?.startsWith('image/'));
  }
  const saved = await executePlatformAction(publicUser(owner), 'save-trip', { ...body, itinerary: plan, weather: null });
  await prisma.$disconnect();
  const reopenedResponse = await GET_TRIP(new Request('http://localhost/api/platform/trips/' + saved.id, { headers }));
  assert.equal(reopenedResponse.status, 200);
  const { trip } = await reopenedResponse.json();
  assert.deepEqual(trip.itinerary.days, plan.days);
  assert.equal(await prisma.itineraryVersion.count({ where: { tripId: saved.id } }), 1);
  fs.writeFileSync(`${directory}/verified-reopened-trip.json`, JSON.stringify({ anchor, body, trip, requests }, null, 2));
  fs.writeFileSync('../travelmate-frontend-new/e2e/fixtures/gimcheon-reopened-trip.json', JSON.stringify({ anchor, body, trip }, null, 2));
  console.log(JSON.stringify({ event: 'generation_save_reopen_verified', generationStatus: response.status, source: plan.source, saveId: saved.id, reopenStatus: reopenedResponse.status,
    visits: visits.map((activity: any) => ({ id: activity.place.placeId, name: activity.place.name, imageUrl: activity.imageUrl })), dayCounts: plan.days.map((day: any) => day.activities.filter((activity: any) => activity.place).length), photoCounts: plan.days.map((day: any) => day.activities.filter((activity: any) => activity.imageUrl).length) }));
} catch (error) {
  console.log(JSON.stringify({ event: 'verification_failed', reason: String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted database address]').slice(0, 1000) }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = fetchOriginal;
  if (prisma) await prisma.$disconnect();
  if (created && /^travelmate_gimcheon_test_\d+$/.test(schema)) { await pool.query('DROP SCHEMA "' + schema + '" CASCADE'); console.log('Removed only the newly created isolated test schema.'); }
  await pool.end();
}
