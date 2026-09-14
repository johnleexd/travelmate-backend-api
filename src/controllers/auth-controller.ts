import { randomBytes } from 'node:crypto';
import {
  clearSessionCookie,
  createSessionToken,
  currentUser,
  sessionCookie,
} from '../middlewares/auth-middleware.ts';
import type { Role } from '../schemas/domain.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import {
  authenticateUser,
  registerUser,
  verifyEmail,
} from '../services/auth/auth-service.ts';
import { EmailExistsError } from '../exceptions/index.ts';
import {
  isStrongPassword,
  STRONG_PASSWORD_REQUIREMENTS,
} from '../schemas/auth/password-schema.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function GET(request: Request) {
  const user = await currentUser(request);
  return user ? Response.json({ user }) : fail('Unauthenticated.', 401);
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-client-ip') || 'local';
  if (!allowRequest(`auth:${ip}`, 12, 60_000)) return fail('Too many attempts. Try again shortly.', 429);
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');

  if (action === 'logout') {
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
  }

  if (action === 'login') {
    const email = String(body.email || '').trim().toLowerCase();
    const user = await authenticateUser(email, String(body.password || ''));
    if (!user) return fail('Invalid email or password.', 401);
    if (user.accountStatus === 'suspended') return fail('This account is suspended. Contact TravelMate support.', 403);
    if (!user.emailVerified) return fail('Verify your email before signing in.', 403);
    return Response.json(
      { user, redirect: user.role === 'admin' ? '/admin/dashboard' : user.role === 'owner' ? '/owner/dashboard' : '/dashboard' },
      { headers: { 'Set-Cookie': sessionCookie(createSessionToken(user.id, user.role)) } },
    );
  }

  if (action === 'register') {
    if (process.env.NODE_ENV === 'production') return fail('Registration is unavailable until transactional email delivery is configured.', 503);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const rawPassword = String(body.password || '');
    const role: Role = body.role === 'owner' ? 'owner' : 'traveler';
    if (name.length < 2 || !emailPattern.test(email)) return fail('Use a valid name and email address.');
    if (!isStrongPassword(rawPassword)) return fail(STRONG_PASSWORD_REQUIREMENTS);
    const verificationCode = randomBytes(3).toString('hex').toUpperCase();
    const user = await registerUser({ name, email, rawPassword, role, verificationCode })
      .catch((error: unknown) => error instanceof EmailExistsError ? null : Promise.reject(error));
    if (!user) return fail('An account with that email already exists.', 409);
    return Response.json({ user, verificationCode, message: 'Account created. Email delivery is not configured, so use the development activation code shown in this form.' }, { status: 201 });
  }

  if (action === 'verify-email') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const user = await verifyEmail(email, code);
    return user ? Response.json({ user, message: 'Email verified. You can now sign in.' }) : fail('Invalid verification code.', 400);
  }

  if (action === 'forgot-password') return Response.json({ message: 'Password recovery email is not configured yet. Contact the TravelMate administrator for account recovery.' });
  return fail('Unknown authentication action.');
}
