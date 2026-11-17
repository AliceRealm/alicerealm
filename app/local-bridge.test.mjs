import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { LocalBridge } from './local-bridge.mjs';

let home;
let bridge;
let server;
let baseURL;

test.before(async () => {
  home = mkdtempSync(join(tmpdir(), 'alicerealm-bridge-'));
  bridge = new LocalBridge({ home, port: 14182, ttlMs: 60_000 });
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:14182');
    try {
      const handled = await bridge.handle(request, response, url);
      if (handled === false) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_BRIDGE_ERROR', message: error.message } }));
    }
  });
  server.listen(14182, '127.0.0.1');
  await once(server, 'listening');
  baseURL = 'http://127.0.0.1:14182';
});

test.after(() => {
  bridge.removeState();
  server.close();
  rmSync(home, { recursive: true, force: true });
});

function agentFetch(path, options = {}) {
  return fetch(`${baseURL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${bridge.bridgeToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}

function uiFetch(path, options = {}) {
  return fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      'X-AliceRealm-UI-Token': bridge.uiToken,
      'X-AliceRealm-CSRF': bridge.csrfToken,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

test('writes only the agent bridge token to local state', () => {
  bridge.writeState();
  const state = JSON.parse(readFileSync(join(home, 'app', 'bridge.json'), 'utf8'));
  assert.equal(state.bridge_token, bridge.bridgeToken);
  assert.equal(state.base_url, baseURL);
  assert.equal(JSON.stringify(state).includes(bridge.uiToken), false);
  assert.equal(JSON.stringify(state).includes(bridge.csrfToken), false);
});

test('requires separate agent and UI credentials', async () => {
  assert.equal((await fetch(`${baseURL}/bridge/v1/status`)).status, 401);
  assert.equal((await fetch(`${baseURL}/local/v1/bootstrap`)).status, 401);
  assert.equal((await agentFetch('/bridge/v1/status')).status, 200);
  assert.equal((await uiFetch('/local/v1/bootstrap')).status, 200);
});

test('round-trips a canonical permission decision and progress event', async () => {
  const createdResponse = await agentFetch('/bridge/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'install_skills',
      source_host: 'claude-code',
      agent_label: 'Claude Code',
      operations: ['同步 7 个官方签名 Skills'],
      title: 'caller supplied title must not win',
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.title, '安装 AliceRealm Skills');
  assert.equal(created.status, 'pending');

  const decisionResponse = await uiFetch(`/local/v1/requests/${created.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).data.status, 'approved');

  const eventResponse = await agentFetch(`/bridge/v1/requests/${created.id}/events`, {
    method: 'POST',
    body: JSON.stringify({ stage: 'skills_sync', status: 'completed', message: '7 个 Skills 已安装' }),
  });
  assert.equal(eventResponse.status, 201);
  const completed = (await eventResponse.json()).data;
  assert.equal(completed.events.at(-1).stage, 'skills_sync');
  assert.equal(completed.events.at(-1).status, 'completed');

  const polled = (await (await agentFetch(`/bridge/v1/requests/${created.id}`)).json()).data;
  assert.equal(polled.status, 'approved');
});

test('rejects unsupported permission kinds and agent-side decisions', async () => {
  const unsupported = await agentFetch('/bridge/v1/requests', {
    method: 'POST',
    body: JSON.stringify({ kind: 'run_any_command' }),
  });
  assert.equal(unsupported.status, 400);

  const created = (await (await agentFetch('/bridge/v1/requests', {
    method: 'POST', body: JSON.stringify({ kind: 'notifications' }),
  })).json()).data;
  const forbidden = await agentFetch(`/local/v1/requests/${created.id}/decision`, {
    method: 'POST', body: JSON.stringify({ decision: 'approved' }),
  });
  assert.equal(forbidden.status, 403);
});
