import { z } from 'zod';
import { prisma } from '../../lib/prisma.ts';
import { Prisma, type VisitedPlace } from '../../generated/prisma/client.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { verifyGroundedPlan } from '../itinerary/grounded-plan.ts';
import { storedPhoto } from '../../lib/stored-trip-media.ts';
import { buildTripVisitCandidates, candidateAlreadyRecorded, manualPlaceKey, type TripVisitCandidate } from './trip-visit-candidates.ts';
export { manualPlaceKey } from './trip-visit-candidates.ts';

function fail(message: string): never { throw new PlatformActionError(message); }
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function traveler(user: PublicUser) { if (user.role !== 'traveler') fail('Visited places are available to travelers.'); }
export function visitDate(value: unknown, timeZone: unknown, now = new Date()): Date {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('Visit date must use YYYY-MM-DD format.');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('Visit date is invalid.');
  let today: string;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: text(timeZone, 100) || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    today = ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
  } catch { fail('Visit time zone is invalid.'); }
  if (date > today!) fail('Only visits that have already happened can be recorded.');
  return parsed;
}
function serialize(row: VisitedPlace) {
  return { id: row.id, tripId: row.tripId ?? undefined, placeKey: row.placeKey, name: row.name, destination: row.destination,
    visitDate: row.visitDate.toISOString().slice(0, 10), latitude: row.latitude ?? undefined, longitude: row.longitude ?? undefined,
    place: row.place ?? undefined, ...(storedPhoto(row) || {}),
    createdAt: row.createdAt.toISOString() };
}

