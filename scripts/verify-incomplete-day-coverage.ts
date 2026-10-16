import { mkdir, writeFile } from 'node:fs/promises';
import { retrieveGroundedPlaces, permittedPlaceCandidates } from '../src/services/itinerary/grounded-places.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import type { DestinationAnchor } from '../src/services/itinerary/grounding-schema.ts';

const anchors: Record<string, DestinationAnchor> = {
  Mazar: { id: 1133616, city: 'Mazār-e Sharīf', region: 'Balkh', country: 'Afghanistan', countryCode: 'AF', latitude: 36.70904, longitude: 67.11087, provider: 'geonames', providerId: '1133616', placeType: 'Administrative capital' },
  Canberra: { id: 2172517, city: 'Canberra', country: 'Australia', countryCode: 'AU', latitude: -35.28346, longitude: 149.12807, provider: 'geonames', providerId: '2172517', placeType: 'Capital city' },
  Tokyo: { id: 1850147, city: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.6895, longitude: 139.6917, provider: 'geonames', providerId: '1850147', placeType: 'Capital city' },
};
const key = process.argv[2] || 'Mazar';
if (!anchors[key]) throw new Error('Choose Mazar, Canberra, or Tokyo.');
const anchor = anchors[key];
const evidence = `diagnostics/place-coverage-${key}.json`;
const calls: unknown[] = [], events: unknown[] = [];
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), started = Date.now();
  try {
    const response = await fetch(input, init);
    const data = await response.clone().json().catch(() => null);
    calls.push({ host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), status: response.status, durationMs: Date.now() - started, data });
    return response;
  } catch (error) {
    calls.push({ host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), error: error instanceof Error ? error.name : 'Request error' });
    throw error;
  }
};
try {
  const places = await retrieveGroundedPlaces(anchor, fetcher, undefined, false, { tripDays: 7 });
  const inScope = permittedPlaceCandidates(places);
  const schedule = completeGroundedSchedule(anchor, inScope, [], '2026-10-16', 7, 2, 'balanced', { diagnostics: event => events.push(event) });
  const lengths = Object.fromEntries([1, 3, 7, 14, 31].map(days => [days, completeGroundedSchedule(anchor, inScope, [], '2026-10-16', days, 2, 'balanced').map(day => day.visits.length)]));
  await mkdir('diagnostics', { recursive: true });
  await writeFile(evidence, JSON.stringify({ anchor, calls, places, events, schedule, lengths }, null, 2));
  console.log(JSON.stringify({ anchor, candidates: places.length, inScope: inScope.length, nearby: places.length - inScope.length, perDay: schedule.map(day => day.visits.length), lengths, requests: calls.length, evidence }));
} catch (error) {
  await mkdir('diagnostics', { recursive: true });
  await writeFile(evidence, JSON.stringify({ anchor, calls, events }, null, 2));
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Provider check failed', requests: calls.length }));
  process.exitCode = 1;
}
