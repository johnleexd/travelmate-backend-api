import { createHash, createHmac, randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { EmailExistsError } from "../../exceptions/index.ts";
import { publicUser, type PublicUser, type Role } from "../../schemas/domain.ts";
import { prisma } from "../../lib/prisma.ts";
import { retryDatabaseOperation } from "../../lib/database-retry.ts";
import { password } from "../../repositories/platform-repository.ts";
import { allowRequest } from '../../middlewares/rate-limit-middleware.ts';

export class VerificationCooldownError extends Error {}
export class VerificationRateLimitError extends Error {}
export const VERIFICATION_LIFETIME_MS = 5 * 60_000;
export const VERIFICATION_COOLDOWN_MS = 60_000;
export const VERIFICATION_ATTEMPTS = 5;

export function hashVerificationCode(userId: string, code: string): string {
  return hashAccountToken(`${userId}:email_verification:${code.trim().toUpperCase()}`);
}

export async function invalidateVerificationCode(userId: string, code: string): Promise<void> {
  // Preserve createdAt for cooldown enforcement; never invalidate a newer resend.
  await prisma.accountToken.updateMany({
    where: { userId, kind: 'email_verification', tokenHash: hashVerificationCode(userId, code) },
    data: { expiresAt: new Date(0) },
  });
}

type AccountTokenKind = "email_verification" | "password_reset";

export interface AuthenticatedUser extends PublicUser {
  sessionVersion: number;
}

export function generateAccountCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export async function recordAuthAudit(actorId: string, action: string): Promise<void> {
  await prisma.auditEvent.create({ data: { actorId, action, targetId: actorId } });
}

function accountTokenSecret(): string {
  return process.env.ACCOUNT_TOKEN_SECRET || process.env.SESSION_SECRET || "travelmate-local-account-token-secret-change-me";
}

export function hashAccountToken(value: string, secret = accountTokenSecret()): string {
  return createHmac("sha256", secret).update(value.trim().toUpperCase()).digest("hex");
}

function expiresIn(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export async function authenticateUser(email: string, rawPassword: string): Promise<AuthenticatedUser | null> {
  const user = await retryDatabaseOperation(() => prisma.user.findUnique({ where: { email } }));
  if (!user || !user.passwordSalt || !user.passwordHash || password(rawPassword, user.passwordSalt) !== user.passwordHash) return null;
  return { ...publicUser(user), sessionVersion: user.sessionVersion };
}

export async function registerUser(input: {
  name: string;
  phone?: string;
  email: string;
  rawPassword: string;
  role: Role;
  verificationCode: string;
}): Promise<PublicUser> {
  const salt = randomBytes(16).toString("hex");
  try {
    const user = await prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          name: input.name,
          phone: input.phone,
          email: input.email,
          role: 'traveler',
          emailVerified: false,
          profileStatus: "unverified",
          trustScore: 50,
          accountStatus: "active",
          passwordSalt: salt,
          passwordHash: password(input.rawPassword, salt),
        },
      });
      await transaction.accountToken.create({
        data: {
          userId: created.id,
          kind: "email_verification",
          tokenHash: hashVerificationCode(created.id, input.verificationCode),
          expiresAt: expiresIn(5),
        },
      });
      return created;
    });
    return publicUser(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new EmailExistsError();
    }
    throw error;
  }
}

