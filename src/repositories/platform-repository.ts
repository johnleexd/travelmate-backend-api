import { scryptSync } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.ts";
import { normalizeCurrency, type AuditEvent, type Booking, type Database, type ItineraryGenerationSummary, type ItineraryVersion, type Listing, type ListingBlockedDate, type ModerationItem, type Notification, type OwnerDocument, type PaymentTransaction, type Promotion, type PublicUser, type Review, type SavedTrip } from "../schemas/domain.ts";
import { prisma } from "../lib/prisma.ts";

export function password(value: string, salt: string) {
  return scryptSync(value, salt, 64).toString("hex");
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

const publicUserSelect = { id: true, name: true, email: true, role: true, emailVerified: true, profileStatus: true, trustScore: true, accountStatus: true, bio: true, phone: true } as const;

async function loadDatabase(user?: PublicUser): Promise<Database> {
  const traveler = user?.role === 'traveler';
  const [users, listings, bookings, moderation, trips, itineraryVersions, itineraryGenerations, audit, blockedDates, promotions, reviews, notifications, transactions, ownerDocuments] = await Promise.all([
    prisma.user.findMany({ where: traveler ? { id: user.id } : undefined, select: publicUserSelect, orderBy: { id: "asc" } }),
    user?.role === 'admin' ? Promise.resolve([]) : prisma.listing.findMany({ where: traveler ? { status: 'approved' } : undefined, orderBy: { id: "asc" } }),
    user ? Promise.resolve([]) : prisma.booking.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.moderation.findMany({ where: user && user.role !== 'admin' ? { id: '__none__' } : { kind: 'report' }, orderBy: { createdAt: "desc" } }),
    prisma.trip.findMany({ where: traveler ? { userId: user.id } : user ? { id: '__none__' } : undefined, orderBy: { createdAt: "asc" } }),
    prisma.itineraryVersion.findMany({ where: traveler ? { trip: { userId: user.id } } : user ? { id: '__none__' } : undefined, orderBy: [{ tripId: "asc" }, { version: "desc" }] }),
    prisma.itineraryGeneration.findMany({ where: traveler ? { userId: user.id } : undefined, select: { id: true, userId: true, destination: true, status: true, errorCode: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.auditEvent.findMany({ where: user && user.role !== 'admin' ? { id: '__none__' } : undefined, orderBy: { createdAt: "desc" }, take: 100 }),
    user ? Promise.resolve([]) : prisma.listingBlockedDate.findMany({ orderBy: { date: 'asc' } }),
    user ? Promise.resolve([]) : prisma.promotion.findMany({ orderBy: { startDate: 'desc' } }),
    user ? Promise.resolve([]) : prisma.review.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.notification.findMany({ where: user ? { userId: user.id } : undefined, orderBy: { createdAt: 'desc' }, take: user ? 50 : undefined }),
    user ? Promise.resolve([]) : prisma.paymentTransaction.findMany({ orderBy: { createdAt: 'desc' } }),
    user ? Promise.resolve([]) : prisma.ownerDocument.findMany({ orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    users: users.map((row): PublicUser => ({ ...row, bio: row.bio ?? undefined, phone: row.phone ?? undefined })),
    listings: listings.map((row): Listing => ({ ...row, price: Number(row.price), amenities: stringArray(row.amenities), imageUrl: row.imageUrl ?? undefined, imageUrls: stringArray(row.imageUrls) })),
    bookings: bookings.map((row): Booking => ({ ...row, amount: Number(row.amount), checkIn: row.checkIn?.toISOString().slice(0, 10), checkOut: row.checkOut?.toISOString().slice(0, 10), requestedCheckIn: row.requestedCheckIn?.toISOString().slice(0, 10), requestedCheckOut: row.requestedCheckOut?.toISOString().slice(0, 10), requestedGuests: row.requestedGuests ?? undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    moderation: moderation.map((row): ModerationItem => ({ ...row, createdAt: row.createdAt.toISOString() })),
    trips: trips.map((row): SavedTrip => ({ ...row, budget: Number(row.budget), currency: normalizeCurrency(row.currency), latitude: row.latitude == null ? undefined : Number(row.latitude), longitude: row.longitude == null ? undefined : Number(row.longitude), destinationCity: row.destinationCity ?? undefined, destinationRegion: row.destinationRegion ?? undefined, destinationCountry: row.destinationCountry ?? undefined, destinationCountryCode: row.destinationCountryCode ?? undefined, startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate.toISOString().slice(0, 10), interests: stringArray(row.interests), archivedAt: row.archivedAt?.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    itineraryVersions: itineraryVersions.map((row): ItineraryVersion => ({ ...row, weather: row.weather ?? null, createdAt: row.createdAt.toISOString() })),
    itineraryGenerations: itineraryGenerations.map((row): ItineraryGenerationSummary => ({ id: row.id, userId: row.userId, destination: row.destination, status: row.status, errorCode: row.errorCode ?? undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    audit: audit.map((row): AuditEvent => ({ ...row, createdAt: row.createdAt.toISOString() })),
    blockedDates: blockedDates.map((row): ListingBlockedDate => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
    promotions: promotions.map((row): Promotion => ({ ...row, startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate.toISOString().slice(0, 10) })),
    reviews: reviews.map((row): Review => ({ ...row, createdAt: row.createdAt.toISOString() })),
    notifications: notifications.map((row): Notification => ({ ...row, readAt: row.readAt?.toISOString(), createdAt: row.createdAt.toISOString() })),
    transactions: transactions.map((row): PaymentTransaction => ({ ...row, amount: Number(row.amount), createdAt: row.createdAt.toISOString() })),
    ownerDocuments: ownerDocuments.map((row): OwnerDocument => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

export async function readDb(): Promise<Database> {
  return loadDatabase();
}

export async function readScopedDb(user: PublicUser): Promise<Database> {
  return loadDatabase(user);
}

export async function readApprovedListings(): Promise<Listing[]> {
  const rows = await prisma.listing.findMany({ where: { status: 'approved' }, orderBy: { id: 'asc' } });
  return rows.map((row): Listing => ({ ...row, price: Number(row.price), amenities: stringArray(row.amenities), imageUrl: row.imageUrl ?? undefined, imageUrls: stringArray(row.imageUrls) }));
}
