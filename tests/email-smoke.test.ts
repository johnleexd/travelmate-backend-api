import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { backendEnvironmentPath, loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { emailConfigurationIssues } from '../src/services/email/email-provider.ts';

test('backend environment loading uses an explicit path and preserves injected variables', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'travelmate-email-test-'));
  t.after(() => { rmSync(path.join(directory, '.env'), { force: true }); rmdirSync(directory); });
  const fixture = path.join(directory, '.env');
  writeFileSync(fixture, 'EMAIL_PROVIDER=resend\nRESEND_API_KEY=re_fixture\nEMAIL_FROM="TravelMate <sender@example.test>"\n');
  const environment = { RESEND_API_KEY: 're_injected' };
  const loaded = loadBackendEnvironment(environment, fixture);
  assert.deepEqual(loaded.overriddenVariables, ['RESEND_API_KEY']);
  assert.equal(environment.RESEND_API_KEY, 're_injected');
  assert.deepEqual(emailConfigurationIssues(environment), []);
  assert.equal(backendEnvironmentPath, fileURLToPath(new URL('../.env', import.meta.url)));
});

test('check-only CLI works outside the backend directory without disclosing values or sending', () => {
  const script = fileURLToPath(new URL('../scripts/send-email-smoke.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, '--check'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_private_fixture', EMAIL_FROM: 'Sender <sender@example.test>', EMAIL_SMOKE_TO: 'inbox@example.test' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No email was sent/);
  assert.equal((result.stdout + result.stderr).includes('re_private_fixture'), false);
  assert.equal((result.stdout + result.stderr).includes('sender@example.test'), false);
});

test('smoke CLI reports all invalid settings by name without echoing inputs', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../scripts/send-email-smoke.ts', import.meta.url)), '--check'], {
    encoding: 'utf8', env: { ...process.env, EMAIL_PROVIDER: '', RESEND_API_KEY: 'private-invalid-key', EMAIL_FROM: 'invalid-private-sender', EMAIL_SMOKE_TO: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM, EMAIL_SMOKE_TO/);
  assert.match(result.stderr, /No email was sent/);
  assert.equal(result.stderr.includes('private-invalid-key'), false);
  assert.equal(result.stderr.includes('invalid-private-sender'), false);
});

test('Gmail check validates its own settings without a Resend key or credential disclosure', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../scripts/send-email-smoke.ts', import.meta.url)), '--check'], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development', EMAIL_PROVIDER: 'gmail', RESEND_API_KEY: '', SMTP_USER: 'sender@gmail.com', SMTP_PASS: 'abcdefghijklmnop', EMAIL_FROM: 'TravelMate <sender@gmail.com>', EMAIL_SMOKE_TO: 'bjake1051@gmail.com' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No email was sent/);
  assert.equal((result.stdout + result.stderr).includes('abcdefghijklmnop'), false);
  assert.equal((result.stdout + result.stderr).includes('sender@gmail.com'), false);
});

for (const status of [200, 403]) {
  test(`smoke send handles HTTP ${status} without exposing credentials or provider responses`, async t => {
    const keys = ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_SMOKE_TO'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const previousExitCode = process.exitCode;
    Object.assign(process.env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_private_fixture', EMAIL_FROM: 'sender@example.test', EMAIL_SMOKE_TO: 'inbox@example.test' });
    t.after(() => {
      process.exitCode = previousExitCode;
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    });
    const output: string[] = [];
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      sends++;
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(JSON.parse(String(init?.body)).subject, 'TravelMate transactional email smoke test');
      return Response.json(status === 200 ? { id: 'test-accepted-email' } : { message: 'private-provider-echo' }, { status });
    });
    const script = new URL('../scripts/send-email-smoke.ts', import.meta.url);
    script.searchParams.set('test', String(status));
    await import(script.href);
    assert.equal(sends, 1);
    assert.equal(output.join(' ').includes('re_private_fixture'), false);
    assert.equal(output.join(' ').includes('private-provider-echo'), false);
    if (status === 200) assert.match(output.join(' '), /accepted.*API acceptance alone does not confirm inbox delivery/);
    else {
      assert.equal(process.exitCode, 1);
      assert.match(output.join(' '), /HTTP 403.*sending permissions.*Delivery is not confirmed/);
      assert.equal(output.join(' ').includes('accepted'), false);
    }
  });
}
