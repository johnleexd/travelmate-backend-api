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

export async function getExchangeRate(baseValue: string, quoteValue: string, fetcher: Fetcher = fetch, now = new Date()): Promise<ExchangeRateQuote> {
  const base = normalizeCurrency(baseValue);
  const quote = normalizeCurrency(quoteValue);
  if (base === quote) {
    const result = quoteResult(base, quote, 1, now.toISOString().slice(0, 10), now);
    return { ...result, freshness: { source: 'exchange-rates', status: 'live', isStale: false, fetchedAt: result.fetchedAt, expiresAt: result.refreshAfter, staleUntil: new Date(now.getTime() + PROVIDER_CACHE_POLICIES.exchangeRates.staleForMs).toISOString(), policy: cachePolicyLabel(PROVIDER_CACHE_POLICIES.exchangeRates) } };
  }

  const key = `${base}:${quote}`;
  const cached = await withProviderCache(key, PROVIDER_CACHE_POLICIES.exchangeRates, async () => {
    const response = await fetcher(`https://api.frankfurter.dev/v2/rate/${base.toLowerCase()}/${quote.toLowerCase()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TravelMate/1.0 reference-currency' },
      signal: AbortSignal.timeout(8_000),
    });
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
}
