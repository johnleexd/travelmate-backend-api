import type { NextFunction, Request, Response } from "express";
import { apiErrorPayload } from "../contracts/api-error.ts";

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
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (environment.NODE_ENV === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

export function requestUsesHttps(request: Pick<Request, "secure" | "get">): boolean {
  if (request.secure) return true;
  const forwardedProtocol = request.get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  return forwardedProtocol === "https";
}

export function enforceHttps(environment: NodeJS.ProcessEnv = process.env) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (environment.NODE_ENV !== "production" || requestUsesHttps(request)) {
      next();
      return;
    }

    response
      .status(426)
      .json(apiErrorPayload("HTTPS is required for the TravelMate API.", 426));
  };
}

export function sameOriginWrites(origins: string[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!requestOriginAllowed(request.method, request.get("origin"), request.get("sec-fetch-site"), origins)) {
      response.status(403).json(apiErrorPayload("Cross-site write request rejected.", 403));
      return;
    }
    next();
  };
}
