import { requireUser } from '../middlewares/auth-middleware.ts';
import { getPlan, readGeneration, PlanError } from '../services/plans/plan-service.ts';

export function planFailure(error: unknown): Response {
  if (error instanceof PlanError) return Response.json({ error: error.message, code: error.code, retryable: false, details: error.details }, { status: error.status });
  if (error instanceof Error && error.message === 'UNAUTHORIZED') return Response.json({ error: 'Authentication required.' }, { status: 401 });
  throw error;
}
export async function GET_PLAN(request: Request) {
  try { const user = await requireUser(request, 'traveler'); return Response.json(await getPlan(user.id), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return planFailure(error); }
}
export async function GET_OPERATION(request: Request) {
  try {
    const user = await requireUser(request, 'traveler');
    const key = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) || '');
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new PlanError('Invalid operation key.', 400, 'BAD_REQUEST');
    return Response.json(await readGeneration(user.id, key), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return planFailure(error); }
}
