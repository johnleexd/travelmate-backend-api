import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const requestIdPattern = /^[A-Za-z0-9._-]{8,100}$/;

export function requestLogging(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.get('x-request-id')?.trim();
  const requestId = supplied && requestIdPattern.test(supplied) ? supplied : randomUUID();
  const startedAt = Date.now();
  response.setHeader('X-Request-Id', requestId);
  response.on('finish', () => {
    console.info(JSON.stringify({
      level: 'info', event: 'http_request', requestId, method: request.method,
      path: request.originalUrl.split('?', 1)[0], status: response.statusCode,
      durationMs: Date.now() - startedAt, timestamp: new Date().toISOString(),
    }));
  });
  next();
}
