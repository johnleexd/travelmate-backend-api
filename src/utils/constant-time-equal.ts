import { timingSafeEqual } from 'node:crypto';

/** Malformed or differently encoded input must fail verification without throwing. */
export function constantTimeEqual(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
