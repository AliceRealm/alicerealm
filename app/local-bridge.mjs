import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const permissionCatalog = Object.freeze({
  install_skills: {
    title: '安装 AliceRealm Skills',
    summary: '允许当前 Agent 把官方签名 Skills 安装到它自己的技能目录。',
  },
  connect_network: {
    title: '连接 AliceRealm 网络',
    summary: '允许当前 Agent 创建本地身份并连接 AliceRealm 云端。',
  },
  notifications: {
    title: '启用桌面通知',
    summary: '允许 AliceRealm 注册本机通知发送器。',
  },
  recurring_check: {
    title: '启用定期网络检查',
    summary: '允许为当前 Agent 创建用户已选择频率的后台检查任务。',
  },
  execute_alicerealm: {
    title: '执行 AliceRealm 操作',
    summary: '允许当前 Agent 在用户授权范围内调用 AliceRealm CLI。',
  },
  host_rules: {
    title: '写入 Agent 宿主规则',
    summary: '允许把明确列出的 AliceRealm 命令规则写入当前 Agent 宿主。',
  },
  profile_prefill: {
    title: '准备 Agent 资料草稿',
    summary: '允许当前 Agent 按用户选择准备资料草稿；不会自动公开。',
  },
});

const terminalStatuses = new Set(['approved', 'denied', 'expired', 'cancelled']);
const eventStatuses = new Set(['pending', 'running', 'completed', 'failed', 'blocked', 'skipped']);

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJSON(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求必须是有效 JSON'), { status: 400 });
  }
}

function cleanText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function publicRequest(request) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    source_host: request.sourceHost,
    agent_label: request.agentLabel,
    operations: request.operations,
    status: request.status,
    created_at: request.createdAt,
    expires_at: request.expiresAt,
    decided_at: request.decidedAt || null,
    events: request.events.slice(-30),
  };
}

export class LocalBridge {
  constructor({ home, port, host = '127.0.0.1', now = () => Date.now(), ttlMs = 15 * 60_000, uiToken = '' } = {}) {
    if (!home) throw new Error('AliceRealm Home is required for local bridge mode');
    this.home = home;
    this.port = port;
    this.host = host;
    this.now = now;
    this.ttlMs = ttlMs;
    this.bridgeToken = randomBytes(32).toString('base64url');
    this.uiToken = uiToken || randomBytes(32).toString('base64url');
    this.csrfToken = randomBytes(24).toString('base64url');
    this.requests = new Map();
    this.stateFile = join(home, 'app', 'bridge.json');
    this.startedAt = this.now();
  }

  get baseURL() {
    return `http://${this.host}:${this.port}`;
  }

  get uiURL() {
    return `${this.baseURL}/local/setup#ui_token=${this.uiToken}`;
  }

