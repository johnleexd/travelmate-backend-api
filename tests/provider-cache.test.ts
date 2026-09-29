import assert from 'node:assert/strict';
import test from 'node:test';
import { clearProviderCache, withProviderCache } from '../src/services/cache/provider-cache.ts';

const policy = { source: 'flights' as const, freshForMs: 1_000, staleForMs: 5_000 };

test('provider cache labels live, fresh, and stale results explicitly', async () => {
  clearProviderCache();
  let calls = 0;
  const first = await withProviderCache('route', policy, async () => ({ value: ++calls }), 1_000);
  assert.equal(first.freshness.status, 'live');
  const fresh = await withProviderCache('route', policy, async () => ({ value: ++calls }), first.freshness.fetchedAt ? new Date(first.freshness.fetchedAt).getTime() + 500 : 1_500);
  assert.equal(fresh.freshness.status, 'fresh-cache');
  assert.equal(calls, 1);
  const stale = await withProviderCache('route', policy, async () => { calls += 1; throw new Error('provider down'); }, new Date(first.freshness.fetchedAt).getTime() + 2_000);
  assert.equal(stale.freshness.status, 'stale-cache');
  assert.equal(stale.freshness.isStale, true);
});

test('provider cache refuses data after the stale window', async () => {
  clearProviderCache();
  const first = await withProviderCache('expired', policy, async () => 'value', 1_000);
  await assert.rejects(() => withProviderCache('expired', policy, async () => { throw new Error('provider down'); }, new Date(first.freshness.fetchedAt).getTime() + 6_000), /provider down/);
});
