import {
  Prisma,
  type Booking as PrismaBooking,
  type Listing as PrismaListing,
  type Moderation as PrismaModeration,
  type Trip as PrismaTrip,
} from "../generated/prisma/client.ts";
import { publicUser, splitBudget, type PaymentStatus, type PublicUser } from "../domain.ts";
import { isCebuLocation } from "../data/cebu-locations.ts";
import { prisma } from "../lib/prisma.ts";
import { applyManualItineraryChanges, ItineraryEditValidationError } from "./itinerary-edit-service.ts";

export class PlatformActionError extends Error {}

type Body = Record<string, unknown>;
type Transaction = Prisma.TransactionClient;

function fail(message: string): never {
  throw new PlatformActionError(message);
}

function requireRole(user: PublicUser, role: PublicUser["role"]): void {
  if (user.role !== role) fail("Action is not allowed for this account.");
}

function identifier(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) fail("A valid record identifier is required.");
  return id;
}

function wholeNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function positiveMoney(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${field} must be a positive number.`);
  return Math.round(number * 100) / 100;
}

function dateOnly(value: unknown, field: string): Date {
  const text = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${field} must use YYYY-MM-DD format.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${field} is invalid.`);
  return date;
}

function tripLength(startDate: Date, endDate: Date): number {
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (!Number.isInteger(days) || days < 1 || days > 14) fail("Trip dates must cover between 1 and 14 days.");
  return days;
}

function listingCategory(value: unknown): "stay" | "activity" | "food" | "transport" {
  if (value === "stay" || value === "food" || value === "transport") return value;
  return "activity";
}

function stringList(value: unknown, maximum = 20): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return items.map(String).map((item) => item.trim()).filter(Boolean).slice(0, maximum);
}

function jsonInput(value: unknown, field: string): Prisma.InputJsonValue {
  if (value === undefined || value === null || (typeof value !== "object" && !Array.isArray(value))) {
    fail(`${field} must be structured JSON data.`);
  }
  return value as Prisma.InputJsonValue;
}

function itineraryInput(value: unknown, days: number): Prisma.InputJsonValue {
  const itinerary = jsonInput(value, "Itinerary") as Record<string, unknown>;
  if (!Array.isArray(itinerary.days) || itinerary.days.length !== days) {
    fail(`Itinerary must contain exactly ${days} day${days === 1 ? "" : "s"}.`);
  }
  const usable = itinerary.days.every((day) => {
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    const activities = (day as Record<string, unknown>).activities;
    return Array.isArray(activities) && activities.length <= 8 && activities.every((activity) => {
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) return false;
      const item = activity as Record<string, unknown>;
      return typeof item.title === "string" && item.title.trim().length > 0
        && typeof item.estimatedCost === "number" && Number.isFinite(item.estimatedCost) && item.estimatedCost >= 0;
    });
  });
  if (!usable) fail("Itinerary contains invalid day or activity data.");
  return itinerary as Prisma.InputJsonValue;
}

function paymentStatus(value: unknown): PaymentStatus {
  if (value === "PAID_HELD" || value === "Released" || value === "FROZEN_HELD" || value === "REFUNDED") return value;
  fail("Booking or payment status is invalid.");
}

function serializeListing(row: PrismaListing) {
  return {
    ...row,
    price: Number(row.price),
    amenities: Array.isArray(row.amenities) ? row.amenities.map(String) : [],
    imageUrl: row.imageUrl ?? undefined,
  };
}

function serializeBooking(row: PrismaBooking) {
  return { ...row, amount: Number(row.amount), createdAt: row.createdAt.toISOString() };
}

function serializeModeration(row: PrismaModeration) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function serializeTrip(row: PrismaTrip) {
  return {
    ...row,
    budget: Number(row.budget),
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    interests: Array.isArray(row.interests) ? row.interests.map(String) : [],
    createdAt: row.createdAt.toISOString(),
  };
}

