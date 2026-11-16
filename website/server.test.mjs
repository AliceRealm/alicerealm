import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const port = 14173;
let child;

test.before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, WEBSITE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await Promise.race([
    once(child.stdout, 'data'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server startup timeout')), 5_000)),
  ]);
});

test.after(() => child?.kill());

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

test('does not proxy arbitrary API routes', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`);
  assert.equal(response.status, 404);
});
