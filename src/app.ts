import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import cors from "cors";
import { prisma } from "./lib/prisma.ts";
import * as auth from "./routes/auth.ts";
import * as platform from "./routes/platform.ts";
import * as itinerary from "./routes/itinerary.ts";
import * as weather from "./routes/weather.ts";
import * as locations from "./routes/locations.ts";
import * as accommodations from "./routes/accommodations.ts";
import * as profile from "./routes/profile.ts";
import * as travelOptions from "./routes/travel-options.ts";
import { allowedOrigins, sameOriginWrites, securityHeaders } from "./security.ts";

const app = express();
const trustedOrigins = allowedOrigins();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(securityHeaders());
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || trustedOrigins.includes(origin.replace(/\/$/, "")));
  },
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api", sameOriginWrites(trustedOrigins));
app.use("/api", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

type WebHandler = (request: Request) => Promise<Response> | Response;

function webRequest(request: ExpressRequest): Request {
  const protocol = request.protocol || "http";
  const host = request.get("host") || "localhost:5000";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  headers.set("x-client-ip", request.ip || request.socket.remoteAddress || "local");
  const canHaveBody = !["GET", "HEAD"].includes(request.method);
  return new Request(`${protocol}://${host}${request.originalUrl}`, {
    method: request.method,
    headers,
    body: canHaveBody ? JSON.stringify(request.body ?? {}) : undefined,
  });
}

function route(handler: WebHandler) {
  return async (request: ExpressRequest, response: ExpressResponse) => {
    try {
      const result = await handler(webRequest(request));
      response.status(result.status);
      result.headers.forEach((value, name) => response.setHeader(name, value));
      const body = Buffer.from(await result.arrayBuffer());
      response.send(body);
    } catch (error) {
      console.error("[TravelMate API] Unhandled request error:", error);
      response.status(500).json({ error: "Internal server error." });
    }
  };
}

app.get("/", (_request, response) => response.json({ name: "TravelMate API", status: "ok" }));
app.get("/health", async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("[TravelMate API] Database health check failed:", error);
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/api/auth", route(auth.GET));
app.post("/api/auth", route(auth.POST));
app.get("/api/platform", route(platform.GET));
app.post("/api/platform", route(platform.POST));
app.post("/api/itinerary", route(itinerary.POST));
app.get("/api/weather", route(weather.GET));
app.get("/api/locations", route(locations.GET));
app.get("/api/accommodations", route(accommodations.GET));
app.get("/api/travel-options", route(travelOptions.GET));
app.get("/api/profile", route(profile.GET));
app.patch("/api/profile", route(profile.PATCH));

app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));

app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }
  console.error("[TravelMate API] Unhandled middleware error:", error);
  response.status(500).json({ error: "Internal server error." });
});

export default app;