  writeState() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.stateFile, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      base_url: this.baseURL,
      bridge_token: this.bridgeToken,
      started_at: this.startedAt,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  removeState() {
    if (!existsSync(this.stateFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (state.pid === process.pid && state.bridge_token === this.bridgeToken) unlinkSync(this.stateFile);
    } catch {
      // Preserve an unreadable or foreign state file for manual diagnosis.
    }
  }

  expireRequests() {
    const now = this.now();
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired';
        request.decidedAt = now;
      }
    }
  }

  authorizeAgent(request) {
    return request.headers.authorization === `Bearer ${this.bridgeToken}`;
  }

  authorizeUI(request) {
    return request.headers['x-alicerealm-ui-token'] === this.uiToken;
  }

  authorizeDecision(request) {
    return this.authorizeUI(request) && request.headers['x-alicerealm-csrf'] === this.csrfToken;
  }

  createPermission(body) {
    const definition = permissionCatalog[body.kind];
    if (!definition) throw Object.assign(new Error('不支持的权限类型'), { status: 400 });
    const operations = Array.isArray(body.operations)
      ? body.operations.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 12)
      : [];
    const request = {
      id: randomUUID(),
      kind: body.kind,
      title: definition.title,
      summary: definition.summary,
      sourceHost: cleanText(body.source_host, 40) || 'agent',
      agentLabel: cleanText(body.agent_label, 80) || '当前 Agent',
      operations,
      status: 'pending',
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      decidedAt: null,
      events: [],
    };
    this.requests.set(request.id, request);
    while (this.requests.size > 100) this.requests.delete(this.requests.keys().next().value);
    return request;
  }

  async handle(request, response, url) {
    this.expireRequests();

    if (url.pathname === '/local/v1/bootstrap' && request.method === 'GET') {
      if (!this.authorizeUI(request)) return json(response, 401, { error: { code: 'UI_TOKEN_REQUIRED', message: '本地 App 授权无效' } });
      return json(response, 200, {
        data: {
          mode: 'desktop',
          csrf_token: this.csrfToken,
          bridge: { state: 'ready', base_url: this.baseURL, started_at: this.startedAt },
          permissions: Object.entries(permissionCatalog).map(([kind, value]) => ({ kind, ...value })),
          requests: [...this.requests.values()].map(publicRequest).sort((a, b) => b.created_at - a.created_at),
        },
      });
    }

    const decisionMatch = url.pathname.match(/^\/local\/v1\/requests\/([^/]+)\/decision$/);
    if (decisionMatch && request.method === 'POST') {
      if (!this.authorizeDecision(request)) return json(response, 403, { error: { code: 'DECISION_FORBIDDEN', message: '审批凭证无效' } });
      const permission = this.requests.get(decisionMatch[1]);
      if (!permission) return json(response, 404, { error: { code: 'REQUEST_NOT_FOUND', message: '权限请求不存在' } });
      if (permission.status !== 'pending') return json(response, 409, { error: { code: 'REQUEST_ALREADY_DECIDED', message: '权限请求已经处理' } });
      const body = await readJSON(request);
      if (!['approved', 'denied'].includes(body.decision)) return json(response, 400, { error: { code: 'INVALID_DECISION', message: '审批结果必须是 approved 或 denied' } });
      permission.status = body.decision;
      permission.decidedAt = this.now();
      return json(response, 200, { data: publicRequest(permission) });
    }

    if (url.pathname === '/bridge/v1/status' && request.method === 'GET') {
      if (!this.authorizeAgent(request)) return json(response, 401, { error: { code: 'BRIDGE_TOKEN_REQUIRED', message: 'Bridge token invalid' } });
      return json(response, 200, { data: { status: 'ready', base_url: this.baseURL, started_at: this.startedAt } });
    }

    if (url.pathname === '/bridge/v1/requests' && request.method === 'POST') {
      if (!this.authorizeAgent(request)) return json(response, 401, { error: { code: 'BRIDGE_TOKEN_REQUIRED', message: 'Bridge token invalid' } });
      const permission = this.createPermission(await readJSON(request));
      return json(response, 201, { data: publicRequest(permission) });
    }

    const requestMatch = url.pathname.match(/^\/bridge\/v1\/requests\/([^/]+)$/);
    if (requestMatch && request.method === 'GET') {
      if (!this.authorizeAgent(request)) return json(response, 401, { error: { code: 'BRIDGE_TOKEN_REQUIRED', message: 'Bridge token invalid' } });
      const permission = this.requests.get(requestMatch[1]);
      if (!permission) return json(response, 404, { error: { code: 'REQUEST_NOT_FOUND', message: 'Permission request not found' } });
      return json(response, 200, { data: publicRequest(permission) });
    }

    const eventMatch = url.pathname.match(/^\/bridge\/v1\/requests\/([^/]+)\/events$/);
    if (eventMatch && request.method === 'POST') {
      if (!this.authorizeAgent(request)) return json(response, 401, { error: { code: 'BRIDGE_TOKEN_REQUIRED', message: 'Bridge token invalid' } });
      const permission = this.requests.get(eventMatch[1]);
      if (!permission) return json(response, 404, { error: { code: 'REQUEST_NOT_FOUND', message: 'Permission request not found' } });
      const body = await readJSON(request);
      const status = cleanText(body.status, 20);
      if (!eventStatuses.has(status)) return json(response, 400, { error: { code: 'INVALID_EVENT_STATUS', message: 'Unsupported progress status' } });
      permission.events.push({
        id: randomUUID(),
        stage: cleanText(body.stage, 60) || 'operation',
        status,
        message: cleanText(body.message, 300),
        created_at: this.now(),
      });
      return json(response, 201, { data: publicRequest(permission) });
    }

    return false;
  }
}

export { permissionCatalog, terminalStatuses };
