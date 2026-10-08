import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { checkHealth } from '../scripts/healthcheck.mjs';

async function fixture(t: import('node:test').TestContext, handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return (server.address() as import('node:net').AddressInfo).port;
}

test('container healthcheck reaches the API with the production proxy scheme', async t => {
  const port = await fixture(t, (request, response) => {
    assert.equal(request.url, '/health');
    assert.equal(request.headers['x-forwarded-proto'], 'https');
    response.end(JSON.stringify({ status: 'ok', database: 'connected' }));
  });
  await checkHealth({ port });
});

test('an HTTP 200 with an unavailable database is unhealthy', async t => {
  const port = await fixture(t, (_request, response) => {
    response.end(JSON.stringify({ status: 'ok', database: 'unavailable' }));
  });
  await assert.rejects(checkHealth({ port }), /not ready/);
});

test('container healthcheck rejects HTTP errors and malformed responses', async t => {
  const errorPort = await fixture(t, (_request, response) => {
    response.writeHead(503).end();
  });
  await assert.rejects(checkHealth({ port: errorPort }), /HTTP 503/);
  const invalidPort = await fixture(t, (_request, response) => response.end('not JSON'));
  await assert.rejects(checkHealth({ port: invalidPort }), SyntaxError);
});

test('a stalled health endpoint cannot block deployment indefinitely', async t => {
  const port = await fixture(t, () => {});
  await assert.rejects(checkHealth({ port, timeoutMs: 50 }), { name: 'TimeoutError' });
});
