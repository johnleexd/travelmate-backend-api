import 'dotenv/config';
import { prisma } from '../src/lib/prisma.ts';
import { password } from '../src/repositories/platform-repository.ts';

// Retain owned trips, listings and audit history. Only the exact known seed
// identities still using the former public password are disabled.
const identities = [
  { id: 'usr_admin', email: 'admin@travelmate.test', role: 'admin' as const },
  { id: 'usr_traveler', email: 'traveler@travelmate.test', role: 'traveler' as const },
];

try {
  const candidates = await prisma.user.findMany({ where: { OR: identities } });
  const insecure = candidates.filter(user => user.passwordSalt && user.passwordHash
    && password('Travel123!', user.passwordSalt) === user.passwordHash);
  const apply = process.argv.includes('--apply');
  let disabled = 0;
  if (apply) {
    await prisma.$transaction(async transaction => {
      for (const user of insecure) {
        const changed = await transaction.user.updateMany({
          where: { id: user.id, email: user.email, role: user.role, passwordHash: user.passwordHash, passwordSalt: user.passwordSalt },
          data: { passwordHash: null, passwordSalt: null, accountStatus: 'suspended', sessionVersion: { increment: 1 } },
        });
        if (changed.count === 1) {
          await transaction.accountToken.deleteMany({ where: { userId: user.id } });
          await transaction.auditEvent.create({ data: { actorId: user.id, action: 'security-disable-demo-login', targetId: user.id } });
          disabled++;
        }
      }
    });
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', insecureDemoLogins: insecure.length, disabled }));
} catch {
  console.error('Demo login cleanup could not complete. No credentials are printed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
