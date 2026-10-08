import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface TransactionalEmailProvider {
  readonly name: string;
  send(message: TransactionalEmail): Promise<void>;
}

type FetchImplementation = typeof fetch;

export function isEmailAddress(value: string): boolean {
  return /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value);
}

export function emailConfigurationIssues(environment: NodeJS.ProcessEnv = process.env): string[] {
  const issues: string[] = [];
  if (environment.EMAIL_PROVIDER?.trim().toLowerCase() === 'gmail') {
    if (environment.NODE_ENV === 'production') issues.push('EMAIL_PROVIDER');
    const user = environment.SMTP_USER?.trim();
    if (!user || !isEmailAddress(user) || !/@gmail\.com$/i.test(user)) issues.push('SMTP_USER');
    if (!/^[a-z]{16}$/i.test((environment.SMTP_PASS || '').replace(/\s/g, ''))) issues.push('SMTP_PASS');
    const from = senderAddress(environment.EMAIL_FROM);
    if (!from || from.toLowerCase() !== user?.toLowerCase()) issues.push('EMAIL_FROM');
    return issues;
  }
  if (environment.EMAIL_PROVIDER?.trim().toLowerCase() !== 'resend') issues.push('EMAIL_PROVIDER');
  const apiKey = environment.RESEND_API_KEY?.trim();
  if (!apiKey || !/^re_[A-Za-z0-9_-]+$/.test(apiKey)) issues.push('RESEND_API_KEY');
  const from = environment.EMAIL_FROM?.trim();
  const address = from?.includes('<') ? from.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/)?.[1] : from;
  if (!address || !isEmailAddress(address) || address.includes('your-verified-domain.example') || /@resend\.dev$/i.test(address)) issues.push('EMAIL_FROM');
  return issues;
}

function senderAddress(from: string | undefined): string | undefined {
  const value = from?.trim();
  return value?.includes('<') ? value.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/)?.[1] : value;
}

/** Explicit development provider; no automatic fallback from Resend. */
export class GmailEmailProvider implements TransactionalEmailProvider {
  readonly name = 'gmail';
  private readonly environment: NodeJS.ProcessEnv;
  constructor(environment: NodeJS.ProcessEnv) { this.environment = environment; }

  async send(message: TransactionalEmail): Promise<void> {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: this.environment.SMTP_USER!.trim(), pass: this.environment.SMTP_PASS!.replace(/\s/g, '') },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
    try {
      const receipt = await transport.sendMail({ from: this.environment.EMAIL_FROM!.trim(), ...message });
      const accepted = receipt.accepted?.some(address => String(address).toLowerCase() === message.to.toLowerCase());
      if (!accepted || receipt.rejected?.length || !receipt.messageId) {
        throw new EmailDeliveryError(502, 'smtp_recipient_rejected', false);
      }
      console.info(JSON.stringify({ event: 'email_provider_accepted', provider: this.name,
        recipientHash: createHash('sha256').update(message.to.trim().toLowerCase()).digest('hex') }));
    } catch (error) {
      // SMTP errors can contain credentials or message content: expose only fixed categories.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const failure = error instanceof EmailDeliveryError ? error : code === 'EAUTH'
        ? new EmailDeliveryError(502, 'smtp_authentication_failed', false)
        : code === 'EENVELOPE'
          ? new EmailDeliveryError(502, 'smtp_recipient_rejected', false)
          : new EmailDeliveryError(502, 'smtp_connection_or_delivery_failed', true);
      console.warn(JSON.stringify({ event: 'email_provider_rejected', provider: this.name, ...emailDeliveryDiagnostic(failure) }));
      throw failure;
    } finally { transport.close(); }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] || character);
}

