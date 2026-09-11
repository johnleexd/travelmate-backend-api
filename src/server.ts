import app from './app.ts';
import { prisma } from './lib/prisma.ts';
import { validateRuntimeEnvironment } from './config.ts';

const PORT = Number(process.env.PORT) || 5000;
validateRuntimeEnvironment();

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
