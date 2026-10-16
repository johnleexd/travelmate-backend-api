// Calendar months use Asia/Manila (UTC+08:00, no DST), independent of host/client time.
export const PLAN_TIMEZONE = 'Asia/Manila';
export const GENERATION_DEADLINE_MS = 540_000;
export const RESERVATION_LEASE_MS = 720_000;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${name}.`);
  return Number(value);
}
export function planConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return {
    free: positiveInteger(env, 'AI_FREE_MONTHLY_LIMIT', 3, 100_000),
    plus: positiveInteger(env, 'AI_PLUS_MONTHLY_LIMIT', 30, 100_000),
    rateLimit: positiveInteger(env, 'AI_GENERATION_REQUEST_LIMIT', 6, 100),
    rateWindowMs: positiveInteger(env, 'AI_GENERATION_REQUEST_WINDOW_MS', 60_000, 3_600_000),
    provisional: true,
  };
}
export function allowancePeriod(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3_600_000);
  return {
    start: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 8 * 3_600_000),
    end: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 3_600_000),
  };
}
