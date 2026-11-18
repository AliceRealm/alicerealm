import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalBridge } from './local-bridge.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number.parseInt(process.env.APP_PORT || '4180', 10);
const host = process.env.APP_HOST || '127.0.0.1';
const appMode = process.env.APP_MODE || 'web';
const apiOrigin = new URL(process.env.ALICEREALM_API_ORIGIN || (appMode === 'desktop' ? 'https://alicerealm.com' : 'http://127.0.0.1:8080'));
const appHome = process.env.ALICEREALM_HOME || join(homedir(), '.alicerealm');
const bridge = appMode === 'desktop' ? new LocalBridge({ home: appHome, port, host, uiToken: process.env.ALICEREALM_UI_TOKEN || '' }) : null;

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://app.alicerealm.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function proxyAPI(request, response, url) {
  const headers = { ...request.headers };
  delete headers.connection;
  delete headers['proxy-connection'];
  if (appMode === 'desktop') {
    headers.host = apiOrigin.host;
    if (headers.origin) headers.origin = 'https://app.alicerealm.com';
  }
  const client = apiOrigin.protocol === 'https:' ? https : http;
  const upstream = client.request({
    protocol: apiOrigin.protocol,
    hostname: apiOrigin.hostname,
    port: apiOrigin.port || (apiOrigin.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    timeout: 12_000,
  }, (upstreamResponse) => {
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(name)) response.setHeader(name, value);
    }
    response.setHeader('Cache-Control', 'private, no-store');
    response.writeHead(upstreamResponse.statusCode || 502);
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('API timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'GATEWAY_UNAVAILABLE', message: 'AliceRealm gateway unavailable' } }));
  });
  request.pipe(upstream);
}

function resolveAsset(pathname) {
  const requested = pathname.replace(/^\/+/, '');
  if (!requested || pathname.startsWith('/dashboard') || pathname.startsWith('/local/')) return join(root, 'index.html');
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = join(root, safePath);
  if (!candidate.startsWith(root) || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

export const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (bridge && (url.pathname.startsWith('/local/v1/') || url.pathname.startsWith('/bridge/v1/'))) {
    try {
      const handled = await bridge.handle(request, response, url);
      if (handled !== false) return;
    } catch (error) {
      if (response.headersSent) return response.end();
      response.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      return response.end(JSON.stringify({ error: { code: 'LOCAL_BRIDGE_ERROR', message: error.message } }));
    }
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxyAPI(request, response, url);
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  const asset = resolveAsset(url.pathname);
  if (!asset) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  const extension = extname(asset).toLowerCase();
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(asset).pipe(response);
});

server.listen(port, host, () => {
  bridge?.writeState();
  console.log(`AliceRealm user app listening on http://${host}:${port}`);
  if (bridge) console.log(`AliceRealm local approval UI is ready on ${bridge.baseURL}`);
});

function shutdown() {
  bridge?.removeState();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { bridge };
