import { PlanError } from './plan-error.ts';

export function testCheckoutConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const amount = Number(env.PAYMONGO_TEST_AMOUNT_CENTAVOS || 10000);
  const durationDays = Number(env.PAYMONGO_TEST_PLUS_DAYS || 30);
  const origin = env.PAYMONGO_TEST_RETURN_ORIGIN || 'http://localhost:3000';
  let localOrigin = false;
  try { const url = new URL(origin); localOrigin = url.origin === origin && ['localhost', '127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol); } catch { /* Disabled unless explicitly local. */ }
  const enabled = env.PAYMONGO_TEST_CHECKOUT_ENABLED === 'true' && env.NODE_ENV !== 'production'
    && !!env.PAYMONGO_SECRET_KEY?.trim().startsWith('sk_test_') && !!env.PAYMONGO_WEBHOOK_SECRET?.trim().startsWith('whsk_')
    && localOrigin && Number.isInteger(amount) && amount >= 100 && amount <= 1000000 && Number.isInteger(durationDays) && durationDays >= 1 && durationDays <= 365;
  return { enabled, amount, currency: 'PHP' as const, durationDays, origin };
}

export class PaymongoTestError extends Error {
  status: number;
  constructor(status: number) { super('PayMongo test checkout is temporarily unavailable. Try checking the existing order before starting another.'); this.status = status; }
}

export function assertTestCheckout() {
  const config = testCheckoutConfiguration();
  if (!config.enabled) throw new PlanError('Test checkout is unavailable. Live payments are disabled.', 503, 'SERVICE_UNAVAILABLE');
  return config;
}

// Only test credentials, the official HTTPS API, no redirects or secret-bearing logs.
export async function paymongoTestRequest(path: string, method = 'GET', body?: unknown) {
  assertTestCheckout();
  let response: Response;
  try {
    response = await fetch('https://api.paymongo.com/v1/' + path, {
      method, headers: { Authorization: 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY!.trim() + ':').toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000),
    });
  } catch { throw new PaymongoTestError(503); }
  if (!response.ok) {
    // Errors can contain customer or credential details. Retain only status/code.
    const error = await response.json().catch(() => null);
    const code = String(error?.errors?.[0]?.code || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
    console.warn(JSON.stringify({ event: 'paymongo_test_api_failure', status: response.status, code }));
    throw new PaymongoTestError(response.status);
  }
  const value = await response.json().catch(() => null);
  if (!value?.data) throw new PaymongoTestError(502);
  return value.data;
}

export function safeTestCheckoutUrl(value: unknown): string {
  if (typeof value !== 'string') throw new PaymongoTestError(502);
  try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === 'checkout.paymongo.com' && !url.username && !url.password && !url.port) return url.href; } catch { /* Never redirect to an arbitrary provider value. */ }
  throw new PaymongoTestError(502);
}
