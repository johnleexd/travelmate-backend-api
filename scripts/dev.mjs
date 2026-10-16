import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Watch application files explicitly. Node --watch also watches imported
// dependencies, whose changes can interrupt an in-flight OAuth callback.
export function startDevelopmentServer({ root, entry = 'src/server.ts', stdio = 'inherit', onChild = () => {} }) {
  let child;
  let stopping = false;
  let restarting = false;
  let timer;
  let preparedSchema;
  const fingerprints = new Map();
  const schema = path.join(root, 'prisma/schema.prisma');
  const generatedRoot = path.join(root, 'src/generated/prisma');
  function fingerprint(file) {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch { return null; }
  }
  function trackDirectory(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (file === generatedRoot) continue;
      if (item.isDirectory()) trackDirectory(file);
      else if (item.isFile()) fingerprints.set(file, fingerprint(file));
    }
  }
  function changed(file) {
    const previous = fingerprints.get(file) ?? null;
    const current = fingerprint(file);
    fingerprints.set(file, current);
    return previous !== current;
  }
  function terminate() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      child.kill();
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  }
  function start() {
    // Git pulls update the schema, but the ignored generated client stays local.
    // Prepare it before importing the API; source-only restarts can reuse it.
    if (existsSync(schema)) {
      const currentSchema = fingerprint(schema);
      if (preparedSchema !== currentSchema || !existsSync(path.join(generatedRoot, 'client.ts'))) {
        console.log('[dev] Generating Prisma client for the current schema...');
        const result = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'generate'], { cwd: root, stdio: 'inherit' });
        if (result.error || result.status !== 0) {
          console.error('[dev] Prisma client generation failed. Run npm run db:generate, then restart. Waiting for a source or schema change.');
          return;
        }
        preparedSchema = currentSchema;
      }
    }
    child = spawn(process.execPath, ['--experimental-strip-types', entry], {
      cwd: root, env: { ...process.env }, stdio, detached: process.platform !== 'win32',
    });
    onChild(child);
    child.on('error', () => { console.error('[dev] Could not start backend.'); stop(); process.exitCode = 1; });
    child.on('exit', code => {
      if (stopping) return;
      if (restarting) { restarting = false; start(); }
      else if (code !== 0) console.error('[dev] Backend stopped; waiting for a source or .env change.');
    });
  }
  function scheduleRestart(reason) {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopping || restarting) return;
      console.log(`[dev] Backend ${reason} changed; restarting API.`);
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        start();
        return;
      }
      restarting = true;
      terminate();
    }, 300);
  }
  // Watch the directory so atomic .env replacements work without reading secrets.
  const envFile = path.join(root, '.env');
  fingerprints.set(envFile, fingerprint(envFile));
  const watchers = [watch(root, (_event, filename) => {
    if (String(filename) === '.env' && changed(envFile)) scheduleRestart('.env');
  })];
  const sourceRoot = path.join(root, 'src');
  const entryPath = path.resolve(root, entry);
  if (existsSync(sourceRoot)) {
    trackDirectory(sourceRoot);
    watchers.push(watch(sourceRoot, { recursive: true }, (_event, filename) => {
      // Windows can emit notifications for directory access or metadata alone.
      // Only changed file contents should interrupt a running API request.
      if (!filename) return;
      const file = path.join(sourceRoot, String(filename));
      if (file === generatedRoot || file.startsWith(generatedRoot + path.sep)) return;
      if (changed(file)) scheduleRestart('source');
    }));
  }
  if (existsSync(schema)) {
    fingerprints.set(schema, fingerprint(schema));
    watchers.push(watch(path.dirname(schema), (_event, filename) => {
      if (String(filename) === path.basename(schema) && changed(schema)) scheduleRestart('Prisma schema');
    }));
  }
  const relativeEntry = path.relative(sourceRoot, entryPath);
  if (!existsSync(sourceRoot) || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) {
    fingerprints.set(entryPath, fingerprint(entryPath));
    watchers.push(watch(path.dirname(entryPath), (_event, filename) => {
      if (String(filename) === path.basename(entryPath) && changed(entryPath)) scheduleRestart('source');
    }));
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    terminate();
  }
  start();
  return { stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startDevelopmentServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
  process.on('SIGINT', () => server.stop());
  process.on('SIGTERM', () => server.stop());
}