async function visitsLocked<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async tx => {
    // Serialize this user's manual/batch visit saves across all API instances.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`visited:${userId}`})::bigint)`;
    return work(tx);
  }, { timeout: 20000 });
}
async function tripPlaces(tx: Prisma.TransactionClient, user: PublicUser, tripId: string, lock = false) {
  if (lock) await tx.$executeRaw`SELECT id FROM trips WHERE id = ${tripId} AND user_id = ${user.id} FOR SHARE`;
  const trip = await tx.trip.findFirst({ where: { id: tripId, userId: user.id } });
  if (!trip) fail('Saved trip not found.');
  const places = buildTripVisitCandidates({ ...trip, latitude: trip.latitude == null ? null : Number(trip.latitude), longitude: trip.longitude == null ? null : Number(trip.longitude) });
  const visits = await tx.visitedPlace.findMany({ where: { userId: user.id, OR: [{ placeKey: { in: places.map(place => place.key) } }, { tripId }] } });
  return { trip, places, visits };
}
export async function readTripVisitCandidates(user: PublicUser, tripId: string) {
  traveler(user);
  return prisma.$transaction(async tx => {
    const { trip, places, visits } = await tripPlaces(tx, user, tripId);
    return { tripId: trip.id, destination: trip.destination, places: places.map(place => ({ ...place, alreadyRecorded: candidateAlreadyRecorded(place, tripId, visits, places) })) };
  });
}
const batchSchema = z.object({
  tripId: z.string().min(1).max(100), visitDate: z.string(), timeZone: z.string().max(100).optional(),
  places: z.array(z.object({ key: z.string().max(100), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1550),
});
const mediaData = (place: TripVisitCandidate) => ({
  ...(place.place ? { place: place.place as unknown as Prisma.InputJsonValue } : {}),
  ...(place.imageUrl ? { imageUrl: place.imageUrl } : {}),
  ...(place.imageAttribution ? { imageAttribution: place.imageAttribution as unknown as Prisma.InputJsonValue } : {}),
});
export async function recordTripVisits(user: PublicUser, body: Record<string, unknown>) {
  traveler(user);
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) fail('Select saved places and enter the actual visit date.');
  const input = parsed.data, date = visitDate(input.visitDate, input.timeZone);
  return visitsLocked(user.id, async tx => {
    const { trip, places, visits } = await tripPlaces(tx, user, input.tripId, true);
    if (trip.status === 'archived') fail('Restore this archived trip before recording places.');
    const selected = [...new Map(input.places.map(place => [place.key, place])).values()].map(selection => {
      const place = places.find(place => place.key === selection.key && place.fingerprint === selection.fingerprint);
      if (!place) fail('These saved places changed. Close and reopen the modal before recording visits.');
      return place;
    });
    let recorded = 0, alreadyRecorded = 0;
    for (const place of selected) {
      if (candidateAlreadyRecorded(place, trip.id, visits, places)) { alreadyRecorded++; continue; }
      const row = await tx.visitedPlace.create({ data: { userId: user.id, tripId: trip.id, placeKey: place.key, name: place.name,
        destination: place.destination, latitude: place.latitude, longitude: place.longitude, visitDate: date, ...mediaData(place) } });
      visits.push(row); recorded++;
    }
    return { recorded, alreadyRecorded };
  });
}
export async function recordVisit(user: PublicUser, body: Record<string, unknown>) {
  traveler(user);
  const date = visitDate(body.visitDate, body.timeZone);
  let name = text(body.name, 160), destination = text(body.destination, 120);
  let tripId: string | undefined, latitude: number | undefined, longitude: number | undefined, placeKey: string;
  let media: ReturnType<typeof mediaData> = {};
  if (body.tripId !== undefined) {
    const trip = await prisma.trip.findFirst({ where: { id: text(body.tripId, 100), userId: user.id } });
    if (!trip) fail('Saved trip not found.');
    const day = Number(body.dayIndex), index = Number(body.activityIndex);
    if (!Number.isInteger(day) || day < 0 || !Number.isInteger(index) || index < 0) fail('Select a valid place from the saved trip.');
    const plan = trip.itinerary as unknown as ItineraryResponse;
    const activity = plan?.days?.[day]?.activities?.[index];
    if (!activity || (activity.category !== 'activity' && !activity.place)) fail('Select an attraction or a place, rather than a daily allowance.');
    if ((body.activityTitle !== undefined && body.activityTitle !== activity.title) || (body.placeId !== undefined && body.placeId !== activity.place?.placeId)) fail('This saved activity changed. Reopen the trip before recording its visit.');
    tripId = trip.id; name = (activity.place?.name || activity.title).slice(0, 160); destination = trip.destination;
    if (plan.grounding && verifyGroundedPlan(plan) && activity.place?.provider === 'wikidata' && /^Q\d+$/.test(activity.place.placeId)) {
      placeKey = `wikidata:${activity.place.placeId}`;
      latitude = activity.place.latitude; longitude = activity.place.longitude;
    } else placeKey = manualPlaceKey(name, destination);
    const candidate = buildTripVisitCandidates({ ...trip, latitude: trip.latitude == null ? null : Number(trip.latitude), longitude: trip.longitude == null ? null : Number(trip.longitude) }).find(place => place.dayIndex === day && place.activityIndex === index);
    if (candidate) {
      media = mediaData(candidate);
      if (candidate.place || candidate.latitude !== undefined || candidate.destination !== trip.destination) {
        placeKey = candidate.key; name = candidate.name; destination = candidate.destination;
        latitude = candidate.latitude; longitude = candidate.longitude;
      }
    }
  } else {
    if (name.length < 2 || destination.length < 2) fail('Place name and destination are required.');
    placeKey = manualPlaceKey(name, destination);
  }
  const unique = { userId: user.id, placeKey: placeKey!, visitDate: date };
  try {
    return await visitsLocked(user.id, async tx => {
      const previous = await tx.visitedPlace.findUnique({ where: { userId_placeKey_visitDate: unique } });
      if (previous) return { visit: serialize(previous), alreadyRecorded: true };
      const row = await tx.visitedPlace.create({ data: { ...unique, name, destination, tripId, latitude, longitude, ...media } });
      return { visit: serialize(row), alreadyRecorded: false };
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const row = await prisma.visitedPlace.findUniqueOrThrow({ where: { userId_placeKey_visitDate: unique } });
    return { visit: serialize(row), alreadyRecorded: true };
  }
}
export async function removeVisit(user: PublicUser, body: Record<string, unknown>) {
  traveler(user);
  const result = await prisma.visitedPlace.deleteMany({ where: { id: text(body.id, 100), userId: user.id } });
  if (!result.count) fail('Visited place not found.');
  return { removed: true };
}
export async function readVisitedPlaces(user: PublicUser, cursor?: string, query = '') {
  traveler(user);
  if (query.length > 100) fail('Search is too long.');
  if (cursor && !await prisma.visitedPlace.findFirst({ where: { id: cursor, userId: user.id }, select: { id: true } })) fail('Visited-place cursor is invalid.');
  const where = { userId: user.id, ...(query.trim() ? { OR: [{ name: { contains: query.trim(), mode: 'insensitive' as const } }, { destination: { contains: query.trim(), mode: 'insensitive' as const } }] } : {}) };
  const [rows, total] = await Promise.all([
    prisma.visitedPlace.findMany({ where, orderBy: [{ visitDate: 'desc' }, { id: 'asc' }], take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    prisma.visitedPlace.count({ where }),
  ]);
  const visits = rows.slice(0, 20);
  return { visits: visits.map(serialize), page: { total, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? visits.at(-1)!.id : undefined } };
}
