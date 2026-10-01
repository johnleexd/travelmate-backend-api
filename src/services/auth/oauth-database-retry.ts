import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_CODES = new Set([
  'P1001', 'P1002', 'P1017',
  'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
]);
const CONNECTION_CODES = new Set([...RETRYABLE_CODES, 'EACCES']);

function hasConnectionCode(error: unknown, codes: Set<string>, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const details = error as { code?: unknown; cause?: unknown; meta?: unknown };
  if (typeof details.code === 'string' && codes.has(details.code)) return true;
  return hasConnectionCode(details.cause, codes, depth + 1) || hasConnectionCode(details.meta, codes, depth + 1);
}

export function isDatabaseConnectionError(error: unknown): boolean {
  return hasConnectionCode(error, CONNECTION_CODES);
}

export async function retryOAuthDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  for (const waitMs of [150, 350]) {
    try {
      return await operation();
    } catch (error) {
      if (!hasConnectionCode(error, RETRYABLE_CODES)) throw error;
      await delay(waitMs);
    }
  }
  return operation();
}
