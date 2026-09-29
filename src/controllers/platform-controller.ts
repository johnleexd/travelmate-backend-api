import { requireUser } from "../middlewares/auth-middleware.ts";
import { readScopedDb } from "../repositories/platform-repository.ts";
import { publicUser } from "../schemas/domain.ts";
import { PlatformActionError } from "../exceptions/index.ts";
import { executePlatformAction } from "../services/platform/platform-service.ts";
import { allowRequest } from "../middlewares/rate-limit-middleware.ts";

function errorResponse(error: unknown): Response {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (error instanceof PlatformActionError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("[TravelMate] Platform request failed:", error);
  return Response.json({ error: "Platform request failed." }, { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const requestedRole = new URL(request.url).searchParams.get("scope");
    const scope = requestedRole === "traveler" || requestedRole === "admin" ? requestedRole : undefined;
    const user = await requireUser(request, scope);
    const db = await readScopedDb(user);
    const listings = user.role === "admin" ? db.listings : db.listings.filter((item) => item.status === "approved");
    const bookings = user.role === "traveler" ? db.bookings.filter((item) => item.travelerId === user.id) : db.bookings;
    const directory = user.role === "admin" ? db.users.map(publicUser) : [];
    const metrics = {
      held: bookings.filter((item) => item.paymentStatus === "PAID_HELD").reduce((sum, item) => sum + item.amount, 0),
      released: bookings.filter((item) => item.paymentStatus === "Released").reduce((sum, item) => sum + item.amount, 0),
      frozen: bookings.filter((item) => item.paymentStatus === "FROZEN_HELD").reduce((sum, item) => sum + item.amount, 0),
      activeUsers: user.role === 'admin' ? db.users.filter((item) => item.accountStatus === "active").length : 0,
      pendingProfiles: user.role === 'admin' ? db.users.filter((item) => item.profileStatus === "pending").length : 0,
      listingViews: user.role === 'admin' ? listings.reduce((sum, item) => sum + item.viewCount, 0) : 0,
      bookingRequests: user.role === 'admin' ? bookings.length : 0,
      occupancy: user.role === 'admin' && listings.reduce((sum, item) => sum + item.capacity, 0) > 0 ? Math.round((listings.reduce((sum, item) => sum + item.capacity - item.available, 0) / listings.reduce((sum, item) => sum + item.capacity, 0)) * 100) : 0,
      revenue: user.role === 'admin' ? db.transactions.filter((item) => item.status === 'released').reduce((sum, item) => sum + item.amount, 0) : 0,
    };
    const configured = (value: string | undefined) => Boolean(value && !value.startsWith("your_") && !value.startsWith("replace_"));
    const integrations = user.role === "admin" ? { database: true, openAI: configured(process.env.OPENAI_API_KEY), gemini: configured(process.env.GEMINI_API_KEY), weather: true, amadeus: configured(process.env.AMADEUS_API_KEY) && configured(process.env.AMADEUS_API_SECRET), payMongo: false } : undefined;
    const ownedTripIds = new Set(db.trips.filter((item) => item.userId === user.id).map((item) => item.id));
    return Response.json({
      user,
      listings,
      bookings,
      directory,
      metrics,
      integrations,
      trips: user.role === "traveler" ? db.trips.filter((item) => item.userId === user.id).reverse() : [],
      itineraryVersions: user.role === "traveler" ? db.itineraryVersions.filter((item) => ownedTripIds.has(item.tripId)) : [],
      itineraryGenerations: db.itineraryGenerations.filter((item) => user.role === "admin" || item.userId === user.id).map((item) => ({ id: item.id, destination: item.destination, status: item.status, errorCode: item.errorCode, createdAt: item.createdAt, updatedAt: item.updatedAt })).slice(0, 25),
      moderation: user.role === "admin" ? db.moderation.filter((item) => item.kind === "report") : [],
      audit: user.role === "admin" ? db.audit.slice(0, 100) : [],
      blockedDates: db.blockedDates,
      promotions: db.promotions,
      reviews: db.reviews,
      notifications: db.notifications,
      transactions: db.transactions,
      ownerDocuments: db.ownerDocuments,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    if (!await allowRequest(`platform:${user.id}`, 60, 60_000)) return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    const body = await request.json().catch(() => {
      throw new PlatformActionError("Request body must be valid JSON.");
    }) as Record<string, unknown>;
    const action = String(body.action || "");
    const result = await executePlatformAction(user, action, body);
    return Response.json({ result });
  } catch (error) {
    return errorResponse(error);
  }
}