async function audit(transaction: Transaction, actorId: string, action: string, targetId: string): Promise<void> {
  await transaction.auditEvent.create({ data: { actorId, action, targetId } });
}

async function submitProfile(user: PublicUser, action: string, body: Body) {
  const phone = String(body.phone || "").trim().slice(0, 30);
  const bio = String(body.bio || "").trim().slice(0, 500);
  if (!phone || !bio) fail("Phone and verification details are required.");

  return prisma.$transaction(async (transaction) => {
    const pending = await transaction.moderation.findFirst({ where: { kind: "profile", subjectId: user.id, status: "pending" } });
    if (pending) fail("Your profile verification is already pending review.");
    await transaction.user.update({ where: { id: user.id }, data: { profileStatus: "pending", phone, bio } });
    const item = await transaction.moderation.create({
      data: {
        kind: "profile",
        subjectId: user.id,
        title: `${user.name} profile verification`,
        details: `Phone: ${phone}; ${bio}`,
        status: "pending",
      },
    });
    await audit(transaction, user.id, action, item.id);
    return serializeModeration(item);
  });
}

async function saveTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const destination = String(body.destination || "").trim().slice(0, 120);
  if (destination.length < 2) fail("Destination is required.");
  const budget = positiveMoney(body.budget, "Budget");
  const travelers = wholeNumber(body.travelers, "Travelers", 1, 20);
  const startDate = dateOnly(body.startDate, "Start date");
  const endDate = dateOnly(body.endDate, "End date");
  const days = tripLength(startDate, endDate);
  try {
    splitBudget(budget, travelers, days);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Trip budget is invalid.");
  }
  const itinerary = itineraryInput(body.itinerary, days);
  const interests = stringList(body.interests);

  return prisma.$transaction(async (transaction) => {
    const trip = await transaction.trip.create({
      data: {
        userId: user.id,
        destination,
        budget,
        startDate,
        endDate,
        travelers,
        interests,
        itinerary,
        weather: body.weather == null ? Prisma.DbNull : body.weather as Prisma.InputJsonValue,
      },
    });
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function updateTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  const destination = String(body.destination || "").trim().slice(0, 120);
  if (destination.length < 2) fail("Destination is required.");
  const budget = positiveMoney(body.budget, "Budget");
  const travelers = wholeNumber(body.travelers, "Travelers", 1, 20);
  const startDate = dateOnly(body.startDate, "Start date");
  const endDate = dateOnly(body.endDate, "End date");
  const days = tripLength(startDate, endDate);
  const itinerary = itineraryInput(body.itinerary, days);
  const interests = stringList(body.interests);

  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: {
        destination,
        budget,
        startDate,
        endDate,
        travelers,
        interests,
        itinerary,
        weather: body.weather == null ? Prisma.DbNull : body.weather as Prisma.InputJsonValue,
      },
    });
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function updateTripItinerary(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    const days = tripLength(existing.startDate, existing.endDate);
    let itinerary: Prisma.InputJsonValue;
    try {
      itinerary = applyManualItineraryChanges(existing.itinerary, body.itinerary, days, Number(existing.budget), existing.travelers) as Prisma.InputJsonValue;
    } catch (error) {
      if (error instanceof ItineraryEditValidationError) fail(error.message);
      throw error;
    }
    const trip = await transaction.trip.update({ where: { id: existing.id }, data: { itinerary } });
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function deleteTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    await transaction.trip.delete({ where: { id: existing.id } });
    await audit(transaction, user.id, action, tripId);
    return { id: tripId };
  });
}

async function duplicateTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    const copy = await transaction.trip.create({
      data: {
        userId: user.id,
        destination: existing.destination,
        budget: existing.budget,
        startDate: existing.startDate,
        endDate: existing.endDate,
        travelers: existing.travelers,
        interests: existing.interests as Prisma.InputJsonValue,
        itinerary: existing.itinerary as Prisma.InputJsonValue,
        weather: existing.weather == null ? Prisma.DbNull : existing.weather as Prisma.InputJsonValue,
      },
    });
    await audit(transaction, user.id, action, copy.id);
    return serializeTrip(copy);
  });
}

