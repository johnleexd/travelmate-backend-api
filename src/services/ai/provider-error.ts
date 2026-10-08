export class AIProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, status: number, detail: string, code: string, retryAfter: string | null) {
    super(`${provider} request failed (${status})${detail ? `: ${detail}` : '.'}`);
    this.status = status;
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const date = retryAfter === null ? NaN : Date.parse(retryAfter);
    this.retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
    const permanent = /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit|billing/i.test(code);
    this.retryable = !permanent && (status === 408 || status >= 500
      || (status === 429 && this.retryAfterMs !== undefined));
  }
}

export async function providerResponseError(provider: string, response: Response, apiKey: string): Promise<AIProviderError> {
  let detail = '';
  let code = '';
  try {
    const payload = await response.json() as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    if (typeof payload.error?.message === 'string') detail = payload.error.message.replaceAll(apiKey, '[redacted]').trim().slice(0, 500);
    code = `${payload.error?.code || ''} ${payload.error?.type || ''}`;
  } catch { /* Preserve status when the provider returns a non-JSON error. */ }
  // Authentication messages can echo only part of a key, bypassing exact redaction.
  if (response.status === 401) detail = 'Authentication failed. Check the configured API key.';
  return new AIProviderError(provider, response.status, detail, code, response.headers.get('retry-after'));
}
