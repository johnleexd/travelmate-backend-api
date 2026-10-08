import { readAdminOverview } from '../repositories/admin-overview-repository.ts';
import { readVisitedPlaces } from '../services/platform/visited-place-service.ts';
import { requireUser } from "../middlewares/auth-middleware.ts";
import { readScopedDb } from "../repositories/platform-repository.ts";
import { publicUser } from "../schemas/domain.ts";
import { PlatformActionError } from "../exceptions/index.ts";
import { executePlatformAction } from "../services/platform/platform-service.ts";
import { allowRequest } from "../middlewares/rate-limit-middleware.ts";
import { isDatabaseConnectionError } from "../lib/database-retry.ts";
import { countUnreadNotifications, readNotificationSnapshot, readNotifications, readTripDetails, readTripPage, readTripVersions } from '../repositories/trip-workspace-repository.ts';

function errorResponse(error: unknown): Response {
  if (isDatabaseConnectionError(error)) throw error;
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
    const parameters = new URL(request.url).searchParams;
    const summary = user.role === 'traveler' && parameters.get('summary') === 'true';
    const db = await readScopedDb(user, !summary);
    const tripPage = summary ? await readTripPage(user, pageCursor(request)) : undefined;
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
      adminOverview: user.role === 'admin' ? await readAdminOverview() : undefined,
      listings,
      bookings,
      directory,
      metrics,
      integrations,
      trips: tripPage?.trips ?? (user.role === "traveler" ? db.trips.filter((item) => item.userId === user.id).reverse() : []),
      tripsPage: tripPage?.page,
      itineraryVersions: user.role === "traveler" ? db.itineraryVersions.filter((item) => ownedTripIds.has(item.tripId)) : [],
      itineraryGenerations: db.itineraryGenerations.filter((item) => user.role === "admin" || item.userId === user.id).map((item) => ({ id: item.id, destination: item.destination, status: item.status, errorCode: item.errorCode, createdAt: item.createdAt, updatedAt: item.updatedAt })).slice(0, 25),
      moderation: user.role === "admin" ? db.moderation.filter((item) => item.kind === "report" || item.kind === 'appeal') : [],
      audit: user.role === "admin" ? db.audit.slice(0, 100) : [],
      blockedDates: db.blockedDates,
      promotions: db.promotions,
      reviews: db.reviews,
      notifications: db.notifications,
      notificationsUnreadCount: user.role === 'admin' ? await countUnreadNotifications(user) : undefined,
      transactions: db.transactions,
      ownerDocuments: db.ownerDocuments,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function pageCursor(request: Request): string | undefined {
  const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  if (cursor && cursor.length > 100) throw new PlatformActionError('Page cursor is invalid.');
  return cursor;
}

export async function GET_NOTIFICATIONS(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    return Response.json(user.role === 'admin' ? await readNotificationSnapshot(user) : { notifications: await readNotifications(user) });
  } catch (error) { return errorResponse(error); }
}

export async function GET_VISITED_PLACES(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    return Response.json(await readVisitedPlaces(user, pageCursor(request), new URL(request.url).searchParams.get('q') || ''));
  } catch (error) { return errorResponse(error); }
}

export async function GET_TRIP(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!);
    return Response.json({ trip: await readTripDetails(user, id) });
  } catch (error) { return errorResponse(error); }
}

export async function GET_VERSIONS(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, 'traveler');
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-2)!);
    return Response.json(await readTripVersions(user, id, pageCursor(request)));
  } catch (error) { return errorResponse(error); }
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
