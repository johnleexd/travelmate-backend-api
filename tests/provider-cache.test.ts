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
test('shorter missing-photo lifetimes also expire old cached misses while preserving valid photos', async () => {
  clearProviderCache(); let calls = 0;
  const old = { source: 'activities' as const, freshForMs: 86400000, staleForMs: 604800000 };
  const next = { ...old, emptyForMs: 60000 };
  await withProviderCache('missing-cover', old, async () => [], 1000);
  await withProviderCache('valid-cover', old, async () => ['existing photo'], 1000);
  assert.deepEqual((await withProviderCache('missing-cover', next, async () => { calls++; return ['recovered photo']; }, 62000)).value, ['recovered photo']);
  assert.deepEqual((await withProviderCache('valid-cover', next, async () => { calls++; return ['replacement']; }, 62000)).value, ['existing photo']);
  assert.equal(calls, 1);
});
