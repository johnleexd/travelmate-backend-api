/** Serialized, authenticated plan/operation responses; never browser entitlements. */
export interface PlanUsage {
  plan: 'Free' | 'Plus'; status: 'free' | 'active' | 'expired'; source: 'verified_payment' | 'admin_demo' | 'paymongo_test' | null;
  expiresAt: string | null; used: number; reserved: number; remaining: number; allowance: number;
  periodStart: string; resetsAt: string; timezone: string; trackingStartedAt: string;
  plans: { free: number; plus: number }; provisional: boolean; checkoutAvailable: boolean; pricing: string;
  testCheckout?: { amount: number; currency: 'PHP'; durationDays: number };
  inProgress: { id: string; idempotencyKey: string; reservedUntil: string | null; allowancePeriod: string | null } | null;
  recentOperations: { id: string; idempotencyKey: string; destination: string; allowanceState: string | null; charged: boolean; createdAt: string; operationKind: string; relatedTripId: string | null }[];
}
export interface PlanCheckout {
  id: string; status: string; amount: number; currency: string; durationDays: number;
  checkoutUrl: string | null; lastError: string | null; fulfilledAt: string | null; mode: 'test';
}
export interface GenerationOperation<T = unknown> {
  id: string; key: string; state: string; status: 'pending' | 'completed' | 'failed'; kind: string; tripId: string | null;
  charged: boolean; result: T | null; errorCode: string | null;
}
