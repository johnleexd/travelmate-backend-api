import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.ts';
import { Prisma, type VisitedPlace } from '../../generated/prisma/client.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { verifyGroundedPlan } from '../itinerary/grounded-plan.ts';

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
export function manualPlaceKey(name: string, destination: string): string {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `manual:${createHash('sha256').update(JSON.stringify([normalize(name), normalize(destination)])).digest('hex')}`;
}
function serialize(row: VisitedPlace) {
  return { id: row.id, tripId: row.tripId ?? undefined, placeKey: row.placeKey, name: row.name, destination: row.destination,
    visitDate: row.visitDate.toISOString().slice(0, 10), latitude: row.latitude ?? undefined, longitude: row.longitude ?? undefined,
    createdAt: row.createdAt.toISOString() };
}
export async function recordVisit(user: PublicUser, body: Record<string, unknown>) {
  traveler(user);
  const date = visitDate(body.visitDate, body.timeZone);
  let name = text(body.name, 160), destination = text(body.destination, 120);
  let tripId: string | undefined, latitude: number | undefined, longitude: number | undefined, placeKey: string;
  if (body.tripId !== undefined) {
    const trip = await prisma.trip.findFirst({ where: { id: text(body.tripId, 100), userId: user.id }, select: { id: true, destination: true, itinerary: true } });
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
  } else {
    if (name.length < 2 || destination.length < 2) fail('Place name and destination are required.');
    placeKey = manualPlaceKey(name, destination);
  }
  const unique = { userId: user.id, placeKey: placeKey!, visitDate: date };
  const previous = await prisma.visitedPlace.findUnique({ where: { userId_placeKey_visitDate: unique } });
  if (previous) return { visit: serialize(previous), alreadyRecorded: true };
  try {
    const row = await prisma.visitedPlace.create({ data: { ...unique, name, destination, tripId, latitude, longitude } });
    return { visit: serialize(row), alreadyRecorded: false };
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
