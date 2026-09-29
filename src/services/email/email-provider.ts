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

function responseError(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = payload as { message?: unknown; error?: unknown };
  return typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : '';
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
    if (response.ok) return;
    const details = responseError(await response.json().catch(() => null));
    throw new Error(`Transactional email request failed (${response.status})${details ? `: ${details}` : '.'}`);
  }
}

export function resolveEmailProvider(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): TransactionalEmailProvider | undefined {
  if (String(environment.EMAIL_PROVIDER || '').toLowerCase() !== 'resend') return undefined;
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
    text: `Hello ${name}, your TravelMate verification code is ${code}. It expires in 30 minutes. If you did not create this account, you can ignore this message.`,
    html: `<p>Hello ${safeName},</p><p>Your TravelMate verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 30 minutes. If you did not create this account, you can ignore this message.</p>`,
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
