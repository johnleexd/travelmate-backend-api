import assert from 'node:assert/strict';
import test from 'node:test';
import { ResendEmailProvider, resolveEmailProvider } from '../src/services/email/email-provider.ts';

test('Resend provider sends a server-side transactional email request', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new ResendEmailProvider('re_test_key', 'TravelMate <noreply@travelmate.example>', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ id: 'email-test' }, { status: 200 });
  });

  await provider.send({
    to: 'traveler@example.com',
    subject: 'TravelMate test',
    text: 'Plain text',
    html: '<p>Plain text</p>',
  });

  assert.equal(requestUrl, 'https://api.resend.com/emails');
  assert.equal(requestInit?.method, 'POST');
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer re_test_key');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    from: 'TravelMate <noreply@travelmate.example>',
    to: ['traveler@example.com'],
    subject: 'TravelMate test',
    text: 'Plain text',
    html: '<p>Plain text</p>',
  });
});

test('email provider remains disabled when configuration is incomplete', () => {
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'your_resend_api_key_here' }), undefined);
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'other', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'noreply@example.com' }), undefined);
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'noreply@example.com' })?.name, 'resend');
});