async function bookListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  if (user.profileStatus !== "verified") fail("Limited Mode: complete profile verification before booking.");
  const listingId = identifier(body.listingId);
  const guests = wholeNumber(body.guests ?? 1, "Guests", 1, 20);
  const nights = wholeNumber(body.nights ?? 7, "Nights", 1, 30);

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, status: "approved" } });
    if (listing && listing.category !== "stay") fail("Only hotel, inn, and other stay listings can be booked.");
    if (!listing) fail("Listing, stay length, or capacity unavailable.");

    const capacity = await transaction.listing.updateMany({
      where: { id: listing.id, available: { gte: guests } },
      data: { available: { decrement: guests } },
    });
    if (capacity.count !== 1) fail("Listing, stay length, or capacity unavailable.");

    const booking = await transaction.booking.create({
      data: {
        travelerId: user.id,
        listingId: listing.id,
        amount: Number(listing.price) * nights,
        guests,
        nights,
        status: "confirmed",
        paymentStatus: "PAID_HELD",
      },
    });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(booking);
  });
}

async function requestBookingReview(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({ where: { id: bookingId, travelerId: user.id } });
    if (!booking) fail("Booking not found.");
    if (booking.status !== "confirmed") fail("This booking already has a pending request or is no longer active.");
    const updated = await transaction.booking.update({
      where: { id: booking.id },
      data: { status: action === "request-cancel" ? "cancel_requested" : "change_requested", paymentStatus: "FROZEN_HELD" },
    });
    await transaction.moderation.create({
      data: {
        kind: "dispute",
        subjectId: booking.id,
        title: `Booking ${booking.id} request`,
        details: String(body.reason || "Traveler requested review.").slice(0, 1000),
        status: "pending",
      },
    });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

async function createListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  if (user.profileStatus !== "verified") fail("Verify your profile before publishing listings.");
  const capacity = wholeNumber(body.capacity, "Capacity", 1, 100000);
  const price = positiveMoney(body.price, "Price");
  const name = String(body.name || "").trim().slice(0, 100);
  const municipality = String(body.municipality || "");
  if (!name || !isCebuLocation(municipality)) fail("Valid listing name, Cebu location, price, and capacity are required.");

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.create({
      data: {
        ownerId: user.id,
        name,
        category: listingCategory(body.category),
        price,
        capacity,
        available: capacity,
        status: "pending",
        description: String(body.description || "").trim().slice(0, 1000),
        municipality,
        address: String(body.address || "").trim().slice(0, 300),
        amenities: stringList(body.amenities),
        imageUrl: String(body.imageUrl || "").trim().slice(0, 500) || null,
      },
    });
    await transaction.moderation.create({
      data: { kind: "listing", subjectId: listing.id, title: `Review ${listing.name}`, details: `PHP ${price}; capacity ${capacity}`, status: "pending" },
    });
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(listing);
  });
}

async function updateListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const listingId = identifier(body.id);
  const capacity = wholeNumber(body.capacity, "Capacity", 1, 100000);
  const price = positiveMoney(body.price, "Price");
  const name = String(body.name || "").trim().slice(0, 100);
  const municipality = String(body.municipality || "");

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
    if (!listing) fail("Listing not found.");
    const bookedSlots = listing.capacity - listing.available;
    if (!name || !isCebuLocation(municipality) || capacity < Math.max(1, bookedSlots)) {
      fail("Provide a valid Cebu location; capacity cannot be lower than booked slots.");
    }

    const updated = await transaction.listing.update({
      where: { id: listing.id },
      data: {
        name,
        price,
        capacity,
        available: capacity - bookedSlots,
        category: body.category === undefined ? listing.category : listingCategory(body.category),
        municipality,
        description: String(body.description || "").trim().slice(0, 1000),
        address: String(body.address || "").trim().slice(0, 300),
        amenities: stringList(body.amenities),
        imageUrl: String(body.imageUrl || "").trim().slice(0, 500) || null,
        status: "pending",
      },
    });
    const pending = await transaction.moderation.count({ where: { kind: "listing", subjectId: listing.id, status: "pending" } });
    if (!pending) {
      await transaction.moderation.create({
        data: { kind: "listing", subjectId: listing.id, title: `Review updated ${name}`, details: `PHP ${price}; capacity ${capacity}`, status: "pending" },
      });
    }
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(updated);
  });
}

