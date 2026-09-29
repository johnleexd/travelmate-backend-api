import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeEnvironment } from "../src/config/env.ts";

const productionEmail = {
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "TravelMate <noreply@travelmate.example>",
};
const productionSecrets = {
  SESSION_SECRET: "a-secure-session-secret-with-32-characters",
  ACCOUNT_TOKEN_SECRET: "a-different-account-token-secret-with-32-characters",
};
const productionOAuth = {
  GOOGLE_CLIENT_ID: '123456789-travelmate.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-production-test-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://travelmate.example/api/auth/oauth/google/callback',
  OAUTH_STATE_SECRET: 'a-third-oauth-state-secret-with-32-characters',
};
const productionAI = {
  AI_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-production-test-key",
};
const productionDatabase = {
  DATABASE_URL: "postgresql://travelmate:secure@ep-production-pooler.region.aws.neon.tech/travelmate?sslmode=verify-full",
};

test("development runtime accepts local defaults", () => {
  assert.doesNotThrow(() => validateRuntimeEnvironment({ NODE_ENV: "development" }));
});

test("production runtime requires a strong session secret", () => {
  assert.throws(
    () => validateRuntimeEnvironment({ NODE_ENV: "production", ...productionDatabase, FRONTEND_URL: "https://travelmate.example", SESSION_SECRET: "short" }),
    /SESSION_SECRET/,
  );
});

test("production runtime requires canonical HTTPS frontend origins", () => {
  const base = { NODE_ENV: "production", ...productionDatabase, ...productionSecrets, ...productionOAuth, ...productionEmail, ...productionAI };
  assert.throws(() => validateRuntimeEnvironment({ ...base }), /FRONTEND_URL/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, FRONTEND_URL: "http://travelmate.example" }), /HTTPS/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, FRONTEND_URL: "https://travelmate.example,https://admin.travelmate.example/" }));
});

test("production runtime requires transactional email configuration", () => {
  const base = {
    NODE_ENV: "production",
    ...productionDatabase,
    ...productionSecrets,
    ...productionOAuth,
    FRONTEND_URL: "https://travelmate.example",
  };
  assert.throws(() => validateRuntimeEnvironment(base), /EMAIL_PROVIDER/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, EMAIL_PROVIDER: "resend" }), /RESEND_API_KEY/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" }), /EMAIL_FROM/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, ...productionEmail, ...productionAI }));
});

test("production runtime requires a configured AI provider", () => {
  const base = { NODE_ENV: "production", ...productionDatabase, FRONTEND_URL: "https://travelmate.example", ...productionSecrets, ...productionOAuth, ...productionEmail };
  assert.throws(() => validateRuntimeEnvironment(base), /AI_PROVIDER/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, ...productionAI }));
});

test("production runtime requires a separate account-token secret", () => {
  const base = { NODE_ENV: "production", ...productionDatabase, FRONTEND_URL: "https://travelmate.example", ...productionOAuth, ...productionEmail };
  assert.throws(() => validateRuntimeEnvironment({ ...base, SESSION_SECRET: productionSecrets.SESSION_SECRET }), /ACCOUNT_TOKEN_SECRET/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, ...productionSecrets, ACCOUNT_TOKEN_SECRET: productionSecrets.SESSION_SECRET }), /differ/);
});

test("production runtime requires a non-placeholder PostgreSQL database", () => {
  const base = { NODE_ENV: "production", FRONTEND_URL: "https://travelmate.example", ...productionSecrets, ...productionOAuth, ...productionEmail, ...productionAI };
  assert.throws(() => validateRuntimeEnvironment(base), /DATABASE_URL/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, DATABASE_URL: "postgresql://user:password@ep-example/neondb" }), /placeholder/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, ...productionDatabase }));
});

test("production runtime rejects development AI fallback", () => {
  const base = { NODE_ENV: "production", ...productionDatabase, FRONTEND_URL: "https://travelmate.example", ...productionSecrets, ...productionOAuth, ...productionEmail, ...productionAI };
  assert.throws(() => validateRuntimeEnvironment({ ...base, AI_MOCK_FALLBACK: "true" }), /AI_MOCK_FALLBACK/);
});

test('production runtime requires isolated Google OAuth configuration', () => {
  const base = { NODE_ENV: 'production', ...productionDatabase, FRONTEND_URL: 'https://travelmate.example', ...productionSecrets, ...productionEmail, ...productionAI };
  assert.throws(() => validateRuntimeEnvironment(base), /GOOGLE_CLIENT_ID/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, ...productionOAuth, OAUTH_STATE_SECRET: productionSecrets.SESSION_SECRET }), /OAUTH_STATE_SECRET/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, ...productionOAuth, GOOGLE_OAUTH_REDIRECT_URI: 'http://travelmate.example/api/auth/oauth/google/callback' }), /HTTPS/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, ...productionOAuth, GOOGLE_OAUTH_REDIRECT_URI: 'https://other.example/api/auth/oauth/google/callback' }), /FRONTEND_URL/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, ...productionOAuth }));
});
