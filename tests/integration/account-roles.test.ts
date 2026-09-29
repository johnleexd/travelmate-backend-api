import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { POST } from '../../src/controllers/auth-controller.ts';
import { registerUser } from '../../src/services/auth/auth-service.ts';
import { GET as platform } from '../../src/controllers/platform-controller.ts';

test('one login routes travelers and admins using the stored role', async () => {
  for (const role of ['traveler', 'admin'] as const) {
    const response = await POST(new Request('http://localhost/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client-ip': `role-login-${role}-${Date.now()}` },
      body: JSON.stringify({ action: 'login', email: `${role}@travelmate.test`, password: 'Travel123!' }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.role, role);
    assert.equal(body.redirect, role === 'admin' ? '/admin/dashboard' : '/dashboard');
    if (role === 'traveler') {
      const denied = await platform(new Request('http://localhost/api/platform?scope=admin', { headers: { cookie: response.headers.get('set-cookie')! } }));
      assert.equal(denied.status, 401);
    }
  }
});

test('registration cannot grant admin privileges', async () => {
  const email = `role-registration-${Date.now()}@example.test`;
  try {
    const user = await registerUser({ name: 'Role Test', email, rawPassword: 'Travel123!', role: 'admin', verificationCode: 'A1B2C3D4' });
    assert.equal(user.role, 'traveler');
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});
