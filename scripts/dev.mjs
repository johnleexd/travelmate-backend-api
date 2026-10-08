import { spawn } from 'node:child_process';
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
  const fingerprints = new Map();
  function fingerprint(file) {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch { return null; }
  }
  function trackDirectory(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
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
      if (filename && changed(path.join(sourceRoot, String(filename)))) scheduleRestart('source');
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
