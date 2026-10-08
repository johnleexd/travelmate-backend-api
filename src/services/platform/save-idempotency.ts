import { createHash } from 'node:crypto';
import { PlatformActionError } from '../../exceptions/index.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function saveIdentity(body: Record<string, unknown>) {
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => !['action', 'saveKey'].includes(key)));
  const hash = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  const key = body.saveKey ?? `content:${hash}`;
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,100}$/.test(key)) throw new PlatformActionError('Save request key is invalid.');
  return { key, hash };
}
