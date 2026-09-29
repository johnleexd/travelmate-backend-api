import assert from 'node:assert/strict';
import test from 'node:test';
import { clearExchangeRateCache, getExchangeRate } from '../src/services/currency/exchange-rate-service.ts';

test('exchange rates normalize a supported destination currency into the traveler reference currency', async () => {
  clearExchangeRateCache();
  const requests: string[] = [];
  const quote = await getExchangeRate('jpy', 'php', async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ date: '2026-09-16', base: 'JPY', quote: 'PHP', rate: 0.40611 }), { status: 200 });
  }, new Date('2026-09-16T05:00:00.000Z'));

  assert.deepEqual(requests, ['https://api.frankfurter.dev/v2/rate/jpy/php']);
  assert.equal(quote.base, 'JPY');
  assert.equal(quote.quote, 'PHP');
  assert.equal(quote.rate, 0.40611);
  assert.equal(quote.asOf, '2026-09-16');
  assert.equal(quote.freshness.status, 'live');
  assert.match(quote.disclaimer, /Reference mid-market/);
});

test('exchange rates serve a clearly stale cached quote only after provider failure', async () => {
  clearExchangeRateCache();
  await getExchangeRate('JPY', 'PHP', async () => new Response(JSON.stringify({ date: '2026-09-16', base: 'JPY', quote: 'PHP', rate: 0.40611 }), { status: 200 }), new Date('2026-09-16T05:00:00.000Z'));
  const stale = await getExchangeRate('JPY', 'PHP', async () => { throw new Error('provider down'); }, new Date('2026-09-16T12:00:00.000Z'));
  assert.equal(stale.rate, 0.40611);
  assert.equal(stale.freshness.status, 'stale-cache');
  assert.equal(stale.freshness.isStale, true);
});

test('same-currency reference labels use an exact rate without calling the provider', async () => {
  clearExchangeRateCache();
  const quote = await getExchangeRate('USD', 'USD', async () => {
    throw new Error('Provider must not be called.');
  }, new Date('2026-09-16T05:00:00.000Z'));
  assert.equal(quote.rate, 1);
  assert.equal(quote.freshness.status, 'live');
});

test('exchange rates reject malformed provider data instead of inventing a conversion', async () => {
  clearExchangeRateCache();
  await assert.rejects(
    getExchangeRate('USD', 'PHP', async () => new Response(JSON.stringify({ rate: 0 }), { status: 200 })),
    /invalid data/,
  );
});
