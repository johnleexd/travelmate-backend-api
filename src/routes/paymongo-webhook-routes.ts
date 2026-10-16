import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw } from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { testCheckoutConfiguration } from '../services/plans/paymongo-test-provider.ts';
import { processTestPaymentEvent } from '../services/plans/test-checkout-service.ts';
import { PlanError } from '../services/plans/plan-error.ts';

export function verifyPaymongoTestSignature(body: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map(part => part.trim().split('='));
  if (parts.some(part => part.length !== 2) || new Set(parts.map(([name]) => name)).size !== parts.length) return false;
  const fields = Object.fromEntries(parts);
  if (!/^\d{10,12}$/.test(fields.t ?? '') || !/^[a-f0-9]{64}$/i.test(fields.te ?? '')) return false;
  if (Math.abs(now / 1000 - Number(fields.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(fields.t + '.').update(body).digest();
  return timingSafeEqual(expected, Buffer.from(fields.te, 'hex'));
}

const eventSchema = z.object({ data: z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{1,100}$/),
  type: z.literal('event'),
  attributes: z.object({ type: z.string().regex(/^[a-z0-9_.]{1,100}$/), livemode: z.literal(false), data: z.unknown().optional() }),
}) });

const router = Router();
router.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  // This receiver is deliberately unavailable in production or with a live key.
  if (process.env.NODE_ENV === 'production' || !process.env.PAYMONGO_SECRET_KEY?.trim().startsWith('sk_test_') || !process.env.PAYMONGO_WEBHOOK_SECRET?.trim()) {
    response.status(503).json({ error: 'PayMongo test webhook is not configured.' });
    return;
  }
  next();
});
router.post('/', raw({ type: 'application/json', limit: '128kb', inflate: false }), async (request, response) => {
  if (!request.is('application/json')) { response.status(415).json({ error: 'JSON is required.' }); return; }
  if (!Buffer.isBuffer(request.body) || !verifyPaymongoTestSignature(request.body, request.get('Paymongo-Signature'), process.env.PAYMONGO_WEBHOOK_SECRET!.trim())) {
    response.status(401).json({ error: 'Invalid webhook signature.' }); return;
  }
  let payload: unknown;
  try { payload = JSON.parse(request.body.toString('utf8')); }
  catch { response.status(400).json({ error: 'Invalid webhook JSON.' }); return; }
  const event = eventSchema.safeParse(payload);
  if (!event.success) { response.status(400).json({ error: 'A valid test-mode event is required.' }); return; }
  const { id, attributes } = event.data.data;
  try {
    // Connectivity payloads cannot grant Plus: supported IDs must resolve to a
    // real test payment/session and match a persisted order via provider reads.
    const action = testCheckoutConfiguration().enabled ? await processTestPaymentEvent(attributes.type, attributes.data) : 'acknowledged_only';
    console.info(JSON.stringify({ event: 'paymongo_test_webhook_received', eventId: id, eventType: attributes.type, mode: 'test', action }));
    response.status(200).json({ received: true, mode: 'test', action });
  } catch (error) {
    if (error instanceof PlanError && error.code === 'CONFLICT') {
      console.warn(JSON.stringify({ event: 'paymongo_test_payment_mismatch', eventId: id }));
      response.status(200).json({ received: true, mode: 'test', action: 'rejected_mismatch' }); return;
    }
    console.warn(JSON.stringify({ event: 'paymongo_test_verification_unavailable', eventId: id }));
    response.status(503).json({ error: 'Test payment verification is temporarily unavailable. Please retry delivery.' });
  }
});
router.all('/', (_request, response) => { response.setHeader('Allow', 'POST'); response.status(405).json({ error: 'Use POST.' }); });
const bodyError: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = error?.type === 'entity.too.large' ? 413 : error?.status === 415 ? 415 : 400;
  response.status(status).json({ error: 'Webhook body must be uncompressed JSON of at most 128 KB.' });
};
router.use(bodyError);

export default router;
