import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';

// Run only as an explicit verification. All database writes use a new isolated
// schema; application accounts and trips are neither edited nor deleted.
loadBackendEnvironment();
if (process.env.TRAVELMATE_ALLOW_ISOLATED_SCHEMA !== '1') throw new Error('Set TRAVELMATE_ALLOW_ISOLATED_SCHEMA=1 for this isolated verification.');
const schema = 'travelmate_google_photos_test_' + Date.now();
const databaseUrl = new URL(process.env.DATABASE_URL!);
if (databaseUrl.hostname.endsWith('.neon.tech')) databaseUrl.hostname = databaseUrl.hostname.replace('-pooler.', '.');
const pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 10000, options: '-c search_path=' + schema });
const directory = '../audit/2026-10-12/google-places-photos';
fs.mkdirSync(directory, { recursive: true });
const summary: Record<string, unknown> = { isolatedDatabase: true, activity: 'Jikjisa', destination: 'Gimcheon, South Korea', stages: [] };
const providerRequests: { operation: string; status: number }[] = [];
const fetchOriginal = globalThis.fetch;
let created = false, prisma: any, server: any, browser: any, page: any;
try {
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA "' + schema + '"'); created = true;
    for (const migration of fs.readdirSync('prisma/migrations').filter(name => fs.existsSync(`prisma/migrations/${name}/migration.sql`)).sort()) await client.query(fs.readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
  } finally { client.release(); }
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/client.ts');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), options: '-c search_path=' + schema }, { schema }) });
  globalThis.travelmatePrisma = prisma;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = await fetchOriginal(input, init);
    if (url.hostname === 'places.googleapis.com') providerRequests.push({ operation: url.pathname.includes('searchText') ? 'text-search' : url.pathname.endsWith('/media') ? 'photo' : 'details', status: response.status });
    return response;
  };
  const { default: app } = await import('../src/app.ts');
  server = await new Promise(resolve => { const listener = app.listen(5102, '127.0.0.1', () => resolve(listener)); });
  const { createSessionToken } = await import('../src/middlewares/auth-middleware.ts');
  const user = await prisma.user.create({ data: { name: 'Isolated Google photo tester', email: 'google-photos-isolated@example.test', role: 'traveler', emailVerified: true, profileStatus: 'verified' } });
  const token = createSessionToken(user.id, 'traveler');
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie: 'travelmate_session=' + token };
  const activity = { id: 'google-photo-live-jikjisa', title: 'Visit Jikjisa', time: '09:00', durationMinutes: 60, description: 'Preserve this saved activity description and cost.', estimatedCost: 10000, category: 'activity', icon: 'map', location: 'Gimcheon', place: { provider: 'wikidata', placeId: 'Q625286', name: 'Jikjisa', city: 'Gimcheon', country: 'South Korea', countryCode: 'KR', latitude: 36.1165, longitude: 128.00433333, sourceUrl: 'https://www.wikidata.org/wiki/Q625286', fetchedAt: new Date().toISOString(), openingHours: 'Opening hours need confirmation', address: 'Not available' } };
  const { buildGroundedPlan } = await import('../src/services/itinerary/grounded-plan.ts');
  const plan = buildGroundedPlan({ destination: 'Gimcheon, South Korea', anchor: { city: 'Gimcheon', country: 'South Korea', countryCode: 'KR', latitude: 36.139, longitude: 128.1147 }, startingLocation: '', startDate: '2040-01-01', endDate: '2040-01-01', budget: 100000, currency: 'KRW', travelers: 1, partyType: 'solo', rooms: 1, places: [{ ...activity.place, provider: 'wikidata', description: activity.description }], placeDataStatus: 'live', source: 'catalog', transportation: 'Walking', schedule: [{ day: 1, date: '2040-01-01', theme: 'Jikjisa photo verification', visits: [{ placeId: 'Q625286', startMinutes: 540, durationMinutes: 60, participants: 1 }] }] });
  const originalActivity = structuredClone(plan.days[0].activities[0]);
  const body = { action: 'save-trip', destination: plan.destination, budget: plan.totalBudget, currency: plan.currency, travelers: 1, partyType: 'solo', startDate: '2040-01-01', endDate: '2040-01-01', interests: ['culture'], itinerary: plan };
  const save = await fetchOriginal('http://127.0.0.1:5102/api/platform', { method: 'POST', headers, body: JSON.stringify(body) });
  const saveBody = await save.json();
  assert.equal(save.status, 200, `Initial trip creation must succeed: ${saveBody.error || ''}`);
  const trip = saveBody.result;
  (summary.stages as unknown[]).push({ stage: 'create-trip', status: save.status });
  // Use the real local frontend, forwarding API traffic to the isolated backend.
  const { chromium } = await import('../../travelmate-frontend-new/node_modules/playwright/index.mjs');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'travelmate_session', value: token, domain: 'localhost', path: '/' }]);
  page = await context.newPage();
  let photoRequests = 0;
  await page.route('http://localhost:3000/api/**', async (route: any) => {
    try {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/photos')) photoRequests++;
    const response = await route.fetch({ url: 'http://127.0.0.1:5102' + url.pathname + url.search, headers: { ...request.headers(), origin: 'http://localhost:3000', cookie: headers.cookie } });
    await route.fulfill({ response });
    } catch { /* Closing a page aborts optional lookups; never print their headers/cookies. */ }
  });
  const inspect = async (stage: string) => {
    const card = page.locator('[data-daily-card]');
    await card.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-daily-card] [data-day-photos] img')).some(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0), undefined, { timeout: 65000 });
    const result = await card.evaluate((element: HTMLElement) => {
      const image = element.querySelector('[data-day-photos] img') as HTMLImageElement;
      const host = new URL(image.currentSrc || image.src).hostname;
      return { naturalWidth: image.naturalWidth, imageLoaded: image.complete, lazy: image.loading === 'lazy', google: !!element.querySelector('[data-google-place-photo]'), credit: element.querySelector('[data-google-photo-credit]')?.textContent || element.querySelector('[data-day-photos] a')?.textContent, provider: host.includes('googleusercontent') ? 'google' : host.includes('unsplash') ? 'unsplash' : 'wikimedia-or-existing-optimizer' };
    });
    (summary.stages as unknown[]).push({ stage, ...result, photoRequests });
    assert.ok(result.naturalWidth); return result;
  };
  await page.goto('http://localhost:3000/dashboard');
  await page.getByRole('button', { name: 'Open the saved plan', exact: true }).click();
  const display = await inspect('open-and-display');
  await page.locator('[data-daily-card]').getByRole('button', { name: 'View Itinerary', exact: true }).click();
  await page.locator('[data-day-details]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-day-details] [data-activity-index="0"] img')).some(image => (image as HTMLImageElement).naturalWidth > 0));
  (summary.stages as unknown[]).push({ stage: 'activity-details', photoDisplayed: true });
  const savedResponse = page.waitForResponse((response: any) => response.url().includes('/api/platform') && response.request().method() === 'POST' && !response.url().endsWith('/photos'));
  await page.getByRole('button', { name: 'Update saved trip', exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  (summary.stages as unknown[]).push({ stage: 'save', status: 200 });
  await page.goto('http://localhost:3000/dashboard');
  await page.getByRole('button', { name: 'Open the saved plan', exact: true }).click();
  await inspect('reopen');
  await page.reload(); await inspect('refresh');
  const persisted = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
  const savedActivity = persisted.itinerary.days[0].activities[0];
  for (const field of ['title', 'description', 'time', 'estimatedCost', 'durationMinutes', 'place']) assert.deepEqual(savedActivity[field], originalActivity[field as keyof typeof originalActivity]);
  assert.equal(persisted.itinerary.days[0].totalCost, plan.days[0].totalCost);
  assert.equal(JSON.stringify(persisted.itinerary).includes('googleusercontent'), false);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(storage.includes('googleusercontent'), false);
  summary.preservedActivityData = true; summary.googlePlaceIdStored = !!savedActivity.googlePlaceId; summary.googlePhotoContentStored = false; summary.googleRequests = providerRequests; summary.photoRequests = photoRequests;
  if (!display.google) await page.screenshot({ path: `${directory}/live-fallback-refresh.png`, fullPage: true });
  summary.result = display.google ? 'live-google-photo-success' : 'live-existing-fallback-success-google-blocked-or-unmatched';
  console.log(JSON.stringify(summary));
} catch (error) {
  summary.result = 'verification-failed'; summary.error = error instanceof Error ? error.message : 'Verification failed';
  console.error(JSON.stringify(summary)); process.exitCode = 1;
} finally {
  globalThis.fetch = fetchOriginal;
  if (page) await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (prisma) await prisma.$disconnect();
  if (created) await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
  await pool.end();
  fs.writeFileSync(`${directory}/live-verification-summary.json`, JSON.stringify(summary, null, 2) + '\n');
}
