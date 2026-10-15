import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const { prisma } = await import('../src/lib/prisma.ts');
const directory = '../audit/2026-10-12/saved-cover-photos';
fs.mkdirSync(directory, { recursive: true });
const trips = await prisma.trip.findMany({ where: { OR: ['Cheonan', 'Toyota'].map(city => ({ destination: { contains: city, mode: 'insensitive' as const } })) }, orderBy: { createdAt: 'desc' } });
if (process.argv.includes('--check-preserved')) {
  const before = JSON.parse(fs.readFileSync(directory + '/before-records.json', 'utf8'));
  const result = trips.map(trip => ({ destination: trip.destination, id: trip.id, unchanged: before.find((row: any) => row.id === trip.id)?.hash === createHash('sha256').update(JSON.stringify(trip)).digest('hex') }));
  fs.writeFileSync(directory + '/saved-data-preserved.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await prisma.$disconnect(); process.exit(result.every(row => row.unchanged) ? 0 : 1);
}
if (process.argv.includes('--city-fallback')) {
  const { createActivityPhotoResolver } = await import('../src/services/itinerary/activity-photo-fallback.ts');
  const { placePhotoCandidates } = await import('../../travelmate-frontend-new/lib/place-image.ts');
  const calls: any[] = [], results = [];
  const resolver = createActivityPhotoResolver(async (input, init) => {
    const response = await fetch(input, init);
    calls.push({ url: String(input), status: response.status, data: await response.clone().json().catch(() => null) });
    return response;
  });
  for (const trip of trips) {
    const photo = await resolver({ kind: 'destination', name: trip.destinationCity!, city: trip.destinationCity!, region: trip.destinationRegion || undefined, country: trip.destinationCountry!, countryCode: trip.destinationCountryCode!, latitude: Number(trip.latitude), longitude: Number(trip.longitude) }, AbortSignal.timeout(60000));
    const images = [];
    for (const url of placePhotoCandidates(photo?.imageUrl)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      images.push({ url, status: response.status, contentType: response.headers.get('content-type') });
      if (response.ok) { fs.writeFileSync(directory + '/' + trip.destinationCity + '-verified-photo', Buffer.from(await response.arrayBuffer())); break; }
    }
    results.push({ destination: trip.destination, photo, images });
    fs.writeFileSync(directory + '/city-fallback.json', JSON.stringify({ results, calls }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }
  await prisma.$disconnect(); process.exit(0);
}
if (process.argv.includes('--providers')) {
  const originalFetch = globalThis.fetch, calls: any[] = [];
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(String(input));
    const entry = { host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), status: response.status, data: await response.clone().json().catch(() => null) };
    calls.push(entry); console.log(JSON.stringify({ event: 'cover_provider_response', host: entry.host, path: entry.path, status: entry.status }));
    return response;
  };
  const { loadDestinationCoverPhotos } = await import('../src/services/destination/destination-cover-photo.ts');
  const results = [];
  for (const trip of trips) {
    const started = Date.now();
    const input = { city: trip.destinationCity!, country: trip.destinationCountry!, countryCode: trip.destinationCountryCode!, latitude: Number(trip.latitude), longitude: Number(trip.longitude) };
    const photos = await loadDestinationCoverPhotos(input);
    results.push({ destination: trip.destination, input, elapsedMs: Date.now() - started, photos });
    fs.writeFileSync(directory + '/' + (process.argv.includes('--after') ? 'after' : 'before') + '-providers.json', JSON.stringify({ results, calls }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }
  await prisma.$disconnect(); process.exit(0);
}
if (process.argv.includes('--inspect')) {
  const { savedTripCoverImage, savedTripPhotoQuery, placePhotoCandidates } = await import('../../travelmate-frontend-new/lib/place-image.ts');
  const { searchGlobalLocations } = await import('../src/services/destination/global-location-search.ts');
  const evidence = [];
  for (const trip of trips) {
    const destination = { ...trip, latitude: Number(trip.latitude), longitude: Number(trip.longitude), itinerary: trip.itinerary };
    const cover = savedTripCoverImage(trip.itinerary, destination);
    const images = [];
    for (const url of placePhotoCandidates(cover?.src)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      images.push({ url, status: response?.status, contentType: response?.headers.get('content-type') });
    }
    const matches = await searchGlobalLocations(trip.destinationCity + ', ' + trip.destinationCountryCode);
    evidence.push({ id: trip.id, destination: trip.destination, region: trip.destinationRegion, query: savedTripPhotoQuery(destination), cover, images, matches, unsplashConfigured: Boolean(process.env.UNSPLASH_ACCESS_KEY) });
  }
  fs.writeFileSync(directory + '/before-resolver.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  await prisma.$disconnect(); process.exit(0);
}
if (process.argv.includes('--browser')) {
  const { chromium } = await import('../../travelmate-frontend-new/node_modules/playwright/index.mjs');
  // Login cookies stay in the ignored local cache, never in shareable audit evidence.
  const context = await chromium.launchPersistentContext('.cache/saved-cover-verification', { channel: 'chrome', headless: false, viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    const { expect } = await import('../../travelmate-frontend-new/node_modules/@playwright/test/index.mjs');
    const requests: any[] = [], failures: any[] = [];
    page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', async response => {
      if (response.url().includes('/api/destination-context/photo?')) {
        const body = await response.json().catch(() => null);
        requests.push({ url: response.url(), status: response.status(), body });
      }
    });
    await page.goto('http://localhost:3000/dashboard');
    console.log('Verification Chrome is open. Please sign in normally to the account containing the two saved trips.');
    await page.waitForURL('**/dashboard', { timeout: 0 });
    await page.getByRole('button', { name: 'Saved trips', exact: true }).click();
    await page.getByRole('heading', { name: 'Saved plans', exact: true }).waitFor();
    const phase = process.argv.includes('--cached') ? 'cached' : process.argv.includes('--after') ? 'after' : 'before';
    if (phase !== 'before') {
      for (const destination of [...trips.map(trip => trip.destination), 'Hamburg, Germany']) {
        const card = page.locator('article').filter({ has: page.getByRole('heading', { name: destination, exact: true }) });
        await card.scrollIntoViewIfNeeded();
        const rendered = await expect.poll(() => card.locator('img').first().evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0).catch(() => false), { timeout: 120000 }).toBe(true).then(() => true, () => false);
        console.log(JSON.stringify({ event: 'real_saved_cover_checked', destination, rendered }));
      }
    } else await page.waitForTimeout(45000);
    const covers = await page.locator('article').evaluateAll(cards => cards.filter(card => card.querySelector('h3')).map(card => {
      const image = card.querySelector('img');
      return { destination: card.querySelector('h3')?.textContent, text: card.textContent, links: Array.from(card.querySelectorAll('a')).map(link => ({ text: link.textContent, href: link.href })), image: image ? { alt: image.alt, src: image.currentSrc, loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth } : null };
    }));
    await page.screenshot({ path: directory + '/' + phase + '-saved-trips.png', fullPage: true });
    fs.writeFileSync(directory + '/' + phase + '-browser.json', JSON.stringify({ covers, requests, failures }, null, 2));
    console.log(JSON.stringify({ phase, covers: covers.map(cover => ({ destination: cover.destination, image: cover.image, unavailable: cover.text?.includes('Destination photo unavailable') })), requests: requests.map(entry => ({ url: entry.url, status: entry.status, photo: entry.body?.photo })) }));
  } finally { await context.close(); await prisma.$disconnect(); }
  process.exit(0);
}
const overview = trips.map(trip => ({ id: trip.id, destination: trip.destination, destinationCity: trip.destinationCity, destinationRegion: trip.destinationRegion, destinationCountry: trip.destinationCountry, destinationCountryCode: trip.destinationCountryCode, latitude: trip.latitude, longitude: trip.longitude, grounding: (trip.itinerary as any)?.grounding?.destination, photos: (trip.itinerary as any)?.days?.flatMap((day: any) => day.activities.filter((item: any) => item.imageUrl).map((item: any) => ({ name: item.place?.name || item.title, place: item.place, credit: item.imageAttribution, src: item.imageUrl }))), hash: createHash('sha256').update(JSON.stringify(trip)).digest('hex') }));
fs.writeFileSync(directory + '/before-records.json', JSON.stringify(overview, null, 2));
console.log(JSON.stringify(overview));
await prisma.$disconnect();
