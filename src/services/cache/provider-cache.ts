export type CacheStatus = 'live' | 'fresh-cache' | 'stale-cache' | 'unavailable';

export interface CachePolicy {
  source: 'flights' | 'hotels' | 'activities' | 'weather' | 'exchange-rates';
  freshForMs: number;
  staleForMs: number;
}

export interface FreshnessMetadata {
  source: CachePolicy['source'];
  status: CacheStatus;
  isStale: boolean;
  fetchedAt: string;
  expiresAt: string;
  staleUntil: string;
  policy: string;
}

type Entry<T> = { value: T; fetchedAt: number; expiresAt: number; staleUntil: number };
const cache = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<Entry<unknown>>>();
const MAX_ENTRIES = 300;

export function cachePolicyLabel(policy: CachePolicy): string {
  return `${Math.round(policy.freshForMs / 60_000)}m fresh; stale fallback up to ${Math.round(policy.staleForMs / 60_000)}m when the provider fails.`;
}

function metadata(entry: Entry<unknown>, policy: CachePolicy, status: CacheStatus): FreshnessMetadata {
  return {
    source: policy.source,
    status,
    isStale: status === 'stale-cache',
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    staleUntil: new Date(entry.staleUntil).toISOString(),
    policy: cachePolicyLabel(policy),
  };
}

function prune(now: number): void {
  for (const [key, entry] of cache) if (entry.staleUntil <= now) cache.delete(key);
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

export async function withProviderCache<T>(key: string, policy: CachePolicy, loader: () => Promise<T>, now = Date.now()): Promise<{ value: T; freshness: FreshnessMetadata }> {
  const cacheKey = `${policy.source}:${key}`;
  const cached = cache.get(cacheKey) as Entry<T> | undefined;
  if (cached && cached.expiresAt > now) return { value: cached.value, freshness: metadata(cached, policy, 'fresh-cache') };

  try {
    let pending = inFlight.get(cacheKey) as Promise<Entry<T>> | undefined;
    if (!pending) {
      pending = loader().then((value) => {
        const fetchedAt = now;
        const entry: Entry<T> = { value, fetchedAt, expiresAt: fetchedAt + policy.freshForMs, staleUntil: fetchedAt + policy.staleForMs };
        prune(fetchedAt);
        cache.set(cacheKey, entry);
        return entry;
      }).finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, pending as Promise<Entry<unknown>>);
    }
    const loaded = await pending;
    return { value: loaded.value, freshness: metadata(loaded, policy, 'live') };
  } catch (error) {
    if (cached && cached.staleUntil > now) return { value: cached.value, freshness: metadata(cached, policy, 'stale-cache') };
    throw error;
  }
}

export function clearProviderCache(): void {
  cache.clear();
  inFlight.clear();
}