export class ResendEmailProvider implements TransactionalEmailProvider {
  readonly name = 'resend';
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    apiKey: string,
    from: string,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImplementation = fetchImplementation;
  }

  async send(message: TransactionalEmail): Promise<void> {
    const response = await this.fetchImplementation('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Classify internally; never log a provider message that could echo codes.
      const error = providerFailure(response.status, payload);
      console.warn(JSON.stringify({ event: 'email_provider_rejected', provider: this.name, ...emailDeliveryDiagnostic(error) }));
      throw error;
    }
    if (!payload || typeof payload.id !== 'string' || !payload.id.trim()) {
      throw new EmailDeliveryError(502, 'invalid_provider_receipt', true);
    }
    console.info(JSON.stringify({ event: 'email_provider_accepted', provider: this.name,
      recipientHash: createHash('sha256').update(message.to.trim().toLowerCase()).digest('hex'),
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id) ? { messageId: payload.id } : {}),
    }));
  }
}

export function resolveEmailProvider(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): TransactionalEmailProvider | undefined {
  if (emailConfigurationIssues(environment).length > 0) return undefined;
  if (environment.EMAIL_PROVIDER?.trim().toLowerCase() === 'gmail') return new GmailEmailProvider(environment);
  const apiKey = environment.RESEND_API_KEY?.trim();
  const from = environment.EMAIL_FROM?.trim();
  if (!apiKey || apiKey.startsWith('your_') || !from) return undefined;
  return new ResendEmailProvider(apiKey, from, fetchImplementation);
}

export async function sendVerificationEmail(to: string, name: string, code: string): Promise<boolean> {
  const provider = resolveEmailProvider();
  if (!provider) return false;
  const safeName = escapeHtml(name);
  await provider.send({
    to,
    subject: 'Verify your TravelMate account',
    text: `Hello ${name}, your TravelMate verification code is ${code}. It expires in 5 minutes and can be used once. If you did not create this account, you can ignore this message.`,
    html: `<p>Hello ${safeName},</p><p>Your TravelMate verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 5 minutes and can be used once. If you did not create this account, you can ignore this message.</p>`,
  });
  return true;
}

export async function sendPasswordResetEmail(to: string, name: string, code: string): Promise<boolean> {
  const provider = resolveEmailProvider();
  if (!provider) return false;
  const safeName = escapeHtml(name);
  await provider.send({
    to,
    subject: 'Reset your TravelMate password',
    text: `Hello ${name}, your TravelMate password reset code is ${code}. It expires in 15 minutes. If you did not request this, no action is required.`,
    html: `<p>Hello ${safeName},</p><p>Your TravelMate password reset code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 15 minutes. If you did not request this, no action is required.</p>`,
  });
  return true;
}
export class EmailDeliveryError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly retryable: boolean;
  constructor(status: number, reason: string, retryable: boolean) {
    super(`Transactional email request failed (${status}).`);
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

export function emailDeliveryDiagnostic(error: unknown): { reason: string; status?: number; retryable: boolean } {
  return error instanceof EmailDeliveryError
    ? { reason: error.reason, status: error.status, retryable: error.retryable }
    : { reason: 'network_or_timeout', retryable: true };
}

function providerFailure(status: number, payload: unknown): EmailDeliveryError {
  const data = payload && typeof payload === 'object' ? payload as { name?: unknown; message?: unknown } : {};
  const message = typeof data.message === 'string' ? data.message.toLowerCase() : '';
  let reason = 'provider_rejected';
  if (message.includes('only send testing emails to your own')) reason = 'testing_recipient_restricted';
  else if (message.includes('domain') && message.includes('not verified')) reason = 'sender_domain_unverified';
  else if (status === 401) reason = 'invalid_api_key';
  else if (['restricted_api_key', 'suspended_api_key', 'invalid_permission'].includes(String(data.name))) reason = 'key_permission_or_status';
  else if (status === 403) reason = 'sender_or_key_permission';
  else if (status === 429) reason = 'provider_rate_limit';
  return new EmailDeliveryError(status, reason, status === 429 || status >= 500);
}
