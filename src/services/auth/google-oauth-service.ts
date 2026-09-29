import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { prisma } from '../../lib/prisma.ts';
import { publicUser, type PublicUser } from '../../schemas/domain.ts';

const FLOW_COOKIE = 'travelmate_google_oauth';
const FLOW_LIFETIME_SECONDS = 10 * 60;

export class OAuthConfigurationError extends Error {}
export class OAuthAccountLinkRequiredError extends Error {}

export interface GoogleOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
}

interface OAuthFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  name: string;
  authoritativeEmail: boolean;
}

export function readGoogleOAuthConfiguration(environment: NodeJS.ProcessEnv = process.env): GoogleOAuthConfiguration {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim() || '';
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim() || '';
  const redirectUri = environment.GOOGLE_OAUTH_REDIRECT_URI?.trim() || '';
  const stateSecret = environment.OAUTH_STATE_SECRET?.trim() || '';
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret || !redirectUri || stateSecret.length < 32
    || [clientId, clientSecret, stateSecret].some((value) => /^(your_|replace_with_|changeme|example)/i.test(value))) {
    throw new OAuthConfigurationError('Google sign-in is not configured.');
  }
  let parsedRedirect: URL;
  try { parsedRedirect = new URL(redirectUri); }
  catch { throw new OAuthConfigurationError('Google OAuth redirect URI is invalid.'); }
  if (!['http:', 'https:'].includes(parsedRedirect.protocol)) throw new OAuthConfigurationError('Google OAuth redirect URI is invalid.');
  return { clientId, clientSecret, redirectUri, stateSecret };
}

export function googleOAuthClient(configuration: GoogleOAuthConfiguration): OAuth2Client {
  return new OAuth2Client(configuration.clientId, configuration.clientSecret, configuration.redirectUri);
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function sealOAuthFlow(flow: OAuthFlowState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function unsealOAuthFlow(value: string | undefined, secret: string, now = Date.now()): OAuthFlowState | null {
  if (!value) return null;
  const [payload, suppliedSignature] = value.split('.');
  if (!payload || !suppliedSignature) return null;
  const expectedSignature = signature(payload, secret);
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<OAuthFlowState>;
    return typeof flow.state === 'string' && flow.state.length >= 32
      && typeof flow.nonce === 'string' && flow.nonce.length >= 32
      && typeof flow.codeVerifier === 'string' && flow.codeVerifier.length >= 43
      && typeof flow.expiresAt === 'number' && flow.expiresAt > now
      ? flow as OAuthFlowState : null;
  } catch {
    return null;
  }
}

export async function createGoogleAuthorization(): Promise<{ authorizationUrl: string; flowCookie: string }> {
  const configuration = readGoogleOAuthConfiguration();
  const client = googleOAuthClient(configuration);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  if (!codeChallenge) throw new Error('Google OAuth PKCE generation failed.');
  const flow: OAuthFlowState = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier,
    expiresAt: Date.now() + FLOW_LIFETIME_SECONDS * 1000,
  };
  return {
    authorizationUrl: client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      prompt: 'select_account',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    }),
    flowCookie: oauthFlowCookie(sealOAuthFlow(flow, configuration.stateSecret)),
  };
}

export function oauthFlowCookie(value: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${FLOW_COOKIE}=${value}; Path=/api/auth/oauth/google; HttpOnly; SameSite=Lax; Max-Age=${FLOW_LIFETIME_SECONDS}${secure}`;
}

export function clearOAuthFlowCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${FLOW_COOKIE}=; Path=/api/auth/oauth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function oauthFlowFromRequest(request: Request, secret: string): OAuthFlowState | null {
  const cookieHeader = request.headers.get('cookie') || '';
  const value = cookieHeader.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${FLOW_COOKIE}=`))?.slice(FLOW_COOKIE.length + 1);
  return unsealOAuthFlow(value, secret);
}

export function safeStateMatches(expected: string, supplied: string | null): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export async function exchangeGoogleCode(code: string, flow: OAuthFlowState): Promise<VerifiedGoogleIdentity> {
  const configuration = readGoogleOAuthConfiguration();
  const client = googleOAuthClient(configuration);
  const { tokens } = await client.getToken({ code, codeVerifier: flow.codeVerifier, redirect_uri: configuration.redirectUri });
  if (!tokens.id_token) throw new Error('Google did not return an identity token.');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: configuration.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== flow.nonce) {
    throw new Error('Google identity verification failed.');
  }
  const name = String(payload.name || payload.email.split('@')[0] || 'Traveler').trim().slice(0, 120);
  const email = payload.email.trim().toLowerCase();
  return { subject: payload.sub, email, name: name.length >= 2 ? name : 'Traveler', authoritativeEmail: email.endsWith('@gmail.com') || Boolean(payload.hd) };
}

export async function findOrCreateGoogleUser(identity: VerifiedGoogleIdentity): Promise<{ user: PublicUser; sessionVersion: number; created: boolean }> {
  return prisma.$transaction(async (transaction) => {
    const linked = await transaction.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId: identity.subject } },
      include: { user: true },
    });
    if (linked) return { user: publicUser(linked.user), sessionVersion: linked.user.sessionVersion, created: false };

    const existingEmail = await transaction.user.findUnique({ where: { email: identity.email } });
    if (existingEmail) {
      if (!identity.authoritativeEmail) throw new OAuthAccountLinkRequiredError('Sign in with your existing password before linking Google.');
      await transaction.oAuthAccount.create({ data: { userId: existingEmail.id, provider: 'google', providerAccountId: identity.subject } });
      return { user: publicUser(existingEmail), sessionVersion: existingEmail.sessionVersion, created: false };
    }

    const created = await transaction.user.create({
      data: {
        name: identity.name,
        email: identity.email,
        role: 'traveler',
        emailVerified: true,
        profileStatus: 'unverified',
        trustScore: 50,
        accountStatus: 'active',
        passwordHash: null,
        passwordSalt: null,
        oauthAccounts: { create: { provider: 'google', providerAccountId: identity.subject } },
      },
    });
    return { user: publicUser(created), sessionVersion: created.sessionVersion, created: true };
  });
}
