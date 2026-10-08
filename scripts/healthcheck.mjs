import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkHealth({ port = process.env.PORT || '5000', timeoutMs = 5000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    // The probe stays inside the container; the API enforces proxy HTTPS in production.
    headers: { 'X-Forwarded-Proto': 'https' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.status !== 'ok' || result.database !== 'connected') {
    throw new Error('API or database is not ready.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkHealth(); }
  catch (error) {
    console.error(`[healthcheck] ${error instanceof Error ? error.message : 'API is unavailable.'}`);
    process.exitCode = 1;
  }
}
