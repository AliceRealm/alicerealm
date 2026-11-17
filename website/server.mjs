import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const port = Number.parseInt(process.env.WEBSITE_PORT || '4173', 10);
const host = process.env.WEBSITE_HOST || '127.0.0.1';
const apiOrigin = new URL(process.env.ALICEREALM_API_ORIGIN || 'http://127.0.0.1:8080');
const installDocument = join(repoRoot, 'skills', 'install.md');
const releaseRoot = process.env.ALICEREALM_RELEASE_ROOT || join(repoRoot, 'build', 'updates');

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const proxiedFiles = new Set(['/bootstrap.md', '/install.ps1', '/install.sh', '/uninstall.ps1', '/uninstall.sh']);

function setSecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function isGatewayPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/r/') || proxiedFiles.has(pathname);
}

function proxyGateway(request, response, url) {
  const headers = { ...request.headers, host: apiOrigin.host };
  delete headers.connection;
  delete headers['proxy-connection'];
  const upstream = http.request({
    hostname: apiOrigin.hostname,
    port: apiOrigin.port || 80,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    timeout: 8_000,
  }, (upstreamResponse) => {
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(name)) {
        response.setHeader(name, value);
      }
    }
    response.setHeader('Cache-Control', 'no-store');
    response.writeHead(upstreamResponse.statusCode || 502);
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('API timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ code: 502, msg: 'AliceRealm gateway unavailable' }));
  });
  request.pipe(upstream);
}

function resolveAsset(pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = join(root, safePath);
  if (!candidate.startsWith(root) || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

function resolveReleaseAsset(pathname) {
  if (!pathname.startsWith('/cli/') && !pathname.startsWith('/skills/') && !pathname.startsWith('/installers/')) return null;
  const safePath = normalize(pathname.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = join(releaseRoot, safePath);
  if (!candidate.startsWith(releaseRoot) || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

const server = http.createServer((request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (isGatewayPath(url.pathname)) {
    proxyGateway(request, response, url);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  if (url.pathname === '/install.md') {
    response.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(installDocument).pipe(response);
    return;
  }

  const releaseAsset = resolveReleaseAsset(url.pathname);
  if (releaseAsset) {
    const immutable = /^\/cli\/\d+\.\d+\.\d+\//.test(url.pathname);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(releaseAsset).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(releaseAsset).pipe(response);
    return;
  }

  const asset = resolveAsset(url.pathname);
  if (!asset) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const extension = extname(asset).toLowerCase();
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(asset).pipe(response);
});

server.listen(port, host, () => {
  console.log(`AliceRealm website listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
