import { scryptSync } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.ts";
import type { AuditEvent, Booking, Database, Listing, ModerationItem, SavedTrip, StoredUser } from "../schemas/domain.ts";
import { prisma } from "../lib/prisma.ts";

export function password(value: string, salt: string) {
  return scryptSync(value, salt, 64).toString("hex");
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function loadDatabase(): Promise<Database> {
  const [users, listings, bookings, moderation, trips, audit] = await Promise.all([
    prisma.user.findMany({ orderBy: { id: "asc" } }),
    prisma.listing.findMany({ orderBy: { id: "asc" } }),
    prisma.booking.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.moderation.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.trip.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.auditEvent.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  return {
    users: users.map((row): StoredUser => ({ ...row, bio: row.bio ?? undefined, phone: row.phone ?? undefined })),
    listings: listings.map((row): Listing => ({ ...row, price: Number(row.price), amenities: stringArray(row.amenities), imageUrl: row.imageUrl ?? undefined })),
    bookings: bookings.map((row): Booking => ({ ...row, amount: Number(row.amount), createdAt: row.createdAt.toISOString() })),
    moderation: moderation.map((row): ModerationItem => ({ ...row, createdAt: row.createdAt.toISOString() })),
    trips: trips.map((row): SavedTrip => ({ ...row, budget: Number(row.budget), startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate.toISOString().slice(0, 10), interests: stringArray(row.interests), createdAt: row.createdAt.toISOString() })),
    audit: audit.map((row): AuditEvent => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

export async function readDb(): Promise<Database> {
  return loadDatabase();
}
