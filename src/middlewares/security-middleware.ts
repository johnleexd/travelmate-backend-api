import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowedOrigins(environment: NodeJS.ProcessEnv = process.env): string[] {
  return (environment.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function requestOriginAllowed(
  method: string,
  origin: string | undefined,
  fetchSite: string | undefined,
  origins: string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;
  return origins.includes(origin.replace(/\/$/, ""));
}

export function securityHeaders(environment: NodeJS.ProcessEnv = process.env) {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (environment.NODE_ENV === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

export function sameOriginWrites(origins: string[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!requestOriginAllowed(request.method, request.get("origin"), request.get("sec-fetch-site"), origins)) {
      response.status(403).json({ error: "Cross-site write request rejected." });
      return;
    }
    next();
  };
}
