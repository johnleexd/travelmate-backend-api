import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDevelopmentServer } from '../scripts/dev.mjs';

test('development prepares the Prisma client before loading the API and regenerates after schema changes', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'travelmate-schema-watch-'));
  const directories = ['prisma', 'node_modules', 'node_modules/prisma', 'node_modules/prisma/build', 'src', 'src/generated', 'src/generated/prisma'];
  for (const directory of directories) mkdirSync(path.join(root, directory));
  const schema = path.join(root, 'prisma/schema.prisma');
  const generated = path.join(root, 'src/generated/prisma/client.ts');
  const cli = path.join(root, 'node_modules/prisma/build/index.js');
  const counter = path.join(root, 'generations.txt');
  const entry = path.join(root, 'src/server.mjs');
  writeFileSync(schema, 'schema-v1');
  writeFileSync(generated, "export default 'stale-client';");
  writeFileSync(counter, '');
  writeFileSync(cli, `
    const fs = require('node:fs');
    const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
    if (schema === 'invalid') process.exit(2);
    fs.writeFileSync('src/generated/prisma/client.ts', 'export default ' + JSON.stringify(schema) + ';');
    fs.appendFileSync('generations.txt', schema + '\\n');
  `);
  writeFileSync(entry, "import value from './generated/prisma/client.ts'; console.log('READY:' + value); setInterval(()=>{},1000);");
  let output = '';
  const children: import('node:child_process').ChildProcess[] = [];
  const server = startDevelopmentServer({ root, entry, stdio: 'pipe', onChild(child) {
    children.push(child);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
  } });
  t.after(async () => {
    server.stop();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    for (const file of [schema, generated, cli, counter, entry]) unlinkSync(file);
    for (const directory of directories.toReversed()) rmdirSync(path.join(root, directory));
    rmdirSync(root);
  });
  async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail('Development client did not synchronize with the schema.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await waitFor(() => output.includes('READY:schema-v1'));
  assert.equal(readFileSync(counter, 'utf8'), 'schema-v1\n');
  writeFileSync(schema, 'schema-v1');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(children.length, 1);

  writeFileSync(schema, 'schema-v2');
  await waitFor(() => output.includes('READY:schema-v2'));
  assert.equal(children.length, 2);
  assert.equal(readFileSync(counter, 'utf8'), 'schema-v1\nschema-v2\n');
  writeFileSync(entry, "import value from './generated/prisma/client.ts'; console.log('SOURCE:' + value); setInterval(()=>{},1000);");
  await waitFor(() => output.includes('SOURCE:schema-v2'));
  assert.equal(children.length, 3);
  assert.equal(readFileSync(counter, 'utf8'), 'schema-v1\nschema-v2\n');

  writeFileSync(schema, 'invalid');
  await waitFor(() => children[2].exitCode !== null || children[2].signalCode !== null);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(children.length, 3, 'Generation failure must not boot an API with the old client.');
  writeFileSync(schema, 'schema-v3');
  await waitFor(() => output.includes('SOURCE:schema-v3'));
  assert.equal(children.length, 4);
});

test('development API restarts after dotenv edits and loads the changed configuration', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'travelmate-env-watch-'));
  const env = path.join(root, '.env');
  const entry = path.join(root, 'fixture.mjs');
  writeFileSync(env, 'EMAIL_PROVIDER=resend');
  writeFileSync(entry, "import {readFileSync} from 'node:fs'; console.log('CONFIG:'+readFileSync('.env','utf8')); setInterval(()=>{},1000);");
  let output = '';
  const children: import('node:child_process').ChildProcess[] = [];
  const server = startDevelopmentServer({ root, entry, stdio: 'pipe', onChild(child) {
    children.push(child);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
  } });
  t.after(async () => {
    server.stop();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    unlinkSync(env); unlinkSync(entry); rmdirSync(root);
  });
  async function waitFor(value: string) {
    const deadline = Date.now() + 15_000;
    while (!output.includes(value)) {
      if (Date.now() >= deadline) assert.fail('Development child did not load expected fixture configuration.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await waitFor('CONFIG:EMAIL_PROVIDER=resend');
  writeFileSync(env, 'EMAIL_PROVIDER=resend');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(children.length, 1);
  const replacement = path.join(root, '.env.next');
  writeFileSync(replacement, 'EMAIL_PROVIDER=gmail');
  renameSync(replacement, env);
  await waitFor('CONFIG:EMAIL_PROVIDER=gmail');
  assert.equal(children.length, 2);
});

test('dependency changes preserve in-flight requests while source edits restart and recover the API', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'travelmate-source-watch-'));
  const source = path.join(root, 'src');
  const nested = path.join(source, 'nested');
  const dependencies = path.join(root, 'node_modules');
  mkdirSync(source); mkdirSync(nested); mkdirSync(dependencies);
  const entry = path.join(source, 'server.mjs');
  const value = path.join(nested, 'value.mjs');
  const dependency = path.join(dependencies, 'dependency.mjs');
  writeFileSync(value, "export default 'initial';");
  writeFileSync(dependency, "export default 'original';");
  writeFileSync(entry, `
    import http from 'node:http';
    import value from './nested/value.mjs';
    import dependency from '../node_modules/dependency.mjs';
    const server = http.createServer((_req, res) => {
      console.log('REQUEST');
      setTimeout(() => res.end(JSON.stringify({ value, dependency })), 1500);
    });
    server.listen(0, '127.0.0.1', () => {
      console.log('READY:' + value + ':' + dependency + ':' + server.address().port);
    });
  `);
  let output = '';
  const children: import('node:child_process').ChildProcess[] = [];
  const server = startDevelopmentServer({ root, entry, stdio: 'pipe', onChild(child) {
    children.push(child);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
  } });
  t.after(async () => {
    server.stop();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    for (const file of [entry, value, dependency]) unlinkSync(file);
    for (const directory of [nested, source, dependencies, root]) rmdirSync(directory);
  });
  async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail('Development fixture did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await waitFor(() => output.includes('READY:initial:original:'));
  const port = output.match(/READY:initial:original:(\d+)/)![1];
  const request = fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) })
    .then(response => response.json())
    .catch(error => ({ error: error.message }));
  await waitFor(() => output.includes('REQUEST'));
  writeFileSync(dependency, "export default 'changed';");
  utimesSync(value, new Date(), new Date());
  assert.deepEqual(await request, { value: 'initial', dependency: 'original' });
  assert.equal(children.length, 1);
  assert.equal(children[0].exitCode, null);

  writeFileSync(value, "export default 'updated';");
  await waitFor(() => output.includes('READY:updated:changed:'));
  assert.equal(children.length, 2);

  writeFileSync(value, 'export default ;');
  await waitFor(() => children.length === 3 && children[2].exitCode !== null);
  writeFileSync(value, "export default 'recovered';");
  await waitFor(() => output.includes('READY:recovered:changed:'));
  assert.equal(children.length, 4);
});
