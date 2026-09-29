export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "AUTHENTICATION_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "PROVIDER_UNAVAILABLE",
  "GENERATION_CONFLICT",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_GENERATION_FAILED",
] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export interface ApiErrorContract {
  error: string;
  code: ApiErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

const codeSet = new Set<string>(API_ERROR_CODES);

export function defaultErrorCode(status: number): ApiErrorCode {
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500 && status < 600) return status === 502 || status === 503 || status === 504 ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR";
  return "BAD_REQUEST";
}

export function normalizeApiError(payload: unknown, status: number): ApiErrorContract | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  if (typeof source.error !== "string" || source.error.trim().length === 0) return null;
  const code = typeof source.code === "string" && codeSet.has(source.code) ? source.code as ApiErrorCode : defaultErrorCode(status);
  const retryable = typeof source.retryable === "boolean" ? source.retryable : status === 409 || status === 429 || status >= 500;
  return { ...source, error: source.error, code, retryable } as ApiErrorContract;
}

export function apiErrorPayload(error: string, status: number, options: Partial<Pick<ApiErrorContract, "code" | "retryable" | "details">> = {}): ApiErrorContract {
  return {
    error,
    code: options.code ?? defaultErrorCode(status),
    retryable: options.retryable ?? (status === 409 || status === 429 || status >= 500),
    ...(options.details ? { details: options.details } : {}),
  };
}
