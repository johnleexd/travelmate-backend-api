import {
  clearSessionCookie,
  createSessionToken,
  currentUser,
  revokeRequestSession,
  sessionFromRequest,
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
  invalidateVerificationCode,
  VerificationCooldownError,
  VerificationRateLimitError,
} from '../services/auth/auth-service.ts';
import {
  resolveEmailProvider,
  emailConfigurationIssues,
  emailDeliveryDiagnostic,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../services/email/email-provider.ts';
import { EmailExistsError } from '../exceptions/index.ts';
import {
  isStrongPassword,
  getPasswordValidationError,
  STRONG_PASSWORD_REQUIREMENTS,
} from '../schemas/auth/password-schema.ts';
import { createHash } from 'node:crypto';
import { clearOAuthFlowCookie } from '../services/auth/google-oauth-service.ts';
import { apiErrorPayload } from '../contracts/api-error.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const accountActions = new Set(['login', 'register', 'verify-email', 'resend-verification', 'forgot-password', 'reset-password', 'logout']);
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
function emailUnavailable(request: Request, action: string): Response {
  const missingVariables = emailConfigurationIssues();
  console.warn(JSON.stringify({ event: 'auth_dependency_unavailable', action, operation: 'email_configuration',
    dependency: 'email', requestId: request.headers.get('x-request-id'), missingVariables }));
  const development = process.env.NODE_ENV !== 'production';
  const emailKind = action === 'forgot-password' ? 'password reset' : 'verification';
  return Response.json(apiErrorPayload(development
    ? `Email delivery is not configured. ${process.env.EMAIL_PROVIDER?.trim().toLowerCase() === 'gmail' ? 'For development Gmail delivery, set EMAIL_PROVIDER=gmail, SMTP_USER, SMTP_PASS (a Google App Password), and EMAIL_FROM matching SMTP_USER' : 'Set EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM on your own Resend-verified domain, or use the documented development EMAIL_PROVIDER=gmail option' } in backend .env, then restart the API. No ${emailKind} email was sent.`
    : `Account email delivery is unavailable. Contact support; no ${emailKind} email was sent.`, 503, {
    retryable: false,
    details: { dependency: 'email', reason: 'configuration_required', ...(development ? { missingVariables } : {}) },
  }), { status: 503 });
}

export async function GET(request: Request) {
  const user = await currentUser(request, undefined, true);
  return user ? Response.json({ user }) : fail('Unauthenticated.', 401);
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-client-ip') || 'local';
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');
  async function databaseOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (isDatabaseConnectionError(error)) {
        console.warn(JSON.stringify({ event: 'auth_dependency_unavailable', action: accountActions.has(action) ? action : 'unknown',
          operation, dependency: 'database', requestId: request.headers.get('x-request-id') }));
      }
      throw error;
    }
  }
  if (action === 'logout') {
    const session = sessionFromRequest(request);
    let sessionRevoked = true;
    if (session) {
      try { await revokeRequestSession(request); }
      catch {
        sessionRevoked = false;
        console.warn('[TravelMate] Local sign-out completed; server session revocation could not be confirmed.');
      }
      try {
        if (await allowRequest(`auth:ip:${ip}`, 20, 60_000)) await recordAuthAudit(session.userId, 'logout');
      } catch {
        // Logout auditing is best effort, as it is for other authentication actions.
      }
    }
    const headers = new Headers();
    headers.append('Set-Cookie', clearSessionCookie());
    headers.append('Set-Cookie', clearOAuthFlowCookie());
    return Response.json({ ok: true, sessionRevoked }, { headers });
  }
  if (!await databaseOperation('rate_limit_ip', () => allowRequest(`auth:ip:${ip}`, 20, 60_000))) return fail('Too many attempts. Try again shortly.', 429);
  const normalizedEmail = String(body.email || '').trim().toLowerCase();
  const accountLimits: Record<string, { limit: number; windowMs: number }> = {
    login: { limit: 8, windowMs: 15 * 60_000 }, register: { limit: 4, windowMs: 60 * 60_000 },
    'verify-email': { limit: 8, windowMs: 15 * 60_000 },
    'forgot-password': { limit: 3, windowMs: 60 * 60_000 }, 'reset-password': { limit: 6, windowMs: 15 * 60_000 },
  };
  const accountLimit = accountLimits[action];
  if (accountLimit && normalizedEmail) {
    const emailKey = createHash('sha256').update(normalizedEmail).digest('hex');
    if (!await databaseOperation('rate_limit_account', () => allowRequest(`auth:${action}:email:${emailKey}`, accountLimit.limit, accountLimit.windowMs))) return fail('Too many attempts for this account. Try again later.', 429);
  }

  if (action === 'login') {
    const email = String(body.email || '').trim().toLowerCase();
    const authenticated = await databaseOperation('authenticate_user', () => authenticateUser(email, String(body.password || '')));
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
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const rawPassword = String(body.password || '');
    const role: Role = 'traveler';
    if (name.length < 2) return fail('Full name must contain at least 2 characters.');
    if (!emailPattern.test(email)) return fail('Email address must be valid.');
    if (!isStrongPassword(rawPassword)) return fail(getPasswordValidationError(rawPassword) || STRONG_PASSWORD_REQUIREMENTS);
    if (body.confirmPassword !== undefined && body.confirmPassword !== rawPassword) return fail('Confirm password does not match Password.');
    if (!resolveEmailProvider()) return emailUnavailable(request, action);
    const verificationCode = generateAccountCode();
    const user = await databaseOperation('register_user', () => registerUser({ name, email, rawPassword, role, verificationCode }))
      .catch((error: unknown) => error instanceof EmailExistsError ? null : Promise.reject(error));
    if (!user) return fail('An account with that email already exists.', 409);
    await recordAuthAudit(user.id, 'register').catch(() => undefined);
    try {
      if (!await sendVerificationEmail(user.email, user.name, verificationCode)) throw new Error('Email unavailable');
    } catch (error) {
      console.warn(JSON.stringify({ event: 'auth_email_failed', action, requestId: request.headers.get('x-request-id'), ...emailDeliveryDiagnostic(error) }));
      await invalidateVerificationCode(user.id, verificationCode);
      return Response.json(apiErrorPayload('Account created, but the email provider did not confirm sending the verification email. Use resend verification after 60 seconds; if this persists, contact support to check the email provider credentials and sender configuration.', 502,
        { retryable: emailDeliveryDiagnostic(error).retryable, details: { accountCreated: true, dependency: 'email', reason: emailDeliveryDiagnostic(error).reason } }), { status: 502 });
    }
    return Response.json({ user, emailAccepted: true, message: 'Account created. The email provider accepted your verification email. Check your inbox and Spam folder; the code expires in 5 minutes.' }, { status: 201 });
  }

  if (action === 'verify-email') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const user = await databaseOperation('verify_email', () => verifyEmail(email, code));
    if (user) await recordAuthAudit(user.id, 'verify-email').catch(() => undefined);
    return user ? Response.json({ user, message: 'Email verified. You can now sign in.' }) : fail('Invalid, expired, or exhausted verification code. Request a new code if needed.', 400);
  }

  if (action === 'resend-verification') {
    if (!resolveEmailProvider()) return emailUnavailable(request, action);
    const email = String(body.email || '').trim().toLowerCase();
    if (!emailPattern.test(email)) return fail('Use a valid email address.');
    const verificationCode = generateAccountCode();
    let user;
    try { user = await databaseOperation('reissue_verification', () => reissueVerificationCode(email, verificationCode)); }
    catch (error) {
      if (error instanceof VerificationCooldownError || error instanceof VerificationRateLimitError) {
        return Response.json({ error: error.message }, { status: 429, headers: { 'Retry-After': error instanceof VerificationCooldownError ? '60' : '3600' } });
      }
      throw error;
    }
    if (user) {
      try {
        if (!await sendVerificationEmail(user.email, user.name, verificationCode)) throw new Error('Email unavailable');
      } catch (error) {
        console.warn(JSON.stringify({ event: 'auth_email_failed', action, requestId: request.headers.get('x-request-id'), ...emailDeliveryDiagnostic(error) }));
        await invalidateVerificationCode(user.id, verificationCode);
        return Response.json(apiErrorPayload('The email provider did not confirm sending the verification email. Wait 60 seconds before resending; if this persists, contact support to check the email provider credentials and sender configuration.', 502,
          { retryable: emailDeliveryDiagnostic(error).retryable, details: { dependency: 'email', reason: emailDeliveryDiagnostic(error).reason } }), { status: 502 });
      }
    }
    if (!user) {
      console.info(JSON.stringify({ event: 'auth_email_not_sent', action, reason: 'account_not_eligible', requestId: request.headers.get('x-request-id') }));
      return Response.json({ emailAccepted: false, message: 'No new verification email was sent. If your email is already verified, sign in. Otherwise, check the email address used during registration.' });
    }
    return Response.json({ emailAccepted: true, message: 'The email provider accepted a new verification email for your registered address. Check your inbox and Spam folder; the code expires in 5 minutes.' });
  }

  if (action === 'forgot-password') {
    if (!resolveEmailProvider()) return emailUnavailable(request, action);
    const email = String(body.email || '').trim().toLowerCase();
    if (!emailPattern.test(email)) return fail('Use a valid email address.');
    const resetCode = generateAccountCode();
    const user = await databaseOperation('issue_password_reset', () => issuePasswordResetCode(email, resetCode));
    if (user) {
      try {
        if (!await sendPasswordResetEmail(user.email, user.name, resetCode)) throw new Error('Email unavailable');
      } catch {
        console.warn('[TravelMate] Password reset email delivery failed.');
        return fail('Password reset email was not sent. Please try again later.', 502);
      }
    }
    return Response.json({ message: 'If an active verified account uses that email, a password reset code has been sent to it.' });
  }

  if (action === 'reset-password') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const rawPassword = String(body.password || '');
    if (!emailPattern.test(email) || !code) return fail('Email and reset code are required.');
    if (!isStrongPassword(rawPassword)) return fail(getPasswordValidationError(rawPassword) || STRONG_PASSWORD_REQUIREMENTS);
    if (body.confirmPassword !== undefined && body.confirmPassword !== rawPassword) return fail('Confirm password does not match Password.');
    const reset = await databaseOperation('reset_password', () => resetPassword(email, code, rawPassword));
    return reset
      ? Response.json({ message: 'Password reset complete. Sign in with your new password.' }, { headers: { 'Set-Cookie': clearSessionCookie() } })
      : fail('Invalid or expired password reset code.', 400);
  }

  return fail('Unknown authentication action.');
}