export async function verifyEmail(email: string, code: string): Promise<PublicUser | null> {
  const token = await prisma.accountToken.findFirst({
    where: {
      kind: 'email_verification', expiresAt: { gt: new Date() },
      createdAt: { gt: new Date(Date.now() - VERIFICATION_LIFETIME_MS) },
      user: { email, emailVerified: false, accountStatus: 'active' },
    },
  });
  if (!token) return null;
  const allowed = await allowRequest(`verification:${token.id}:${token.tokenHash}`, VERIFICATION_ATTEMPTS, VERIFICATION_LIFETIME_MS);
  if (!allowed) {
    await prisma.accountToken.updateMany({ where: { id: token.id, tokenHash: token.tokenHash }, data: { expiresAt: new Date(0) } });
    return null;
  }
  return prisma.$transaction(async (transaction) => {
    // Use the same lock order as resending to avoid a verify/resend deadlock.
    await transaction.$queryRaw`SELECT id FROM users WHERE id = ${token.userId} FOR UPDATE`;
    // DELETE locks the row, so only one concurrent request can consume the code.
    const consumed = await transaction.accountToken.deleteMany({
      where: {
        id: token.id, kind: 'email_verification',
        tokenHash: hashVerificationCode(token.userId, code),
        expiresAt: { gt: new Date() },
        createdAt: { gt: new Date(Date.now() - VERIFICATION_LIFETIME_MS) },
        user: { email, emailVerified: false, accountStatus: 'active' },
      },
    });
    if (consumed.count !== 1) return null;

    const verified = await transaction.user.update({
      where: { id: token.userId },
      data: { emailVerified: true },
    });
    return publicUser(verified);
  });
}

async function issueTokenForEmail(email: string, kind: AccountTokenKind, code: string, lifetimeMinutes: number): Promise<PublicUser | null> {
  return prisma.$transaction(async (transaction) => {
    if (kind === 'email_verification') {
      // Serialize resends for this account across all API instances.
      await transaction.$queryRaw`SELECT id FROM users WHERE email = ${email} FOR UPDATE`;
    }
    const user = await transaction.user.findFirst({
      where: {
        email,
        accountStatus: "active",
        ...(kind === "email_verification" ? { emailVerified: false } : { emailVerified: true }),
      },
    });
    if (!user) return null;
    if (kind === 'email_verification') {
      const previous = await transaction.accountToken.findUnique({ where: { userId_kind: { userId: user.id, kind } } });
      if (previous && Date.now() - previous.createdAt.getTime() < VERIFICATION_COOLDOWN_MS) {
        throw new VerificationCooldownError('Wait 60 seconds before requesting another verification email.');
      }
      // Count issuance attempts, not clicks rejected by cooldown or ineligibility.
      const emailKey = createHash('sha256').update(email).digest('hex');
      if (!await allowRequest(`auth:resend-verification:email:${emailKey}`, 3, 60 * 60_000)) {
        throw new VerificationRateLimitError('The hourly verification email limit has been reached. Try again in one hour.');
      }
    }
    const tokenHash = kind === 'email_verification' ? hashVerificationCode(user.id, code) : hashAccountToken(code);
    await transaction.accountToken.upsert({
      where: { userId_kind: { userId: user.id, kind } },
      create: { userId: user.id, kind, tokenHash, expiresAt: expiresIn(lifetimeMinutes) },
      update: { tokenHash, expiresAt: expiresIn(lifetimeMinutes), createdAt: new Date() },
    });
    return publicUser(user);
  });
}

export function reissueVerificationCode(email: string, code: string): Promise<PublicUser | null> {
  return issueTokenForEmail(email, "email_verification", code, 5);
}

export function issuePasswordResetCode(email: string, code: string): Promise<PublicUser | null> {
  return issueTokenForEmail(email, "password_reset", code, 15);
}

export async function resetPassword(email: string, code: string, rawPassword: string): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const token = await transaction.accountToken.findFirst({
      where: {
        kind: "password_reset",
        tokenHash: hashAccountToken(code),
        expiresAt: { gt: new Date() },
        user: { email, emailVerified: true, accountStatus: "active" },
      },
      include: { user: true },
    });
    if (!token) return false;

    // DELETE locks the token row. Only one concurrent transaction can consume it.
    const consumed = await transaction.accountToken.deleteMany({
      where: {
        id: token.id, kind: 'password_reset', tokenHash: hashAccountToken(code), expiresAt: { gt: new Date() },
        user: { email, emailVerified: true, accountStatus: 'active' },
      },
    });
    if (consumed.count !== 1) return false;

    const salt = randomBytes(16).toString("hex");
    await transaction.user.update({
      where: { id: token.userId },
      data: {
        passwordSalt: salt,
        passwordHash: password(rawPassword, salt),
        sessionVersion: { increment: 1 },
      },
    });
    await transaction.accountToken.deleteMany({ where: { userId: token.userId } });
    return true;
  });
}
