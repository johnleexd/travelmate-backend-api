const DEVELOPMENT_SECRET = "travelmate-local-development-secret-change-me";

export function validateRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;

  const databaseUrl = environment.DATABASE_URL?.trim() || "";
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL in production.");
  }
  if (/user:password|ep-example|localhost|127\.0\.0\.1/i.test(databaseUrl)) {
    throw new Error("DATABASE_URL must not use placeholder or local database values in production.");
  }

  const secret = environment.SESSION_SECRET?.trim() || "";
  if (secret.length < 32 || secret === DEVELOPMENT_SECRET) {
    throw new Error("SESSION_SECRET must contain at least 32 non-default characters in production.");
  }
  const accountTokenSecret = environment.ACCOUNT_TOKEN_SECRET?.trim() || "";
  if (accountTokenSecret.length < 32 || accountTokenSecret === secret) {
    throw new Error("ACCOUNT_TOKEN_SECRET must contain at least 32 characters and differ from SESSION_SECRET in production.");
  }
  const googleClientId = environment.GOOGLE_CLIENT_ID?.trim() || '';
  const googleClientSecret = environment.GOOGLE_CLIENT_SECRET?.trim() || '';
  const oauthStateSecret = environment.OAUTH_STATE_SECRET?.trim() || '';
  const googleRedirectUri = environment.GOOGLE_OAUTH_REDIRECT_URI?.trim() || '';
  if (!googleClientId.endsWith('.apps.googleusercontent.com') || !googleClientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production.');
  }
  if (oauthStateSecret.length < 32 || [secret, accountTokenSecret].includes(oauthStateSecret)) {
    throw new Error('OAUTH_STATE_SECRET must contain at least 32 characters and differ from other application secrets.');
  }
  let parsedGoogleRedirect: URL;
  try { parsedGoogleRedirect = new URL(googleRedirectUri); }
  catch { throw new Error('GOOGLE_OAUTH_REDIRECT_URI must be a valid URL in production.'); }
  if (parsedGoogleRedirect.protocol !== 'https:') throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production.');

  const frontendOrigins = (environment.FRONTEND_URL || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (frontendOrigins.length === 0) throw new Error("FRONTEND_URL is required in production.");
  for (const value of frontendOrigins) {
    let origin: URL;
    try { origin = new URL(value); }
    catch { throw new Error(`FRONTEND_URL contains an invalid origin: ${value}`); }
    if (origin.protocol !== "https:" || origin.origin !== value.replace(/\/$/, "")) {
      throw new Error(`FRONTEND_URL must contain HTTPS origins only: ${value}`);
    }
  }
  if (!frontendOrigins.includes(parsedGoogleRedirect.origin)) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use an origin listed in FRONTEND_URL.');
  }

  if (String(environment.EMAIL_PROVIDER || '').toLowerCase() !== 'resend') {
    throw new Error('EMAIL_PROVIDER must be set to resend in production.');
  }
  const resendKey = environment.RESEND_API_KEY?.trim() || '';
  if (!resendKey || resendKey.startsWith('your_')) {
    throw new Error('RESEND_API_KEY is required in production.');
  }
  const emailFrom = environment.EMAIL_FROM?.trim() || '';
  if (!emailFrom || !emailFrom.includes('@')) {
    throw new Error('EMAIL_FROM must contain a verified sender address in production.');
  }

  const aiProvider = String(environment.AI_PROVIDER || '').toLowerCase();
  if (aiProvider !== 'openai' && aiProvider !== 'gemini') {
    throw new Error('AI_PROVIDER must be set to openai or gemini in production.');
  }
  const aiKey = aiProvider === 'gemini' ? environment.GEMINI_API_KEY?.trim() : environment.OPENAI_API_KEY?.trim();
  if (!aiKey || aiKey.startsWith('your_')) {
    throw new Error(`${aiProvider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} is required in production.`);
  }
  if (String(environment.AI_MOCK_FALLBACK || '').toLowerCase() === 'true') {
    throw new Error('AI_MOCK_FALLBACK must not be enabled in production.');
  }
}
