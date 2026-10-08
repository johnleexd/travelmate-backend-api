import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PublicUser, Role } from "../schemas/domain.ts";
import { publicUser } from "../schemas/domain.ts";
import { prisma } from "../lib/prisma.ts";
import { retryDatabaseOperation } from "../lib/database-retry.ts";
import { constantTimeEqual } from "../utils/constant-time-equal.ts";

export const SESSION_COOKIE = "travelmate_session";

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required in production.");
  return "travelmate-local-development-secret-change-me";
}

type Session = { userId: string; role: Role; exp: number; sessionVersion?: number; id?: string };
const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (value: string) => createHmac("sha256", sessionSecret()).update(value).digest("base64url");

export function createSessionToken(userId: string, role: Role, sessionVersion = 0) {
  const payload = encode(JSON.stringify({ id: randomUUID(), userId, role, sessionVersion, exp: Date.now() + 1000 * 60 * 60 * 8 } satisfies Session));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token?: string): Session | null {
  if (!token) return null;
  const parts = token.split(".");
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = sign(payload);
  if (!constantTimeEqual(expected, signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return session && typeof session.userId === 'string' && session.userId.length > 0 && session.userId.length <= 200
      && Number.isSafeInteger(session.exp) && session.exp > Date.now()
      && Number.isSafeInteger(session.sessionVersion ?? 0) && (session.sessionVersion ?? 0) >= 0
      && (session.id === undefined || typeof session.id === 'string')
      && (session.role === "traveler" || session.role === "admin") ? session : null;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") || "";
  return cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function sessionFromRequest(request: Request): Session | null {
  return verifySessionToken(cookieValue(request, SESSION_COOKIE));
}

export async function currentUser(request: Request, requiredRole?: Role, allowSuspended = false): Promise<PublicUser | null> {
  const session = sessionFromRequest(request);
  if (!session || (requiredRole && session.role !== requiredRole)) return null;
  const user = await retryDatabaseOperation(() => prisma.user.findFirst({
    where: {
      id: session.userId, role: session.role, ...(allowSuspended ? {} : { accountStatus: 'active' as const }), sessionVersion: session.sessionVersion ?? 0,
      revokedSessions: { none: { tokenHash: sessionTokenHash(cookieValue(request, SESSION_COOKIE)!) } },
    },
  }));
  return user ? publicUser(user) : null;
}

function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Each login has a unique token; signing out revokes only this session. */
export async function revokeRequestSession(request: Request): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  const session = verifySessionToken(token);
  if (!session || !token) return;
  const tokenHash = sessionTokenHash(token);
  try {
    await retryDatabaseOperation(() => prisma.revokedSession.upsert({
      where: { tokenHash }, update: {},
      create: { tokenHash, userId: session.userId, expiresAt: new Date(session.exp) },
    }));
  } catch (error) {
    // A removed account cannot use its old session; no revocation row is needed.
    if ((error as { code?: string })?.code !== 'P2003') throw error;
  }
}

export async function requireUser(request: Request, role?: Role) {
  const user = await currentUser(request, role);
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

export function sessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 8}${secure}`;
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
