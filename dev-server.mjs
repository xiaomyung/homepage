/**
 * Local dev server — static files + reverse proxy.
 *
 * Usage:
 *   node dev-server.mjs
 *   open http://localhost:8000
 *
 * Proxies /api/stats* → 127.0.0.1:5055 (stats shim, homelab only)
 *
 * No dependencies — uses only Node built-ins.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PROXIES = [
  { prefix: '/api/stats', target: 'http://127.0.0.1:5055' },
];

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

async function proxy(req, res, target) {
  const url = target + req.url;
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
    ? await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); })
    : undefined;
  try {
    const r = await fetch(url, { method: req.method, headers, body });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${err.message}\n`);
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  for (const { prefix, target } of PROXIES) {
    if (req.url.startsWith(prefix)) return void proxy(req, res, target);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  process.stdout.write(`dev server at http://localhost:${PORT}\n`);
});
