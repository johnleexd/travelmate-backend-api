import type { CachePolicy } from './provider-cache.ts';

const minute = 60_000;
const hour = 60 * minute;

export const PROVIDER_CACHE_POLICIES = {
  flights: { source: 'flights', freshForMs: 5 * minute, staleForMs: 15 * minute },
  hotels: { source: 'hotels', freshForMs: 5 * minute, staleForMs: 15 * minute },
  activities: { source: 'activities', freshForMs: 30 * minute, staleForMs: 2 * hour },
  weather: { source: 'weather', freshForMs: 15 * minute, staleForMs: hour },
  exchangeRates: { source: 'exchange-rates', freshForMs: 6 * hour, staleForMs: 24 * hour },
} satisfies Record<string, CachePolicy>;
