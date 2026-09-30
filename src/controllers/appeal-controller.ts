import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { prisma } from '../lib/prisma.ts';
import { submitAppeal } from '../services/platform/appeal-service.ts';
import { PlatformActionError } from '../exceptions/index.ts';

export async function GET(request: Request) {
  const user = await currentUser(request, 'traveler', true);
  if (!user) return Response.json({ error: 'Sign in to view your appeal.' }, { status: 401 });
  const [appeals, notifications] = await Promise.all([
    prisma.moderation.findMany({ where: { kind: 'appeal', subjectId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  return Response.json({ user, appeals, notifications });
}

export async function POST(request: Request) {
  const user = await currentUser(request, 'traveler', true);
  if (!user) return Response.json({ error: 'Sign in to submit your appeal.' }, { status: 401 });
  if (!await allowRequest(`appeal:${user.id}`, 3, 60 * 60_000)) return Response.json({ error: 'Too many appeal attempts. Try again in one hour.' }, { status: 429 });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new PlatformActionError('Enter your appeal message.');
    return Response.json({ result: await submitAppeal(user, body) });
  } catch (error) {
    if (error instanceof PlatformActionError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 });
    console.error('[TravelMate] Appeal submission failed:', error);
    return Response.json({ error: 'Could not submit your appeal. Please try again.' }, { status: 500 });
  }
}
