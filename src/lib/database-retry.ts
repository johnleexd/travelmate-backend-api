import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_CODES = new Set([
  'P1001', 'P1002', 'P1017',
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
  '08006', '57P01', '57P02', '57P03',
]);
const CONNECTION_CODES = new Set([...RETRYABLE_CODES, 'EACCES']);
const RETRYABLE_KINDS = new Set(['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout']);
// pg can also report these connection failures without an error code.
const RETRYABLE_MESSAGES = new Set([
  'Connection terminated', 'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect',
]);

function matchesConnectionError(error: unknown, codes: Set<string>, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 8) return false;
  const details = error as { code?: unknown; kind?: unknown; message?: unknown; cause?: unknown; meta?: unknown; driverAdapterError?: unknown };
  if (typeof details.code === 'string' && codes.has(details.code)) return true;
  if (typeof details.kind === 'string' && RETRYABLE_KINDS.has(details.kind)) return true;
  if (typeof details.message === 'string' && RETRYABLE_MESSAGES.has(details.message)) return true;
  return matchesConnectionError(details.cause, codes, depth + 1)
    || matchesConnectionError(details.meta, codes, depth + 1)
    || matchesConnectionError(details.driverAdapterError, codes, depth + 1);
}

export function isDatabaseConnectionError(error: unknown): boolean {
  return matchesConnectionError(error, CONNECTION_CODES);
}

/** Only use for reads, replayable transactions, or conservative rate-limit increments. */
export async function retryDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  for (const waitMs of [250, 750]) {
    try {
      return await operation();
    } catch (error) {
      if (!matchesConnectionError(error, RETRYABLE_CODES)) throw error;
      await delay(waitMs);
    }
  }
  return operation();
}
