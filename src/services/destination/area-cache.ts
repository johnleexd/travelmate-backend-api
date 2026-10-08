const DAY = 24 * 60 * 60_000;
export function createAreaCache<T>(limit = 100, ttl = DAY) {
  const entries = new Map<string, { value?: T; error?: Error; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        if (hit.error) throw hit.error;
        return hit.value!;
      }
      const shared = pending.get(key); if (shared) return shared;
      const task = load().then(value => { entries.set(key, { value, expiresAt: Date.now() + ttl }); return value; }, cause => {
        const error = cause instanceof Error ? cause : new Error('Area provider is unavailable.');
        entries.set(key, { error, expiresAt: Date.now() + 60_000 }); throw error;
      }).finally(() => { pending.delete(key); while (entries.size > limit) entries.delete(entries.keys().next().value!); });
      pending.set(key, task); return task;
    },
    clear() { entries.clear(); pending.clear(); },
  };
}
