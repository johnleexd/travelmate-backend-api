import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { normalizeApiError } from "../contracts/api-error.ts";

export type WebHandler = (request: Request) => Promise<Response> | Response;

function toWebRequest(request: ExpressRequest): Request {
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

export function adaptWebHandler(handler: WebHandler) {
  return async (request: ExpressRequest, response: ExpressResponse): Promise<void> => {
    const result = await handler(toWebRequest(request));
    response.status(result.status);
    result.headers.forEach((value, name) => { if (name.toLowerCase() !== 'set-cookie') response.setHeader(name, value); });
    const setCookies = result.headers.getSetCookie();
    if (setCookies.length > 0) response.setHeader('set-cookie', setCookies);
    const body = Buffer.from(await result.arrayBuffer());
    if (result.status >= 400 && result.headers.get("content-type")?.includes("application/json")) {
      try {
        const normalized = normalizeApiError(JSON.parse(body.toString("utf8")), result.status);
        if (normalized) {
          response.removeHeader("content-length");
          response.send(JSON.stringify(normalized));
          return;
        }
      } catch {
        // Preserve malformed controller output so the client reports an invalid response.
      }
    }
    response.send(body);
  };
}
