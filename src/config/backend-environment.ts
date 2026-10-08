import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

export const backendEnvironmentPath = fileURLToPath(new URL('../../.env', import.meta.url));

export function loadBackendEnvironment(environment: NodeJS.ProcessEnv = process.env, envPath = backendEnvironmentPath): { overriddenVariables: string[] } {
  const injectedVariables = new Set(Object.keys(environment).filter(key => environment[key] !== undefined));
  const result = config({ path: envPath, processEnv: environment, override: false, quiet: true });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw new Error('Could not read the backend .env file. Check file access permissions.');
  }
  return { overriddenVariables: Object.keys(result.parsed || {}).filter(key => injectedVariables.has(key)) };
}
