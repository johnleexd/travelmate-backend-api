import assert from 'node:assert/strict';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { emailConfigurationIssues, emailDeliveryDiagnostic, resolveEmailProvider, sendVerificationEmail } from '../src/services/email/email-provider.ts';

const configuration = { NODE_ENV: 'development', EMAIL_PROVIDER: 'gmail', SMTP_USER: 'sender@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop', EMAIL_FROM: 'TravelMate <sender@gmail.com>' };

test('Gmail configuration requires an App Password and matching sender; production stays restricted', () => {
  assert.deepEqual(emailConfigurationIssues(configuration), []);
  assert.equal(resolveEmailProvider(configuration)?.name, 'gmail');
  assert.deepEqual(emailConfigurationIssues({ ...configuration, SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: '' }), ['SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
  assert.deepEqual(emailConfigurationIssues({ ...configuration, SMTP_PASS: 'regular-password', EMAIL_FROM: 'other@gmail.com' }), ['SMTP_PASS', 'EMAIL_FROM']);
  assert.equal(resolveEmailProvider({ ...configuration, NODE_ENV: 'production' }), undefined);
});

test('Gmail sends the verification message to the supplied pending email using authenticated TLS', async t => {
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const logs: string[] = [];
  t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  let closed = false;
  t.mock.method(nodemailer, 'createTransport', options => {
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.logger, false);
    assert.equal(options.debug, false);
    return { close() { closed = true; }, async sendMail(message) {
      assert.equal(message.to, 'bjake1051@gmail.com');
      assert.equal(message.from, configuration.EMAIL_FROM);
      assert.match(message.text, /code is ABCD1234.*5 minutes.*once/);
      return { accepted: [message.to], rejected: [], messageId: '<receipt@gmail.com>' };
    } };
  });
  assert.equal(await sendVerificationEmail('bjake1051@gmail.com', 'Test', 'ABCD1234'), true);
  assert.equal(closed, true);
  assert.equal(logs.join(' ').includes('ABCD1234'), false);
  assert.equal(logs.join(' ').includes('abcdefghijklmnop'), false);
});

test('SMTP rejection, authentication errors and network failures never claim acceptance or echo secrets', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  const provider = resolveEmailProvider(configuration)!;
  const message = { to: 'bjake1051@gmail.com', subject: 'Test', text: 'ABCD1234', html: 'ABCD1234' };
  for (const [code, reason] of [['EAUTH', 'smtp_authentication_failed'], ['ETIMEDOUT', 'smtp_connection_or_delivery_failed'], ['EENVELOPE', 'smtp_recipient_rejected']]) {
    const mock = t.mock.method(nodemailer, 'createTransport', () => ({ close() {}, async sendMail() { throw Object.assign(new Error('ABCD1234 secret-password'), { code }); } }));
    await assert.rejects(provider.send(message), error => emailDeliveryDiagnostic(error).reason === reason && !String(error).includes('ABCD1234'));
    mock.mock.restore();
  }
  t.mock.method(nodemailer, 'createTransport', () => ({ close() {}, async sendMail() { return { accepted: [], rejected: [message.to], messageId: 'receipt' }; } }));
  await assert.rejects(provider.send(message), error => emailDeliveryDiagnostic(error).reason === 'smtp_recipient_rejected');
  assert.equal(logs.join(' ').includes('ABCD1234'), false);
  assert.equal(logs.join(' ').includes('secret-password'), false);
  assert.equal(logs.join(' ').includes('email_provider_accepted'), false);
});
