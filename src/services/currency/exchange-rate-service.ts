import { normalizeCurrency, type CurrencyCode } from '../../schemas/domain.ts';
import { PROVIDER_CACHE_POLICIES } from '../cache/policies.ts';
import { cachePolicyLabel, clearProviderCache, withProviderCache, type FreshnessMetadata } from '../cache/provider-cache.ts';

export interface ExchangeRateQuote {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  asOf: string;
  fetchedAt: string;
  refreshAfter: string;
  source: 'frankfurter';
  sourceUrl: 'https://frankfurter.dev/';
  disclaimer: string;
  freshness: FreshnessMetadata;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ExchangeRateProviderRateLimit extends Error {
  readonly retryAt: number;
  constructor(retryAt: number) {
    super('Exchange-rate provider is rate limited.');
    this.retryAt = retryAt;
  }
}
const providerCooldowns = new Map<string, ExchangeRateProviderRateLimit>();

function providerRetryAt(value: string | null, now: number): number {
  if (value && /^\d+$/.test(value.trim())) return now + Math.max(1_000, Number(value) * 1_000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > now ? date : now + 60_000;
}

function quoteResult(base: CurrencyCode, quote: CurrencyCode, rate: number, asOf: string, now: Date): Omit<ExchangeRateQuote, 'freshness'> {
  return {
    base,
    quote,
    rate,
    asOf,
    fetchedAt: now.toISOString(),
    refreshAfter: new Date(now.getTime() + PROVIDER_CACHE_POLICIES.exchangeRates.freshForMs).toISOString(),
    source: 'frankfurter',
    sourceUrl: 'https://frankfurter.dev/',
    disclaimer: 'Reference mid-market conversion only. Card, cash, and provider exchange rates may differ.',
  };
}

export async function getExchangeRate(baseValue: string, quoteValue: string, fetcher: Fetcher = fetch, nowValue?: Date): Promise<ExchangeRateQuote> {
  const now = nowValue ?? new Date();
  const base = normalizeCurrency(baseValue);
  const quote = normalizeCurrency(quoteValue);
  if (base === quote) {
    const result = quoteResult(base, quote, 1, now.toISOString().slice(0, 10), now);
    return { ...result, freshness: { source: 'exchange-rates', status: 'live', isStale: false, fetchedAt: result.fetchedAt, expiresAt: result.refreshAfter, staleUntil: new Date(now.getTime() + PROVIDER_CACHE_POLICIES.exchangeRates.staleForMs).toISOString(), policy: cachePolicyLabel(PROVIDER_CACHE_POLICIES.exchangeRates) } };
  }

  const key = `${base}:${quote}`;
  const cached = await withProviderCache(key, PROVIDER_CACHE_POLICIES.exchangeRates, async () => {
    const cooldown = providerCooldowns.get(key);
    if (cooldown && cooldown.retryAt > now.getTime()) throw cooldown;
    providerCooldowns.delete(key);
    const response = await fetcher(`https://api.frankfurter.dev/v2/rate/${base.toLowerCase()}/${quote.toLowerCase()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TravelMate/1.0 reference-currency' },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 429) {
      // Seconds are measured from receipt, not before the provider's network
      // latency. An explicit clock keeps historical cache tests deterministic.
      const error = new ExchangeRateProviderRateLimit(providerRetryAt(response.headers.get('Retry-After'), nowValue?.getTime() ?? Date.now()));
      providerCooldowns.set(key, error);
      if (providerCooldowns.size > 400) providerCooldowns.delete(providerCooldowns.keys().next().value!);
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok) throw new Error(`Exchange-rate provider returned ${response.status}.`);
    const payload = await response.json() as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown };
    const rate = Number(payload.rate);
    if (payload.base !== base || payload.quote !== quote || typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !Number.isFinite(rate) || rate <= 0) throw new Error('Exchange-rate provider returned invalid data.');
    return quoteResult(base, quote, rate, payload.date, now);
  }, now.getTime());
  return { ...cached.value, freshness: cached.freshness };
}

export function clearExchangeRateCache(): void {
  clearProviderCache();
  providerCooldowns.clear();
}
