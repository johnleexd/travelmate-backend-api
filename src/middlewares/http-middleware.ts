import type { ErrorRequestHandler, RequestHandler } from "express";

export const disableApiCaching: RequestHandler = (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
};

export const apiNotFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "API route not found." });
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }

  console.error("[TravelMate API] Unhandled middleware error:", error);
  response.status(500).json({ error: "Internal server error." });
};
