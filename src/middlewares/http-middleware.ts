import type { ErrorRequestHandler, RequestHandler } from "express";
import { apiErrorPayload } from "../contracts/api-error.ts";

export const disableApiCaching: RequestHandler = (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
};

export const apiNotFound: RequestHandler = (_request, response) => {
  response.status(404).json(apiErrorPayload("API route not found.", 404));
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof SyntaxError) {
    response.status(400).json(apiErrorPayload("Request body must be valid JSON.", 400));
    return;
  }

  console.error("[TravelMate API] Unhandled middleware error:", error);
  response.status(500).json(apiErrorPayload("Internal server error.", 500));
};
