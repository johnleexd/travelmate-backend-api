import assert from 'node:assert/strict';
import test from 'node:test';
import { ResendEmailProvider, resolveEmailProvider, emailDeliveryDiagnostic } from '../src/services/email/email-provider.ts';

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
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'TravelMate <onboarding@resend.dev>' }), undefined);
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'your_resend_api_key_here' }), undefined);
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'other', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'noreply@example.com' }), undefined);
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'noreply@example.com' })?.name, 'resend');
});

test('provider rejection reasons are classified without copying codes or provider messages', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  for (const [message, reason] of [
    ['You can only send testing emails to your own email address. ABCD1234', 'testing_recipient_restricted'],
    ['The sender domain is not verified. ABCD1234', 'sender_domain_unverified'],
  ]) {
    const provider = new ResendEmailProvider('re_private_test', 'sender@example.test', async () => Response.json({ name: 'validation_error', message }, { status: 403 }));
    try {
      await provider.send({ to: 'user@example.test', subject: 'Verify', text: 'ABCD1234', html: 'ABCD1234' });
      assert.fail('Provider rejection must fail');
    } catch (error) {
      assert.deepEqual(emailDeliveryDiagnostic(error), { reason, status: 403, retryable: false });
      assert.equal(String(error).includes('ABCD1234'), false);
    }
  }
  assert.equal(logs.join(' ').includes('ABCD1234'), false);
  assert.equal(logs.join(' ').includes('re_private_test'), false);
});

test('HTTP success without a provider receipt is not reported as email acceptance', async () => {
  const provider = new ResendEmailProvider('re_test', 'sender@example.test', async () => Response.json({}));
  await assert.rejects(provider.send({ to: 'user@example.test', subject: 'Verify', text: '', html: '' }),
    error => emailDeliveryDiagnostic(error).reason === 'invalid_provider_receipt');
});

test('email provider errors never echo message content or account codes', async () => {
  const provider = new ResendEmailProvider('re_test_key', 'noreply@example.test', async () =>
    Response.json({ message: 'Rejected secret code ABCD1234 and re_test_key' }, { status: 422 }));
  await assert.rejects(provider.send({ to: 'user@example.test', subject: 'Verify', text: 'ABCD1234', html: 'ABCD1234' }),
    { message: 'Transactional email request failed (422).' });
});