async function deleteListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const listingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
    if (!listing) fail("Listing not found.");
    if (await transaction.booking.count({ where: { listingId } })) fail("Listings with booking history cannot be deleted.");
    await transaction.moderation.deleteMany({ where: { subjectId: listingId } });
    await transaction.listing.delete({ where: { id: listingId } });
    await audit(transaction, user.id, action, listingId);
    return { id: listingId };
  });
}

async function ownerBookingDecision(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({
      where: { id: bookingId, listing: { ownerId: user.id } },
      include: { listing: true },
    });
    if (!booking || (booking.status !== "cancel_requested" && booking.status !== "change_requested")) {
      fail("Pending booking request not found.");
    }
    const approve = body.decision === "approve";
    let status: "cancelled" | "confirmed" = "confirmed";
    let nextPaymentStatus: "REFUNDED" | "PAID_HELD" = "PAID_HELD";
    if (booking.status === "cancel_requested" && approve) {
      status = "cancelled";
      nextPaymentStatus = "REFUNDED";
      await transaction.listing.update({
        where: { id: booking.listingId },
        data: { available: Math.min(booking.listing.capacity, booking.listing.available + booking.guests) },
      });
    }
    const updated = await transaction.booking.update({ where: { id: booking.id }, data: { status, paymentStatus: nextPaymentStatus } });
    await transaction.moderation.updateMany({ where: { kind: "dispute", subjectId: booking.id, status: "pending" }, data: { status: "resolved" } });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

async function releasePayment(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({ where: { id: bookingId, paymentStatus: "PAID_HELD", listing: { ownerId: user.id } } });
    if (!booking) fail("Held payment not found.");
    const updated = await transaction.booking.update({ where: { id: booking.id }, data: { paymentStatus: "Released", status: "completed" } });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

async function moderate(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const moderationId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const item = await transaction.moderation.findFirst({ where: { id: moderationId, status: "pending" } });
    if (!item) fail("Queue item not found.");
    const approve = body.decision === "approve" || body.decision === "traveler";
    const updated = await transaction.moderation.update({
      where: { id: item.id },
      data: { status: item.kind === "dispute" ? "resolved" : approve ? "approved" : "rejected" },
    });

    if (item.kind === "profile") {
      const target = await transaction.user.findUnique({ where: { id: item.subjectId } });
      if (target) {
        await transaction.user.update({
          where: { id: target.id },
          data: { profileStatus: approve ? "verified" : "rejected", trustScore: Math.max(0, Math.min(100, target.trustScore + (approve ? 10 : -10))) },
        });
      }
    }
    if (item.kind === "listing") {
      await transaction.listing.updateMany({ where: { id: item.subjectId }, data: { status: approve ? "approved" : "rejected" } });
    }
    if (item.kind === "dispute") {
      const booking = await transaction.booking.findUnique({ where: { id: item.subjectId } });
      if (booking) {
        if (approve && booking.status !== "cancelled") {
          const listing = await transaction.listing.findUnique({ where: { id: booking.listingId } });
          if (listing) {
            await transaction.listing.update({
              where: { id: listing.id },
              data: { available: Math.min(listing.capacity, listing.available + booking.guests) },
            });
          }
        }
        await transaction.booking.update({
          where: { id: booking.id },
          data: { status: approve ? "cancelled" : "confirmed", paymentStatus: approve ? "REFUNDED" : "PAID_HELD" },
        });
      }
    }
    await audit(transaction, user.id, action, item.id);
    return serializeModeration(updated);
  });
}

