import { z } from 'zod';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { planFailure } from './plan-controller.ts';
import { PlanError } from '../services/plans/plan-error.ts';
import { PaymongoTestError, testCheckoutConfiguration } from '../services/plans/paymongo-test-provider.ts';
import { createTestCheckout, latestTestCheckout, verifyTestCheckout, cancelTestCheckout } from '../services/plans/test-checkout-service.ts';

function failure(error: unknown) {
  if (error instanceof PaymongoTestError) return Response.json({ error: error.message, code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  return planFailure(error);
}
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'private, no-store' } });
export async function GET_CHECKOUT(request: Request) {
  try { const user = await requireUser(request, 'traveler'); return json({ order: testCheckoutConfiguration().enabled ? await latestTestCheckout(user.id) : null }); }
  catch (error) { return failure(error); }
}
export async function POST_CHECKOUT(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest('plan-test-checkout:' + user.id, 6, 60000)) throw new PlanError('Too many checkout requests. Try again shortly.', 429, 'RATE_LIMITED');
    if (!z.object({}).strict().safeParse(await request.json()).success) throw new PlanError('Checkout amount, currency, plan and user are controlled by the server.', 400, 'BAD_REQUEST');
    return json({ order: await createTestCheckout(user.id, request.headers.get('Idempotency-Key') || '') });
  } catch (error) { return failure(error); }
}
export async function POST_CHECKOUT_ACTION(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    if (!await allowRequest('plan-test-checkout-check:' + user.id, 25, 60000)) throw new PlanError('Please wait before checking payment again.', 429, 'RATE_LIMITED');
    const path = new URL(request.url).pathname.split('/'), action = path.at(-1), id = path.at(-2) || '';
    if (!z.string().uuid().safeParse(id).success || !['verify', 'cancel'].includes(action || '') || !z.object({}).strict().safeParse(await request.json()).success) throw new PlanError('Invalid checkout request.', 400, 'BAD_REQUEST');
    return json({ order: await (action === 'cancel' ? cancelTestCheckout(user.id, id) : verifyTestCheckout(user.id, id)) });
  } catch (error) { return failure(error); }
}
