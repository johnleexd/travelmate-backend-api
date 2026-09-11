import { requireUser } from "../session.ts";
import { readDb } from "../store.ts";
import { publicUser } from "../domain.ts";
import { executePlatformAction, PlatformActionError } from "../services/platform-service.ts";
import { allowRequest } from "../rate-limit.ts";

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
    const scope = requestedRole === "traveler" || requestedRole === "owner" || requestedRole === "admin" ? requestedRole : undefined;
    const user = await requireUser(request, scope);
    const db = await readDb();
    const listings = user.role === "owner" ? db.listings.filter((item) => item.ownerId === user.id) : user.role === "admin" ? db.listings : db.listings.filter((item) => item.status === "approved");
    const listingIds = new Set(listings.map((item) => item.id));
    const bookings = user.role === "traveler" ? db.bookings.filter((item) => item.travelerId === user.id) : user.role === "owner" ? db.bookings.filter((item) => listingIds.has(item.listingId)) : db.bookings;
    const directory = user.role === "admin" ? db.users.map(publicUser) : user.role === "owner" ? db.users.filter((item) => bookings.some((booking) => booking.travelerId === item.id)).map(publicUser) : [];
    const metrics = {
      held: db.bookings.filter((item) => item.paymentStatus === "PAID_HELD").reduce((sum, item) => sum + item.amount, 0),
      released: db.bookings.filter((item) => item.paymentStatus === "Released").reduce((sum, item) => sum + item.amount, 0),
      frozen: db.bookings.filter((item) => item.paymentStatus === "FROZEN_HELD").reduce((sum, item) => sum + item.amount, 0),
      activeUsers: db.users.filter((item) => item.accountStatus === "active").length,
      pendingProfiles: db.users.filter((item) => item.profileStatus === "pending").length,
    };
    const configured = (value: string | undefined) => Boolean(value && !value.startsWith("your_") && !value.startsWith("replace_"));
    const integrations = user.role === "admin" ? { database: true, openAI: configured(process.env.OPENAI_API_KEY), gemini: configured(process.env.GEMINI_API_KEY), weather: true, amadeus: configured(process.env.AMADEUS_API_KEY) && configured(process.env.AMADEUS_API_SECRET), payMongo: false } : undefined;
    return Response.json({
      user,
      listings,
      bookings,
      directory,
      metrics,
      integrations,
      trips: user.role === "traveler" ? db.trips.filter((item) => item.userId === user.id).reverse() : [],
      moderation: user.role === "admin" ? db.moderation.filter((item) => item.status === "pending") : [],
      audit: user.role === "admin" ? db.audit.slice(-100).reverse() : [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    if (!allowRequest(`platform:${user.id}`, 60, 60_000)) return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
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
