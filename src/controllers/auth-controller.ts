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
  generateAccountCode,
  issuePasswordResetCode,
  registerUser,
  recordAuthAudit,
  reissueVerificationCode,
  resetPassword,
  verifyEmail,
} from '../services/auth/auth-service.ts';
import {
  resolveEmailProvider,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../services/email/email-provider.ts';
import { EmailExistsError } from '../exceptions/index.ts';
import {
  isStrongPassword,
  STRONG_PASSWORD_REQUIREMENTS,
} from '../schemas/auth/password-schema.ts';
import { createHash } from 'node:crypto';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function GET(request: Request) {
  const user = await currentUser(request, undefined, true);
  return user ? Response.json({ user }) : fail('Unauthenticated.', 401);
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-client-ip') || 'local';
  if (!await allowRequest(`auth:ip:${ip}`, 20, 60_000)) return fail('Too many attempts. Try again shortly.', 429);
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');
  const normalizedEmail = String(body.email || '').trim().toLowerCase();
  const accountLimits: Record<string, { limit: number; windowMs: number }> = {
    login: { limit: 8, windowMs: 15 * 60_000 }, register: { limit: 4, windowMs: 60 * 60_000 },
    'verify-email': { limit: 8, windowMs: 15 * 60_000 }, 'resend-verification': { limit: 3, windowMs: 60 * 60_000 },
    'forgot-password': { limit: 3, windowMs: 60 * 60_000 }, 'reset-password': { limit: 6, windowMs: 15 * 60_000 },
  };
  const accountLimit = accountLimits[action];
  if (accountLimit && normalizedEmail) {
    const emailKey = createHash('sha256').update(normalizedEmail).digest('hex');
    if (!await allowRequest(`auth:${action}:email:${emailKey}`, accountLimit.limit, accountLimit.windowMs)) return fail('Too many attempts for this account. Try again later.', 429);
  }

  if (action === 'logout') {
    const user = await currentUser(request);
    if (user) await recordAuthAudit(user.id, 'logout').catch(() => undefined);
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
  }

  if (action === 'login') {
    const email = String(body.email || '').trim().toLowerCase();
    const authenticated = await authenticateUser(email, String(body.password || ''));
    if (!authenticated) return fail('Invalid email or password.', 401);
    if (!authenticated.emailVerified) return fail('Verify your email before signing in.', 403);
    const { sessionVersion, ...user } = authenticated;
    await recordAuthAudit(user.id, 'login').catch(() => undefined);
    return Response.json(
      { user, redirect: user.accountStatus === 'suspended' ? '/account/appeal' : user.role === 'admin' ? '/admin/dashboard' : '/dashboard' },
      { headers: { 'Set-Cookie': sessionCookie(createSessionToken(user.id, user.role, sessionVersion)) } },
    );
  }

  if (action === 'register') {
    const production = process.env.NODE_ENV === 'production';
    if (production && !resolveEmailProvider()) return fail('Account email delivery is temporarily unavailable.', 503);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const rawPassword = String(body.password || '');
    const role: Role = 'traveler';
    if (name.length < 2 || !emailPattern.test(email)) return fail('Use a valid name and email address.');
    if (!isStrongPassword(rawPassword)) return fail(STRONG_PASSWORD_REQUIREMENTS);
    const verificationCode = generateAccountCode();
    const user = await registerUser({ name, email, rawPassword, role, verificationCode })
      .catch((error: unknown) => error instanceof EmailExistsError ? null : Promise.reject(error));
    if (!user) return fail('An account with that email already exists.', 409);
    await recordAuthAudit(user.id, 'register').catch(() => undefined);
    let delivered = false;
    try { delivered = await sendVerificationEmail(email, name, verificationCode); }
    catch (error) { console.error('[TravelMate] Verification email delivery failed:', error instanceof Error ? error.message : error); }
    const message = delivered
      ? 'Account created. Check your email for the verification code.'
      : production
        ? 'Account created, but the verification email could not be delivered. Use resend verification to try again.'
        : 'Account created. Email delivery is not configured, so use the development activation code shown in this form.';
    return Response.json({ user, ...(!production ? { verificationCode } : {}), message }, { status: 201 });
  }

  if (action === 'verify-email') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const user = await verifyEmail(email, code);
    if (user) await recordAuthAudit(user.id, 'verify-email').catch(() => undefined);
    return user ? Response.json({ user, message: 'Email verified. You can now sign in.' }) : fail('Invalid verification code.', 400);
  }

  if (action === 'resend-verification') {
    const production = process.env.NODE_ENV === 'production';
    if (production && !resolveEmailProvider()) return fail('Account email delivery is temporarily unavailable.', 503);
    const email = String(body.email || '').trim().toLowerCase();
    if (!emailPattern.test(email)) return fail('Use a valid email address.');
    const verificationCode = generateAccountCode();
    const user = await reissueVerificationCode(email, verificationCode);
    if (user) {
      try { await sendVerificationEmail(user.email, user.name, verificationCode); }
      catch (error) {
        console.error('[TravelMate] Verification email resend failed:', error instanceof Error ? error.message : error);
        if (production) return fail('Verification email could not be delivered. Try again shortly.', 502);
      }
    }
    return Response.json({ ...(!production && user ? { verificationCode } : {}), message: 'If the account still needs verification, a new code has been issued.' });
  }

  if (action === 'forgot-password') {
    const production = process.env.NODE_ENV === 'production';
    if (production && !resolveEmailProvider()) return fail('Account email delivery is temporarily unavailable.', 503);
    const email = String(body.email || '').trim().toLowerCase();
    if (!emailPattern.test(email)) return fail('Use a valid email address.');
    const resetCode = generateAccountCode();
    const user = await issuePasswordResetCode(email, resetCode);
    if (user) {
      try { await sendPasswordResetEmail(user.email, user.name, resetCode); }
      catch (error) { console.error('[TravelMate] Password reset email delivery failed:', error instanceof Error ? error.message : error); }
    }
    return Response.json({ ...(!production && user ? { resetCode } : {}), message: 'If an active verified account uses that email, a password reset code has been issued.' });
  }

  if (action === 'reset-password') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const rawPassword = String(body.password || '');
    if (!emailPattern.test(email) || !code) return fail('Email and reset code are required.');
    if (!isStrongPassword(rawPassword)) return fail(STRONG_PASSWORD_REQUIREMENTS);
    const reset = await resetPassword(email, code, rawPassword);
    return reset
      ? Response.json({ message: 'Password reset complete. Sign in with your new password.' }, { headers: { 'Set-Cookie': clearSessionCookie() } })
      : fail('Invalid or expired password reset code.', 400);
  }

  return fail('Unknown authentication action.');
}
