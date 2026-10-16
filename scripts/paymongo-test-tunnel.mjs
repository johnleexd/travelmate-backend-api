import http from 'node:http';

// Expose only the webhook through the tunnel, never the rest of the local API.
const path = '/api/webhooks/paymongo';
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST' || request.url !== path) { request.resume(); response.writeHead(404).end(); return; }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 128 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const headers = { 'Content-Type': request.headers['content-type'] || 'application/octet-stream' };
    if (request.headers['paymongo-signature']) headers['Paymongo-Signature'] = request.headers['paymongo-signature'];
    const upstream = await fetch('http://127.0.0.1:5000' + path, {
      method: 'POST', headers, body: Buffer.concat(chunks), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(Buffer.from(await upstream.arrayBuffer()));
  } catch { if (!response.headersSent) response.writeHead(502).end(); else response.end(); }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.maxConnections = 50;
server.listen(8787, '127.0.0.1', () => console.log('PayMongo webhook-only gateway listening on 127.0.0.1:8787'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
