import { prisma } from '../lib/prisma.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { PlatformActionError } from '../exceptions/index.ts';
import { normalizeCurrency, type PublicUser } from '../schemas/domain.ts';

const tripSummarySelect = {
  id: true, userId: true, destination: true, destinationCity: true, destinationRegion: true,
  destinationCountry: true, destinationCountryCode: true, latitude: true, longitude: true,
  budget: true, currency: true, startDate: true, endDate: true, travelers: true, partyType: true,
  interests: true, status: true, archivedAt: true, completedAt: true, createdAt: true, updatedAt: true,
} as const;

type TripSummaryRow = Awaited<ReturnType<typeof prisma.trip.findMany<{ select: typeof tripSummarySelect }>>>[number];
export function serializeWorkspaceTrip(row: TripSummaryRow & { itinerary?: unknown; weather?: unknown }) {
  return {
    ...row, budget: Number(row.budget), currency: normalizeCurrency(row.currency),
    latitude: row.latitude == null ? undefined : Number(row.latitude), longitude: row.longitude == null ? undefined : Number(row.longitude),
    startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate.toISOString().slice(0, 10),
    interests: Array.isArray(row.interests) ? row.interests.map(String) : [],
    archivedAt: row.archivedAt?.toISOString(), completedAt: row.completedAt?.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    itinerary: row.itinerary ?? null, weather: row.weather ?? null,
  };
}

export async function readTripPage(user: PublicUser, cursor?: string) {
  if (cursor && !await prisma.trip.findFirst({ where: { id: cursor, userId: user.id }, select: { id: true } })) throw new PlatformActionError('Trip page cursor is invalid.');
  const [rows, total] = await Promise.all([
    prisma.trip.findMany({ where: { userId: user.id }, select: tripSummarySelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    prisma.trip.count({ where: { userId: user.id } }),
  ]);
  const visible = rows.slice(0, 20);
  // Project just the stay's name/address from saved JSON, never the full itinerary.
  const stays = visible.length ? await prisma.$queryRaw<Array<{ id: string; name: string | null; address: string | null; selectionKind: 'planned' | 'quoted' }>>(Prisma.sql`
    SELECT id,
      LEFT(COALESCE(NULLIF(TRIM(itinerary #>> '{plannedAccommodation,name}'), ''), NULLIF(TRIM(itinerary #>> '{accommodation,name}'), '')), 300) AS name,
      LEFT(CASE WHEN NULLIF(TRIM(itinerary #>> '{plannedAccommodation,name}'), '') IS NOT NULL
        THEN itinerary #>> '{plannedAccommodation,address}' ELSE itinerary #>> '{accommodation,address}' END, 300) AS address,
      CASE WHEN NULLIF(TRIM(itinerary #>> '{plannedAccommodation,name}'), '') IS NOT NULL
        THEN 'planned' ELSE 'quoted' END AS "selectionKind"
    FROM trips WHERE user_id = ${user.id} AND id IN (${Prisma.join(visible.map(row => row.id))})
  `) : [];
  const staysByTrip = new Map(stays.filter(stay => stay.name).map(stay => [stay.id, { name: stay.name!, address: stay.address || '', selectionKind: stay.selectionKind }]));
  return { trips: visible.map(row => ({ ...serializeWorkspaceTrip(row), selectedAccommodation: staysByTrip.get(row.id) })), page: { total, nextCursor: rows.length > 20 ? visible.at(-1)!.id : null } };
}

export async function readTripDetails(user: PublicUser, id: string) {
  const row = await prisma.trip.findFirst({ where: { id, userId: user.id } });
  if (!row) throw new PlatformActionError('Saved trip not found.');
  return serializeWorkspaceTrip(row);
}

export async function readTripVersions(user: PublicUser, tripId: string, cursor?: string) {
  if (!await prisma.trip.findFirst({ where: { id: tripId, userId: user.id }, select: { id: true } })) throw new PlatformActionError('Saved trip not found.');
  if (cursor && !await prisma.itineraryVersion.findFirst({ where: { id: cursor, tripId }, select: { id: true } })) throw new PlatformActionError('Version page cursor is invalid.');
  const [rows, total] = await Promise.all([
    prisma.itineraryVersion.findMany({ where: { tripId }, select: { id: true, tripId: true, version: true, kind: true, createdAt: true },
      orderBy: [{ version: 'desc' }, { id: 'desc' }], take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    prisma.itineraryVersion.count({ where: { tripId } }),
  ]);
  const visible = rows.slice(0, 50);
  return { versions: visible.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), itinerary: null, weather: null })),
    page: { total, nextCursor: rows.length > 50 ? visible.at(-1)!.id : null } };
}

export async function readNotifications(user: PublicUser) {
  const rows = await prisma.notification.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
  return rows.map(row => ({ ...row, readAt: row.readAt?.toISOString(), createdAt: row.createdAt.toISOString() }));
}

export async function readNotificationSnapshot(user: PublicUser) {
  const [notifications, unreadCount] = await Promise.all([
    readNotifications(user), countUnreadNotifications(user),
  ]);
  return { notifications, unreadCount };
}

export function countUnreadNotifications(user: PublicUser) {
  return prisma.notification.count({ where: { userId: user.id, readAt: null } });
}