async function adminUserStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const targetId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const target = await transaction.user.findFirst({ where: { id: targetId, role: { not: "admin" } } });
    if (!target) fail("Managed user not found.");
    const updated = await transaction.user.update({ where: { id: target.id }, data: { accountStatus: body.status === "suspended" ? "suspended" : "active" } });
    await audit(transaction, user.id, action, target.id);
    return publicUser(updated);
  });
}

async function adminTrustScore(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const targetId = identifier(body.id);
  const score = wholeNumber(body.score, "Trust score", 0, 100);
  return prisma.$transaction(async (transaction) => {
    const target = await transaction.user.findFirst({ where: { id: targetId, role: { not: "admin" } } });
    if (!target) fail("Managed user not found.");
    const updated = await transaction.user.update({ where: { id: target.id }, data: { trustScore: score } });
    await audit(transaction, user.id, action, target.id);
    return publicUser(updated);
  });
}

async function adminListingStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const listingId = identifier(body.id);
  const status = body.status;
  if (status !== "approved" && status !== "rejected" && status !== "pending") fail("Listing or status is invalid.");
  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findUnique({ where: { id: listingId } });
    if (!listing) fail("Listing or status is invalid.");
    const updated = await transaction.listing.update({ where: { id: listing.id }, data: { status } });
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(updated);
  });
}

async function adminPaymentStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const bookingId = identifier(body.id);
  const status = paymentStatus(body.status);
  const allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    PAID_HELD: ["Released", "FROZEN_HELD", "REFUNDED"],
    FROZEN_HELD: ["PAID_HELD", "REFUNDED"],
    Released: [],
    REFUNDED: [],
  };

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findUnique({ where: { id: bookingId } });
    if (!booking) fail("Booking or payment status is invalid.");
    if (status !== booking.paymentStatus && !allowedTransitions[booking.paymentStatus].includes(status)) fail("That payment transition is not allowed.");
    if (status === "REFUNDED" && booking.status !== "cancelled") {
      const listing = await transaction.listing.findUnique({ where: { id: booking.listingId } });
      if (listing) {
        await transaction.listing.update({
          where: { id: listing.id },
          data: { available: Math.min(listing.capacity, listing.available + booking.guests) },
        });
      }
    }
    const updated = await transaction.booking.update({
      where: { id: booking.id },
      data: {
        paymentStatus: status,
        ...(status === "REFUNDED" ? { status: "cancelled" as const } : {}),
        ...(status === "Released" ? { status: "completed" as const } : {}),
      },
    });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

export async function executePlatformAction(user: PublicUser, action: string, body: Body): Promise<unknown> {
  switch (action) {
    case "submit-profile": return submitProfile(user, action, body);
    case "save-trip": return saveTrip(user, action, body);
    case "update-trip": return updateTrip(user, action, body);
    case "update-trip-itinerary": return updateTripItinerary(user, action, body);
    case "delete-trip": return deleteTrip(user, action, body);
    case "duplicate-trip": return duplicateTrip(user, action, body);
    case "book": return bookListing(user, action, body);
    case "request-cancel":
    case "request-change": return requestBookingReview(user, action, body);
    case "create-listing": return createListing(user, action, body);
    case "update-listing": return updateListing(user, action, body);
    case "delete-listing": return deleteListing(user, action, body);
    case "owner-request-decision": return ownerBookingDecision(user, action, body);
    case "release-payment": return releasePayment(user, action, body);
    case "moderate":
    case "resolve-dispute": return moderate(user, action, body);
    case "admin-user-status": return adminUserStatus(user, action, body);
    case "admin-trust-score": return adminTrustScore(user, action, body);
    case "admin-listing-status": return adminListingStatus(user, action, body);
    case "admin-payment-status": return adminPaymentStatus(user, action, body);
    default: fail("Action is not allowed for this account.");
  }
}
