import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { EmailExistsError } from "../../exceptions/index.ts";
import { publicUser, type PublicUser, type Role } from "../../schemas/domain.ts";
import { prisma } from "../../lib/prisma.ts";
import { password } from "../../repositories/platform-repository.ts";

export async function authenticateUser(email: string, rawPassword: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || password(rawPassword, user.passwordSalt) !== user.passwordHash) return null;
  return publicUser(user);
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
    const user = await prisma.user.create({
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
        bio: `verification:${input.verificationCode}`,
      },
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
    const user = await transaction.user.findFirst({
      where: { email, emailVerified: false, bio: `verification:${code}` },
    });
    if (!user) return null;

    const verified = await transaction.user.update({
      where: { id: user.id },
      data: { emailVerified: true, bio: "" },
    });
    return publicUser(verified);
  });
}
