import app from './app.ts';
import { prisma, backendEnvironmentStatus } from './lib/prisma.ts';
import { validateRuntimeEnvironment } from './config/env.ts';
import { emailConfigurationIssues } from './services/email/email-provider.ts';

const PORT = Number(process.env.PORT) || 5000;
validateRuntimeEnvironment();
if (process.env.NODE_ENV !== 'production') {
    const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
    console.info(JSON.stringify({ event: 'email_configuration',
        provider: ['gmail', 'resend'].includes(provider || '') ? provider : 'unsupported_or_missing',
        missingVariables: emailConfigurationIssues(),
        overriddenVariables: backendEnvironmentStatus.overriddenVariables.filter(key =>
            ['NODE_ENV', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY'].includes(key)),
    }));
}

const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down TravelMate API.`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
