import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { emailConfigurationIssues, emailDeliveryDiagnostic, isEmailAddress, resolveEmailProvider } from "../src/services/email/email-provider.ts";

async function main() {
  loadBackendEnvironment();
  const recipient = process.env.EMAIL_SMOKE_TO?.trim();
  const issues = emailConfigurationIssues();
  if (!recipient || !isEmailAddress(recipient) || recipient === 'your-real-inbox@example.com') issues.push('EMAIL_SMOKE_TO');
  if (issues.length) {
    console.error(`Missing or invalid backend environment variables: ${issues.join(', ')}.`);
    const instructions: Record<string, string> = {
      EMAIL_PROVIDER: 'EMAIL_PROVIDER: set to resend, or gmail for development (Gmail is disabled in production).',
      SMTP_USER: 'SMTP_USER: supply the Gmail address of the sending account.',
      SMTP_PASS: 'SMTP_PASS: supply a 16-character Google App Password, generated after enabling 2-Step Verification. Never use your regular Google password.',
      RESEND_API_KEY: 'RESEND_API_KEY: supply the real re_ API key from your Resend account with sending access.',
      EMAIL_FROM: 'EMAIL_FROM: for gmail use the same address as SMTP_USER, optionally as TravelMate <address>; for resend use your own verified domain. The restricted resend.dev test sender is not accepted.',
      EMAIL_SMOKE_TO: 'EMAIL_SMOKE_TO: supply a real inbox you control for the smoke test.',
    };
    for (const variable of issues) console.error(instructions[variable]);
    console.error('The backend .env is loaded by file location. Existing process environment variables take precedence; .env.example is a template only. No email was sent.');
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--check')) {
    console.log('Local email configuration passes validation. No email was sent. Provider credentials and sending permissions still require an actual smoke test.');
    return;
  }
  const provider = resolveEmailProvider()!;
  try {
    await provider.send({
      to: recipient!,
      subject: "TravelMate transactional email smoke test",
      text: "TravelMate successfully reached the configured transactional email provider.",
      html: "<p><strong>TravelMate email is active.</strong></p><p>The configured transactional email provider accepted this smoke-test message.</p>",
    });
  } catch (error) {
    const status = error instanceof Error ? /^Transactional email request failed \((\d+)\)\.$/.exec(error.message)?.[1] : undefined;
    const hints: Record<string, string> = {
      '401': 'Check RESEND_API_KEY; it may be invalid or revoked.',
      '403': 'Check API key sending permissions, domain restrictions, and verified EMAIL_FROM in the same Resend account.',
      '422': 'Check EMAIL_FROM and EMAIL_SMOKE_TO and sender-domain verification in Resend.',
      '429': 'Check Resend sending limits before retrying.',
    };
    const diagnostic = emailDeliveryDiagnostic(error);
    const gmailHint = diagnostic.reason === 'smtp_authentication_failed'
      ? 'Check SMTP_USER and SMTP_PASS: enable Google 2-Step Verification and generate an App Password for the same Gmail account.'
      : 'Check the recipient, Gmail sending limits, and outbound TLS access to smtp.gmail.com:465.';
    console.error(`Email smoke test failed${provider.name === 'resend' && status ? ` (HTTP ${status})` : ''}. ${provider.name === 'gmail' ? `${diagnostic.reason}. ${gmailHint}` : status ? hints[status] || 'Check the email request in the Resend dashboard.' : 'Check network access to api.resend.com and retry.'} Delivery is not confirmed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${provider.name === 'gmail' ? 'Gmail SMTP' : 'Resend'} accepted the smoke-test email. Confirm delivery in your inbox; API acceptance alone does not confirm inbox delivery.`);
}

await main().catch(() => {
  console.error('Could not load backend email configuration. Check backend .env file access. No email was sent.');
  process.exitCode = 1;
});
