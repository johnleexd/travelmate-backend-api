import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const unavailable = process.platform === 'win32' && !existsSync(shell);
const shellPath = (value: string) => process.platform === 'win32'
  ? value.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_match, drive: string) => `/${drive.toLowerCase()}`)
  : value;
const script = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));

function deploy(t: import('node:test').TestContext, failure: 'none' | 'migration' | 'health') {
  const root = mkdtempSync(path.join(tmpdir(), 'travelmate-deployment-'));
  const bin = path.join(root, 'bin');
  const docker = path.join(root, 'docker');
  mkdirSync(bin); mkdirSync(docker);
  const calls = path.join(root, 'calls.log');
  const compose = path.join(docker, 'docker-compose.yaml');
  const command = path.join(bin, 'docker');
  writeFileSync(compose, 'services: {}\n');
  writeFileSync(command, `#!/bin/sh
printf '%s|%s\\n' "$TRAVELMATE_IMAGE" "$*" >> "$CALL_LOG"
case "$*" in
  'compose -f docker-compose.yaml ps --quiet app') echo old-container ;;
  'inspect --format {{.Config.Image}} old-container') echo fixture/travelmate:previous ;;
  'compose -f docker-compose.yaml run --rm --no-deps migrate')
    [ "$FAILURE" != migration ] || exit 1 ;;
  'compose -f docker-compose.yaml up --detach --no-deps --wait --wait-timeout 120 app')
    [ "$FAILURE" != health ] || [ "$TRAVELMATE_IMAGE" = fixture/travelmate:previous ] || exit 1 ;;
esac
`);
  chmodSync(command, 0o755);
  t.after(() => {
    for (const file of [command, compose, calls]) if (existsSync(file)) unlinkSync(file);
    for (const directory of [bin, docker, root]) rmdirSync(directory);
  });
  const result = spawnSync(shell, ['-c', 'export PATH="$FAKE_DOCKER_DIR:$PATH"; exec sh "$DEPLOY_SCRIPT"'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      FAKE_DOCKER_DIR: shellPath(bin),
      DEPLOY_SCRIPT: shellPath(script),
      TRAVELMATE_DEPLOY_DIR: shellPath(root),
      TRAVELMATE_IMAGE: 'fixture/travelmate:release',
      CALL_LOG: shellPath(calls),
      FAILURE: failure,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}

test('Docker deployment applies migrations before replacing the application', { skip: unavailable }, t => {
  const result = deploy(t, 'none');
  assert.equal(result.status, 0);
  const migration = result.calls.findIndex(call => call.includes(' run '));
  const replacement = result.calls.findIndex(call => call.includes(' up '));
  assert.ok(migration >= 0 && replacement > migration);
  assert.equal(result.calls.some(call => /\b(down|prune)\b/.test(call)), false);
});

test('a failed migration leaves the current application running', { skip: unavailable }, t => {
  const result = deploy(t, 'migration');
  assert.equal(result.status, 1);
  assert.equal(result.calls.some(call => call.includes(' up ')), false);
});

test('an unhealthy release restores the previous image and reports failure', { skip: unavailable }, t => {
  const result = deploy(t, 'health');
  assert.equal(result.status, 1);
  const replacements = result.calls.filter(call => call.includes(' up '));
  assert.equal(replacements.length, 2);
  assert.ok(replacements[0].startsWith('fixture/travelmate:release|'));
  assert.ok(replacements[1].startsWith('fixture/travelmate:previous|'));
});
