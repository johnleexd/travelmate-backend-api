import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OAuthConfigurationError,
  createGoogleAuthorization,
  readGoogleOAuthConfiguration,
  safeStateMatches,
  sealOAuthFlow,
  unsealOAuthFlow,
} from '../src/services/auth/google-oauth-service.ts';

const configuration = {
  GOOGLE_CLIENT_ID: '123456789-travelmate.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/oauth/google/callback',
  OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
};

test('Google OAuth configuration requires every server-side secret', () => {
  assert.deepEqual(readGoogleOAuthConfiguration(configuration), {
    clientId: configuration.GOOGLE_CLIENT_ID,
    clientSecret: configuration.GOOGLE_CLIENT_SECRET,
    redirectUri: configuration.GOOGLE_OAUTH_REDIRECT_URI,
    stateSecret: configuration.OAUTH_STATE_SECRET,
  });
  assert.throws(() => readGoogleOAuthConfiguration({ ...configuration, GOOGLE_CLIENT_SECRET: '' }), OAuthConfigurationError);
  assert.throws(() => readGoogleOAuthConfiguration({ ...configuration, OAUTH_STATE_SECRET: 'short' }), OAuthConfigurationError);
  assert.throws(() => readGoogleOAuthConfiguration({ ...configuration, GOOGLE_CLIENT_ID: 'your_google_oauth_client_id.apps.googleusercontent.com' }), OAuthConfigurationError);
});

test('OAuth flow cookie is authenticated, expires, and rejects tampering', () => {
  const now = Date.now();
  const flow = { state: 's'.repeat(43), nonce: 'n'.repeat(43), codeVerifier: 'v'.repeat(64), expiresAt: now + 60_000 };
  const sealed = sealOAuthFlow(flow, configuration.OAUTH_STATE_SECRET);
  assert.deepEqual(unsealOAuthFlow(sealed, configuration.OAUTH_STATE_SECRET, now), flow);
  assert.equal(unsealOAuthFlow(`${sealed.slice(0, -1)}x`, configuration.OAUTH_STATE_SECRET, now), null);
  assert.equal(unsealOAuthFlow(sealed, configuration.OAUTH_STATE_SECRET, now + 60_001), null);
});

test('OAuth state comparison is exact', () => {
  const state = 'random-state-value-with-sufficient-length';
  assert.equal(safeStateMatches(state, state), true);
  assert.equal(safeStateMatches(state, `${state}x`), false);
  assert.equal(safeStateMatches(state, null), false);
});

test('authorization request uses code flow, minimal identity scopes, state, nonce, and PKCE', async () => {
  const previous = Object.fromEntries(Object.keys(configuration).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  try {
    const result = await createGoogleAuthorization();
    const url = new URL(result.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));
    assert.deepEqual(new Set(url.searchParams.get('scope')?.split(' ')), new Set(['openid', 'email', 'profile']));
    assert.match(result.flowCookie, /HttpOnly; SameSite=Lax/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
