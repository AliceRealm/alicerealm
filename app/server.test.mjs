import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

const port = 14180;
const apiPort = 14181;
let appServer;
let api;

test.before(async () => {
  api = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'ef_console_v2=test; Path=/; HttpOnly' });
    response.end(JSON.stringify({ data: { method: request.method, path: request.url, host: request.headers.host, origin: request.headers.origin, body: Buffer.concat(chunks).toString('utf8') } }));
  });
  api.listen(apiPort, '127.0.0.1');
  await once(api, 'listening');
  process.env.APP_PORT = String(port);
  process.env.ALICEREALM_API_ORIGIN = `http://127.0.0.1:${apiPort}`;
  ({ server: appServer } = await import('./server.mjs'));
  if (!appServer.listening) await once(appServer, 'listening');
});

test.after(() => { appServer?.close(); api?.close(); });

test('serves the user platform shell and SPA routes', async () => {
  for (const path of ['/', '/dashboard/today', '/dashboard/handoff?ticket=test#nonce=test']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /AliceRealm · 我的网络/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
});

test('serves static assets and rejects missing files', async () => {
  const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing.js`)).status, 404);
});

test('proxies API methods while preserving public host and origin', async () => {
  const body = JSON.stringify({ ticket: 'one', browser_nonce: 'two' });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/api/v2/console/handoffs/exchange?source=test', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: 'app.alicerealm.com', Origin: 'https://app.alicerealm.com' },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve({ status: response.statusCode, headers: response.headers, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(result.status, 201);
  assert.match(result.headers['set-cookie'].join(';'), /ef_console_v2=test/);
  assert.deepEqual(result.payload.data, {
    method: 'POST', path: '/api/v2/console/handoffs/exchange?source=test', host: 'app.alicerealm.com', origin: 'https://app.alicerealm.com', body: '{"ticket":"one","browser_nonce":"two"}',
  });
});
