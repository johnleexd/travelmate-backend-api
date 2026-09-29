import type { Prisma } from "../../generated/prisma/client.ts";
import { ProfileValidationError } from "../../exceptions/index.ts";
import type { PublicUser } from "../../schemas/domain.ts";
import { prisma } from "../../lib/prisma.ts";

function optionalText(value: unknown, field: string, maximumLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ProfileValidationError(`${field} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new ProfileValidationError(`${field} must be ${maximumLength} characters or fewer.`);
  }
  return normalized || null;
}

export function validateProfileUpdate(value: unknown): Prisma.UserUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileValidationError("A profile update object is required.");
  }

  const input = value as Record<string, unknown>;
  const data: Prisma.UserUpdateInput = {};

  if (input.name !== undefined) {
    if (typeof input.name !== "string") throw new ProfileValidationError("Name must be text.");
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new ProfileValidationError("Name must be between 2 and 80 characters.");
    }
    data.name = name;
  }

  const phone = optionalText(input.phone, "Phone", 30);
  if (phone !== undefined) {
    if (phone && !/^[0-9+().\-\s]+$/.test(phone)) {
      throw new ProfileValidationError("Phone contains unsupported characters.");
    }
    data.phone = phone;
  }

  const bio = optionalText(input.bio, "Bio", 500);
  if (bio !== undefined) data.bio = bio;

  if (Object.keys(data).length === 0) {
    throw new ProfileValidationError("Provide at least one profile field to update.");
  }

  return data;
}

const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  emailVerified: true,
  profileStatus: true,
  trustScore: true,
  accountStatus: true,
  bio: true,
  phone: true,
} satisfies Prisma.UserSelect;

type SelectedUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

function toPublicUser(user: SelectedUser): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
    profileStatus: user.profileStatus,
    trustScore: user.trustScore,
    accountStatus: user.accountStatus,
    bio: user.bio ?? undefined,
    phone: user.phone ?? undefined,
  };
}

export async function updateProfile(userId: string, input: unknown): Promise<PublicUser> {
  const data = validateProfileUpdate(input);
  const user = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.user.update({ where: { id: userId }, data, select: safeUserSelect });
    await transaction.auditEvent.create({ data: { actorId: userId, action: 'update-profile', targetId: userId } });
    return updated;
  });

  return toPublicUser(user);
}
