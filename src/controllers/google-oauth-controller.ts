import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { createSessionToken, sessionCookie } from '../middlewares/auth-middleware.ts';
import { recordAuthAudit } from '../services/auth/auth-service.ts';
import {
  OAuthAccountLinkRequiredError,
  OAuthConfigurationError,
  clearOAuthFlowCookie,
  createGoogleAuthorization,
  exchangeGoogleCode,
  findOrCreateGoogleUser,
  oauthFlowFromRequest,
  readGoogleOAuthConfiguration,
  safeStateMatches,
} from '../services/auth/google-oauth-service.ts';

function frontendOrigin(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
}

function redirectToFrontend(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: `${frontendOrigin()}${path}`, 'Cache-Control': 'no-store' });
  cookies.forEach((cookie) => headers.append('Set-Cookie', cookie));
  return new Response(null, { status: 302, headers });
}

function oauthError(code: string): Response {
  return redirectToFrontend(`/?auth_error=${encodeURIComponent(code)}`, [clearOAuthFlowCookie()]);
}

export function GOOGLE_STATUS(): Response {
  try {
    readGoogleOAuthConfiguration();
    return Response.json({ available: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof OAuthConfigurationError)) throw error;
    return Response.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function GOOGLE_START(request: Request): Promise<Response> {
  const ip = request.headers.get('x-client-ip') || 'local';
  try {
    if (!await allowRequest(`oauth:start:${ip}`, 20, 60_000)) return oauthError('oauth_rate_limited');
    const authorization = await createGoogleAuthorization();
    const headers = new Headers({ Location: authorization.authorizationUrl, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', authorization.flowCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error('[TravelMate] Google OAuth start failed:', error instanceof Error ? error.message : error);
    return oauthError(error instanceof OAuthConfigurationError ? 'oauth_not_configured' : 'oauth_unavailable');
  }
}

export async function GOOGLE_CALLBACK(request: Request): Promise<Response> {
  const ip = request.headers.get('x-client-ip') || 'local';
  try {
    if (!await allowRequest(`oauth:callback:${ip}`, 30, 60_000)) return oauthError('oauth_rate_limited');
  } catch (error) {
    console.error('[TravelMate] Google OAuth callback rate limit failed:', error instanceof Error ? error.message : error);
    return oauthError('oauth_unavailable');
  }
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('error')) return oauthError('oauth_cancelled');
    const configuration = readGoogleOAuthConfiguration();
    const flow = oauthFlowFromRequest(request, configuration.stateSecret);
    if (!flow || !safeStateMatches(flow.state, url.searchParams.get('state'))) return oauthError('oauth_state_invalid');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) return oauthError('oauth_code_invalid');
    const identity = await exchangeGoogleCode(code, flow);
    const authenticated = await findOrCreateGoogleUser(identity);
    if (authenticated.user.accountStatus === 'suspended') return oauthError('account_suspended');
    await recordAuthAudit(authenticated.user.id, authenticated.created ? 'google-register' : 'google-login').catch(() => undefined);
    const destination = authenticated.user.role === 'admin' ? '/admin/dashboard' : authenticated.user.role === 'owner' ? '/owner/dashboard' : '/dashboard';
    return redirectToFrontend(destination, [
      clearOAuthFlowCookie(),
      sessionCookie(createSessionToken(authenticated.user.id, authenticated.user.role, authenticated.sessionVersion)),
    ]);
  } catch (error) {
    if (error instanceof OAuthAccountLinkRequiredError) return oauthError('account_link_required');
    console.error('[TravelMate] Google OAuth callback failed:', error instanceof Error ? error.message : error);
    return oauthError('oauth_token_invalid');
  }
}
