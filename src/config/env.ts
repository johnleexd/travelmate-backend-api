const DEVELOPMENT_SECRET = "travelmate-local-development-secret-change-me";

export function validateRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;

  const secret = environment.SESSION_SECRET?.trim() || "";
  if (secret.length < 32 || secret === DEVELOPMENT_SECRET) {
    throw new Error("SESSION_SECRET must contain at least 32 non-default characters in production.");
  }

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
}
