// Disposable verification account/schema, real HTTP/storage/provider calls.
// Never reads or edits an existing traveler's records. The proxy is loopback-only.
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const directory = '../audit/2026-10-13/missing-activities/new-trip';
fs.mkdirSync(directory, { recursive: true });
const schema = 'travelmate_activity_photo_verify_' + Date.now();
const dbUrl = new URL(process.env.DATABASE_URL!);
if (dbUrl.hostname.endsWith('.neon.tech')) dbUrl.hostname = dbUrl.hostname.replace('-pooler.', '.');
const pool = new pg.Pool({ connectionString: dbUrl.toString(), options: '-c search_path=' + schema, max: 1, connectionTimeoutMillis: 15000 });
let prisma: any, api: any, proxy: any, created = false;
const originalFetch = globalThis.fetch;
const summary: any = { schema, googleRequests: 0, providers: { openai: !!process.env.OPENAI_API_KEY, gemini: !!process.env.GEMINI_API_KEY, unsplash: !!process.env.UNSPLASH_ACCESS_KEY }, events: [] };
try {
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA "' + schema + '"'); created = true;
    for (const name of fs.readdirSync('prisma/migrations').filter(name => fs.existsSync(`prisma/migrations/${name}/migration.sql`)).sort()) await client.query(fs.readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  } finally { client.release(); }
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/client.ts');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl.toString(), options: '-c search_path=' + schema }, { schema }) });
  (globalThis as any).travelmatePrisma = prisma;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).hostname === 'places.googleapis.com') { summary.googleRequests++; throw new Error('Google excluded from photo verification'); }
    return originalFetch(input, init);
  };
  const { default: app } = await import('../src/app.ts');
  api = await new Promise(resolve => { const listener = app.listen(5105, '127.0.0.1', () => resolve(listener)); });
  const user = await prisma.user.create({ data: { name: 'Photo workflow verification', email: 'photo-workflow@example.test', role: 'traveler', emailVerified: true, profileStatus: 'verified' } });
  const { createSessionToken } = await import('../src/middlewares/auth-middleware.ts');
  const token = createSessionToken(user.id, 'traveler');
  const { POST } = await import('../src/controllers/itinerary-controller.ts');
  const { executePlatformAction } = await import('../src/services/platform/platform-service.ts');
  const { publicUser } = await import('../src/schemas/domain.ts');
  const anchor = { city: 'Gimcheon', country: 'South Korea', countryCode: 'KR', latitude: 36.12176, longitude: 128.11981 };
  const body = { destination: 'Gimcheon, Gyeongsangbuk-do, South Korea', destinationDetails: anchor, latitude: anchor.latitude, longitude: anchor.longitude,
    startDate: '2026-10-20', endDate: '2026-10-26', budget: 1000000, currency: 'KRW', travelers: 1, partyType: 'solo', interests: ['food', 'culture', 'nature'], travelPace: 'balanced', transportation: 'metro / subway', provider: 'gemini' };
  const response = await POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'travelmate_session=' + token }, body: JSON.stringify(body) }));
  const plan = await response.json();
  if (!response.ok) throw new Error('Generation failed: ' + JSON.stringify(plan));
  const saved = await executePlatformAction(publicUser(user), 'save-trip', { ...body, itinerary: plan, weather: null });
  summary.generation = { source: plan.source, tripId: saved.id, counts: plan.days.map((day: any) => day.activities.filter((a: any) => !!a.place).length) };
  fs.writeFileSync(directory + '/generated-and-saved.json', JSON.stringify({ body, plan, trip: saved }, null, 2));
  console.log(JSON.stringify(summary.generation));
  proxy = http.createServer((request, response) => {
    const backend = request.url?.startsWith('/api/');
    const target = http.request({ hostname: '127.0.0.1', port: backend ? 5105 : 3000, path: request.url, method: request.method, headers: { ...request.headers, host: backend ? 'localhost:5105' : 'localhost:3000', origin: 'http://localhost:3000', cookie: 'travelmate_session=' + token } }, upstream => {
      response.writeHead(upstream.statusCode || 502, { ...upstream.headers, 'cache-control': 'no-store' }); upstream.pipe(response);
    });
    target.on('error', () => { response.writeHead(502); response.end('Verification service unavailable'); }); request.pipe(target);
  });
  // Next's development hydration waits for its HMR handshake.
  proxy.on('upgrade', (request: any, socket: any, head: any) => {
    const target = http.request({ hostname: '127.0.0.1', port: 3000, path: request.url, headers: { ...request.headers, host: 'localhost:3000', origin: 'http://localhost:3000' } });
    target.on('upgrade', (upstream, remote, extra) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(upstream.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (head.length) remote.write(head); if (extra.length) socket.write(extra);
      remote.pipe(socket); socket.pipe(remote); remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    });
    target.on('error', () => socket.destroy()); target.end();
  });
  await new Promise<void>(resolve => proxy.listen(3002, '127.0.0.1', resolve));
  fs.writeFileSync(directory + '/ready.json', JSON.stringify({ url: 'http://localhost:3002/dashboard', schema, providers: summary.providers }, null, 2));
  console.log('Verification ready at http://localhost:3002/dashboard?tab=planner&trip=' + saved.id + '&from=saved');
  while (!fs.existsSync(directory + '/stop')) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const trips = await prisma.trip.findMany({ where: { userId: user.id } });
    fs.writeFileSync(directory + '/live-trips.json', JSON.stringify(trips, null, 2));
  }
} catch (error) { summary.error = error instanceof Error ? error.message : String(error); console.error(summary.error); }
finally {
  globalThis.fetch = originalFetch;
  proxy?.close(); api?.close(); await prisma?.$disconnect();
  if (created) await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
  await pool.end(); summary.cleanedUp = created;
  fs.writeFileSync(directory + '/runtime-summary.json', JSON.stringify(summary, null, 2));
}
