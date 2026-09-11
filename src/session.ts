import { createHmac, timingSafeEqual } from "node:crypto";
import type { PublicUser, Role } from "./domain.ts";
import { publicUser } from "./domain.ts";
import { prisma } from "./lib/prisma.ts";

export const SESSION_COOKIE = "travelmate_session";

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required in production.");
  return "travelmate-local-development-secret-change-me";
}

type Session = { userId: string; role: Role; exp: number };
const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (value: string) => createHmac("sha256", sessionSecret()).update(value).digest("base64url");

export function createSessionToken(userId: string, role: Role) {
  const payload = encode(JSON.stringify({ userId, role, exp: Date.now() + 1000 * 60 * 60 * 8 } satisfies Session));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token?: string): Session | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") || "";
  return cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function currentUser(request: Request, requiredRole?: Role): Promise<PublicUser | null> {
  const session = verifySessionToken(cookieValue(request, SESSION_COOKIE));
  if (!session || (requiredRole && session.role !== requiredRole)) return null;
  const user = await prisma.user.findFirst({
    where: { id: session.userId, role: session.role, accountStatus: "active" },
  });
  return user ? publicUser(user) : null;
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
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
