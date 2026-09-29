import "dotenv/config";
import { resolveEmailProvider } from "../src/services/email/email-provider.ts";

const recipient = process.env.EMAIL_SMOKE_TO?.trim();
const provider = resolveEmailProvider();

if (!recipient || !recipient.includes("@")) {
  throw new Error("EMAIL_SMOKE_TO must contain the real inbox used for the smoke test.");
}

if (!provider) {
  throw new Error(
    "Configure EMAIL_PROVIDER=resend, RESEND_API_KEY, and a verified EMAIL_FROM before running the email smoke test.",
  );
}

await provider.send({
  to: recipient,
  subject: "TravelMate transactional email smoke test",
  text: "TravelMate successfully reached the configured transactional email provider.",
  html: "<p><strong>TravelMate email is active.</strong></p><p>The configured transactional email provider accepted this smoke-test message.</p>",
});

console.log(`Transactional email accepted by ${provider.name} for ${recipient}.`);
