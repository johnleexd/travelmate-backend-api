import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

const envPath = new URL('../.env', import.meta.url);
const secrets = [];
const sanitize = value => {
  let text = String(value ?? 'Unknown error');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:sk_(?:test|live)_|whsk_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
};
try {
  const env = parse(await readFile(envPath, 'utf8'));
  const key = env.PAYMONGO_SECRET_KEY?.trim();
  if (!key?.startsWith('sk_test_') || key.includes('...')) throw new Error('A PayMongo test secret is required in the backend .env; no API request was sent.');
  secrets.push(key, Buffer.from(key + ':').toString('base64'));
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com') || url.username || url.password || url.port || url.pathname !== '/api/webhooks/paymongo' || url.search || url.hash) throw new Error('Supply the public Cloudflare HTTPS test webhook URL with the exact /api/webhooks/paymongo path.');
  const headers = { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' };
  const call = async (path, method = 'GET', body) => {
    const response = await fetch('https://api.paymongo.com/v1/webhooks' + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(JSON.stringify({ provider: 'PayMongo', mode: 'test', status: response.status, errors: Array.isArray(value?.errors) ? value.errors.map(error => ({ code: sanitize(error.code), detail: sanitize(error.detail) })) : [{ detail: 'API request rejected without a JSON error response.' }] }));
      process.exitCode = 1; return null;
    }
    return value;
  };
  const list = await call('');
  if (list) {
    if (!Array.isArray(list.data)) throw new Error('Could not verify the existing webhook list. No webhook was created.');
    const existing = list.data.find(item => item.attributes?.url === url.href && item.attributes?.livemode === false);
    const events = ['payment.paid', 'payment.failed', 'checkout_session.payment.paid'];
    const matchingEvents = existing && Array.isArray(existing.attributes.events) && existing.attributes.events.length === events.length && events.every(event => existing.attributes.events.includes(event));
    const result = existing ? matchingEvents ? { data: existing } : await call('/' + encodeURIComponent(existing.id), 'PUT', { data: { attributes: { events } } }) : await call('', 'POST', { data: { attributes: { url: url.href, events } } });
    if (result) {
      const hook = result.data;
      if (hook?.attributes?.secret_key) secrets.push(hook.attributes.secret_key);
      if (hook?.type !== 'webhook' || hook.attributes?.livemode !== false || hook.attributes?.url !== url.href || !/^hook_[A-Za-z0-9]+$/.test(hook.id ?? '') || !hook.attributes?.secret_key?.startsWith('whsk_')) throw new Error('Provider response did not contain a confirmed test webhook and signing secret. Environment was not changed.');
      if (!Array.isArray(hook.attributes.events) || hook.attributes.events.length !== events.length || !events.every(event => hook.attributes.events.includes(event))) throw new Error('Webhook events do not match the requested events. No duplicate webhook was created and the environment was not changed.');
      const latest = await readFile(envPath, 'utf8');
      if (parse(latest).PAYMONGO_SECRET_KEY?.trim() !== key) throw new Error('The API key changed during registration. Environment was not overwritten.');
      let updated = latest;
      const newline = latest.includes('\r\n') ? '\r\n' : '\n';
      for (const [name, value] of Object.entries({ PAYMONGO_WEBHOOK_SECRET: hook.attributes.secret_key, PAYMONGO_WEBHOOK_ID: hook.id, PAYMONGO_WEBHOOK_URL: url.href })) {
        const line = `${name}=${JSON.stringify(value)}`;
        const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, 'gm');
        if (pattern.test(updated)) updated = updated.replace(pattern, () => line);
        else updated += (updated.endsWith('\n') ? '' : newline) + line + newline;
      }
      const temp = new URL('../.env.paymongo-' + randomUUID(), import.meta.url);
      try { await writeFile(temp, updated, { mode: 0o600, flag: 'wx' }); await rename(temp, envPath); }
      finally { await unlink(temp).catch(() => {}); }
      console.log(JSON.stringify({ mode: 'test', livemode: hook.attributes.livemode, operation: existing ? 'reused_existing_webhook' : 'created_webhook', id: hook.id, url: hook.attributes.url, status: hook.attributes.status, events: hook.attributes.events, signingSecretSavedAs: 'PAYMONGO_WEBHOOK_SECRET' }));
    }
  }
} catch (error) { console.error(JSON.stringify({ error: sanitize(error instanceof Error ? error.message : error) })); process.exitCode = 1; }
