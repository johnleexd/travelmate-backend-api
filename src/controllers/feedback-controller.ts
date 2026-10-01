import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { requireUser } from "../middlewares/auth-middleware.ts";
import { allowRequest } from "../middlewares/rate-limit-middleware.ts";
import { feedbackInputSchema, sentimentForRating } from "../services/feedback/feedback-schema.ts";

const PAGE_SIZE = 20;

function failure(error: unknown): Response {
  if (error instanceof Error && error.message === "UNAUTHORIZED") return Response.json({ error: "Unauthorized." }, { status: 401 });
  console.error("[TravelMate] Feedback request failed:", error);
  return Response.json({ error: "Feedback request failed." }, { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request, "admin");
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Math.min(10000, Number.parseInt(params.get("page") || "1", 10) || 1));
    const rating = params.get("rating");
    const sentiment = params.get("sentiment");
    const range = params.get("range");
    const category = params.get("category");
    const where: Prisma.UserFeedbackWhereInput = {};

    if (rating && rating !== "all") {
      const value = Number(rating);
      if (!Number.isInteger(value) || value < 1 || value > 5) return Response.json({ error: "Invalid rating filter." }, { status: 400 });
      where.rating = value;
    }
    if (sentiment && sentiment !== "all") {
      if (sentiment === "negative") where.rating = { in: [1, 2] };
      else if (sentiment === "neutral") where.rating = 3;
      else if (sentiment === "positive") where.rating = { in: [4, 5] };
      else return Response.json({ error: "Invalid sentiment filter." }, { status: 400 });
      if (rating && rating !== "all") where.rating = { equals: Number(rating), in: sentiment === "negative" ? [1, 2] : sentiment === "neutral" ? [3] : [4, 5] };
    }
    if (range && range !== "all") {
      const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 0;
      if (!days) return Response.json({ error: "Invalid date range." }, { status: 400 });
      where.createdAt = { gte: new Date(Date.now() - days * 86_400_000) };
    }
    if (category && category !== "all") where.category = category;

    const [total, rows] = await Promise.all([
      prisma.userFeedback.count({ where }),
      prisma.userFeedback.findMany({
        where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        select: { id: true, rating: true, category: true, comment: true, createdAt: true,
          user: { select: { id: true, name: true, email: true } },
          trip: { select: { id: true, destination: true, startDate: true, endDate: true } },
        },
      }),
    ]);
    return Response.json({ total, page, pageSize: PAGE_SIZE, items: rows.map((row) => ({
      id: row.id, rating: row.rating, sentiment: sentimentForRating(row.rating), category: row.category,
      comment: row.comment, createdAt: row.createdAt.toISOString(), user: row.user,
      trip: { ...row.trip, startDate: row.trip.startDate.toISOString().slice(0, 10), endDate: row.trip.endDate.toISOString().slice(0, 10) },
    })) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request, "traveler");
    if (!await allowRequest(`feedback:${user.id}`, 5, 60 * 60_000)) return Response.json({ error: "Too many feedback submissions. Try again later." }, { status: 429 });
    const body = await request.json().catch(() => null);
    const parsed = feedbackInputSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Choose a saved trip, rating, category, and a comment of 10–2000 characters." }, { status: 400 });
    const trip = await prisma.trip.findFirst({ where: { id: parsed.data.tripId, userId: user.id }, select: { id: true } });
    if (!trip) return Response.json({ error: "Saved trip not found." }, { status: 404 });
    const created = await prisma.userFeedback.create({ data: { userId: user.id, ...parsed.data }, select: { id: true } });
    return Response.json({ id: created.id, message: "Thanks for helping us improve TravelMate." }, { status: 201 });
  } catch (error) { return failure(error); }
}
