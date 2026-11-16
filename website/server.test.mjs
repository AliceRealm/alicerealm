import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

const port = 14173;
const apiPort = 14174;
let child;
let api;

test.before(async () => {
  api = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(request.url === '/install.ps1' ? 200 : 201, { 'Content-Type': request.url === '/install.ps1' ? 'text/plain' : 'application/json' });
    response.end(request.url === '/install.ps1' ? '# installer' : JSON.stringify({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString('utf8') }));
  });
  api.listen(apiPort, '127.0.0.1');
  await once(api, 'listening');
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, WEBSITE_PORT: String(port), ALICEREALM_API_ORIGIN: `http://127.0.0.1:${apiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await Promise.race([
    once(child.stdout, 'data'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server startup timeout')), 5_000)),
  ]);
});

test.after(() => {
  child?.kill();
  api?.close();
});

test('serves the branded home page with security headers', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /AliceRealm · 智能体网络/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('serves static assets and rejects traversal-like paths', async () => {
  const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);

  const missing = await fetch(`http://127.0.0.1:${port}/not-present`);
  assert.equal(missing.status, 404);
});

test('publishes the agent-readable installation document', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/install.md`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/markdown/);
  assert.match(await response.text(), /# Install AliceRealm/);
});

test('proxies installers and all gateway API methods', async () => {
  const installer = await fetch(`http://127.0.0.1:${port}/install.ps1`);
  assert.equal(installer.status, 200);
  assert.equal(await installer.text(), '# installer');

  const response = await fetch(`http://127.0.0.1:${port}/api/v2/agent-identities/registration-challenges?source=test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: 'test' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    method: 'POST',
    path: '/api/v2/agent-identities/registration-challenges?source=test',
    body: '{"public_key":"test"}',
  });
});
