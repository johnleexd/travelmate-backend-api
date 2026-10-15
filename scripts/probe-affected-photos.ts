import fs from 'node:fs';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const { prisma } = await import('../src/lib/prisma.ts');
const { activityPhotoSubject, findItineraryActivityPhoto } = await import('../src/services/itinerary/activity-photo-fallback.ts');
const { googlePlacesConfigured } = await import('../src/services/itinerary/google-place-photos.ts');
const directory = '../audit/2026-10-12/non-google-activity-photos';
fs.mkdirSync(directory, { recursive: true });
const originalFetch = globalThis.fetch;
let googleRequests = 0;
globalThis.fetch = async (input, init) => {
  if (new URL(String(input)).hostname === 'places.googleapis.com') { googleRequests++; throw new Error('Google photo requests must stay disabled'); }
  return originalFetch(input, init);
};
const results: unknown[] = [];
try {
  const trips = await prisma.trip.findMany({ where: { OR: [{ destination: { contains: 'Cheonan', mode: 'insensitive' } }, { destination: { contains: 'Manila', mode: 'insensitive' } }] }, orderBy: { createdAt: 'desc' } });
  for (const trip of trips) {
    const plan = trip.itinerary as any;
    fs.writeFileSync(`${directory}/before-${trip.id}.json`, JSON.stringify({ id: trip.id, destination: trip.destination, itinerary: plan }, null, 2));
    if (!trip.destination.includes('Cheonan')) continue;
    for (const day of plan.days) for (const [index, activity] of day.activities.entries()) {
      if (activity.category !== 'activity') continue;
      if (activity.imageUrl) { results.push({ tripId: trip.id, day: day.day, index, title: activity.title, existing: true }); continue; }
      const subject = activityPhotoSubject(activity, trip.destination), started = Date.now();
      const photo = subject ? await findItineraryActivityPhoto(subject, AbortSignal.timeout(55000)) : null;
      const result = { tripId: trip.id, day: day.day, index, title: activity.title, subject, photo, elapsedMs: Date.now() - started };
      results.push(result); console.log(JSON.stringify({ event: 'affected_photo_probe', title: activity.title, day: day.day, matched: !!photo, provider: photo?.imageAttribution.provider || (photo ? 'wikimedia' : null), elapsedMs: result.elapsedMs }));
      fs.writeFileSync(`${directory}/provider-probe.json`, JSON.stringify({ googleEnabled: googlePlacesConfigured(), googleRequests, results }, null, 2));
    }
  }
} finally { globalThis.fetch = originalFetch; await prisma.$disconnect(); }
console.log(JSON.stringify({ googleEnabled: googlePlacesConfigured(), googleRequests, results: results.map((result: any) => ({ title: result.title, day: result.day, matched: !!result.photo, existing: result.existing })) }));
