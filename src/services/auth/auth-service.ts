import { createHmac, randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { EmailExistsError } from "../../exceptions/index.ts";
import { publicUser, type PublicUser, type Role } from "../../schemas/domain.ts";
import { prisma } from "../../lib/prisma.ts";
import { password } from "../../repositories/platform-repository.ts";

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
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordSalt || !user.passwordHash || password(rawPassword, user.passwordSalt) !== user.passwordHash) return null;
  return { ...publicUser(user), sessionVersion: user.sessionVersion };
}

export async function registerUser(input: {
  name: string;
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
          email: input.email,
          role: input.role,
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
          tokenHash: hashAccountToken(input.verificationCode),
          expiresAt: expiresIn(30),
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
  return prisma.$transaction(async (transaction) => {
    const token = await transaction.accountToken.findFirst({
      where: {
        kind: "email_verification",
        tokenHash: hashAccountToken(code),
        expiresAt: { gt: new Date() },
        user: { email, emailVerified: false },
      },
      include: { user: true },
    });
    const user = token?.user;
    if (!user) return null;

    const verified = await transaction.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
    await transaction.accountToken.deleteMany({ where: { userId: user.id, kind: "email_verification" } });
    return publicUser(verified);
  });
}

async function issueTokenForEmail(email: string, kind: AccountTokenKind, code: string, lifetimeMinutes: number): Promise<PublicUser | null> {
  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.findFirst({
      where: {
        email,
        accountStatus: "active",
        ...(kind === "email_verification" ? { emailVerified: false } : { emailVerified: true }),
      },
    });
    if (!user) return null;
    await transaction.accountToken.upsert({
      where: { userId_kind: { userId: user.id, kind } },
      create: { userId: user.id, kind, tokenHash: hashAccountToken(code), expiresAt: expiresIn(lifetimeMinutes) },
      update: { tokenHash: hashAccountToken(code), expiresAt: expiresIn(lifetimeMinutes), createdAt: new Date() },
    });
    return publicUser(user);
  });
}

export function reissueVerificationCode(email: string, code: string): Promise<PublicUser | null> {
  return issueTokenForEmail(email, "email_verification", code, 30);
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
