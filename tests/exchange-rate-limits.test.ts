import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { GET_EXCHANGE_RATE } from '../src/controllers/destination-context-controller.ts';
import { clearExchangeRateCache, ExchangeRateProviderRateLimit, getExchangeRate } from '../src/services/currency/exchange-rate-service.ts';

test('backend shares concurrent provider requests, reuses fresh pairs and refreshes expired pairs once', async () => {
  clearExchangeRateCache(); let calls = 0; let release!: (response: Response) => void;
  const now = new Date('2026-10-06T12:00:00Z');
  const provider = async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
  const requests = [getExchangeRate('JPY', 'PHP', provider, now), getExchangeRate('JPY', 'PHP', provider, now)];
  assert.equal(calls, 1); release(Response.json({ date: '2026-10-06', base: 'JPY', quote: 'PHP', rate: 0.4 }));
  await Promise.all(requests); assert.equal((await getExchangeRate('JPY', 'PHP', provider, now)).freshness.status, 'fresh-cache'); assert.equal(calls, 1);
  const later = new Date(now.getTime() + 6 * 60 * 60_000);
  const refreshed = [getExchangeRate('JPY', 'PHP', provider, later), getExchangeRate('JPY', 'PHP', provider, later)];
  assert.equal(calls, 2); release(Response.json({ date: '2026-10-06', base: 'JPY', quote: 'PHP', rate: 0.41 }));
  assert.ok((await Promise.all(refreshed)).every(rate => rate.rate === 0.41)); clearExchangeRateCache();
});

test('provider 429 is identified and cached until Retry-After instead of hammering upstream', async () => {
  clearExchangeRateCache(); let calls = 0;
  const now = new Date('2026-10-06T12:00:00Z');
  const provider = async () => { calls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }); };
  await assert.rejects(getExchangeRate('JPY', 'PHP', provider, now), error => error instanceof ExchangeRateProviderRateLimit && error.retryAt === now.getTime() + 120_000);
  await assert.rejects(getExchangeRate('JPY', 'PHP', provider, new Date(now.getTime() + 119_000)));
  assert.equal(calls, 1);
  await assert.rejects(getExchangeRate('JPY', 'PHP', provider, new Date(now.getTime() + 120_000)));
  assert.equal(calls, 2); clearExchangeRateCache();
});

test('upstream date Retry-After and stale cache preserve provider protection', async () => {
  clearExchangeRateCache(); let calls = 0;
  const initial = new Date('2026-10-06T05:00:00Z');
  await getExchangeRate('JPY', 'PHP', async () => Response.json({ date: '2026-10-06', base: 'JPY', quote: 'PHP', rate: 0.4 }), initial);
  const later = new Date('2026-10-06T12:00:00Z');
  const provider = async () => { calls++; return Response.json({}, { status: 429, headers: { 'Retry-After': 'Tue, 06 Oct 2026 12:02:00 GMT' } }); };
  assert.equal((await getExchangeRate('JPY', 'PHP', provider, later)).freshness.isStale, true);
  assert.equal((await getExchangeRate('JPY', 'PHP', provider, new Date(later.getTime() + 30_000))).freshness.isStale, true);
  assert.equal(calls, 1); clearExchangeRateCache();
});

test('HTTP responses distinguish backend limiter and upstream limiter, preserving the 60/minute limit', async t => {
  const replace = (object: object, key: string, value: unknown) => { const prior = Reflect.get(object, key); Reflect.set(object, key, value); t.after(() => Reflect.set(object, key, prior)); };
  replace(prisma.user, 'findFirst', async () => ({ id: 'rates-test', role: 'traveler', accountStatus: 'active', emailVerified: true }));
  let count = 61; const sql: string[] = [];
  replace(prisma, '$queryRaw', async (strings: TemplateStringsArray, ...values: unknown[]) => { sql.push(values.join('|')); return [{ count, reset_at: new Date(Date.now() + 60_000) }]; });
  t.mock.method(Math, 'random', () => 0.5);
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { upstreamCalls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '90' } }); });
  clearExchangeRateCache(); t.after(clearExchangeRateCache);
  const request = () => new Request('http://localhost/api/destination-context/exchange-rate?base=JPY&quote=PHP', { headers: { cookie: `travelmate_session=${createSessionToken('rates-test', 'traveler')}` } });
  const backend = await GET_EXCHANGE_RATE(request());
  assert.equal(backend.status, 429); assert.equal(backend.headers.get('X-Rate-Limit-Source'), 'backend'); assert.equal(backend.headers.get('Retry-After'), '60'); assert.equal(upstreamCalls, 0);
  count = 60;
  const upstream = await GET_EXCHANGE_RATE(request());
  assert.equal(upstream.status, 429); assert.equal(upstream.headers.get('X-Rate-Limit-Source'), 'upstream'); assert.ok(Number(upstream.headers.get('Retry-After')) >= 89);
  assert.equal(upstreamCalls, 1); assert.match(sql[0], /exchange-rate:rates-test/);
  await GET_EXCHANGE_RATE(request()); assert.equal(upstreamCalls, 1);
});
