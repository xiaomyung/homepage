/**
 * Homepage stats shim — proxies node-exporter and docker into one JSON endpoint.
 *
 * Bound to 127.0.0.1:5055; exposed to the browser via Caddy at /api/stats.
 * The page is Tailscale/LAN-only so internal stats are safe to expose.
 *
 * Port of stats/app.py to Node — zero external dependencies.
 */

import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';

const NODE_EXPORTER_URL = 'http://localhost:9100/metrics';
const HOST = '127.0.0.1';
const PORT = 5055;

const METRIC_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)(\{[^}]*\})?\s+(\S+)/;
const LABEL_RE = /(\w+)="((?:[^"\\]|\\.)*)"/g;

function parseProm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = METRIC_RE.exec(line);
    if (!m) continue;
    const value = parseFloat(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (m[2]) {
      for (const lm of m[2].matchAll(LABEL_RE)) labels[lm[1]] = lm[2];
    }
    out.push({ name: m[1], labels, value });
  }
  return out;
}

function findOne(metrics, name, labels) {
  for (const m of metrics) {
    if (m.name !== name) continue;
    if (labels && !Object.entries(labels).every(([k, v]) => m.labels[k] === v)) continue;
    return m;
  }
  return null;
}

function findAll(metrics, name, labels) {
  const out = [];
  for (const m of metrics) {
    if (m.name !== name) continue;
    if (labels && !Object.entries(labels).every(([k, v]) => m.labels[k] === v)) continue;
    out.push(m);
  }
  return out;
}

function diskFor(metrics, mount) {
  const size = findOne(metrics, 'node_filesystem_size_bytes', { mountpoint: mount });
  const avail = findOne(metrics, 'node_filesystem_avail_bytes', { mountpoint: mount });
  if (!size || !avail || size.value === 0) {
    return { used_gb: null, total_gb: null, pct: null };
  }
  const used = size.value - avail.value;
  return {
    used_gb: Math.round(used / 1e9 * 10) / 10,
    total_gb: Math.round(size.value / 1e9 * 10) / 10,
    pct: Math.round(used / size.value * 100),
  };
}

function dockerCounts() {
  return new Promise((resolve) => {
    // execFile is used (not exec) — no shell interpolation, safe against injection.
    execFile('docker', ['ps', '-a', '--format', '{{.Status}}'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ total: null, running: null, unhealthy: null, stopped: null, other: null });
        return;
      }
      const statuses = stdout.split('\n').filter((s) => s.trim());
      const running = statuses.filter((s) => s.startsWith('Up')).length;
      const unhealthy = statuses.filter((s) => s.includes('unhealthy')).length;
      const stopped = statuses.filter((s) => s.startsWith('Exited')).length;
      const other = statuses.length - running - stopped;
      resolve({ total: statuses.length, running, unhealthy, stopped, other });
    });
  });
}

async function handleStats(req, res) {
  let metricsText;
  try {
    const r = await fetch(NODE_EXPORTER_URL, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`${r.status}`);
    metricsText = await r.text();
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'node-exporter unreachable' }));
    return;
  }

  const metrics = parseProm(metricsText);

  const boot = findOne(metrics, 'node_boot_time_seconds');
  const now = findOne(metrics, 'node_time_seconds');
  const uptime = (boot && now) ? Math.floor(now.value - boot.value) : null;

  const load1 = findOne(metrics, 'node_load1');
  const load5 = findOne(metrics, 'node_load5');
  const load15 = findOne(metrics, 'node_load15');

  const cpuTemp = findOne(metrics, 'node_hwmon_temp_celsius', {
    chip: 'platform_coretemp_0', sensor: 'temp1',
  });

  const memTotal = findOne(metrics, 'node_memory_MemTotal_bytes');
  const memFree = findOne(metrics, 'node_memory_MemFree_bytes');
  const memBuffers = findOne(metrics, 'node_memory_Buffers_bytes');
  const memCached = findOne(metrics, 'node_memory_Cached_bytes');
  const memSreclaim = findOne(metrics, 'node_memory_SReclaimable_bytes');
  const memShmem = findOne(metrics, 'node_memory_Shmem_bytes');

  let ramUsedGb = null;
  let ramTotalGb = null;
  if ([memTotal, memFree, memBuffers, memCached, memSreclaim, memShmem].every(Boolean)) {
    const used = memTotal.value - memFree.value - memBuffers.value
      - memCached.value - memSreclaim.value + memShmem.value;
    ramUsedGb = Math.round(used / 1e9 * 10) / 10;
    ramTotalGb = Math.round(memTotal.value / 1e9 * 10) / 10;
  }

  const drives = [];
  const nvmeTemp = findOne(metrics, 'node_hwmon_temp_celsius', {
    chip: 'nvme_nvme0', sensor: 'temp1',
  });
  if (nvmeTemp) drives.push({ dev: 'nvme0', temp_c: Math.floor(nvmeTemp.value), idle: false });

  const tempsByDev = new Map();
  for (const m of findAll(metrics, 'smart_device_temperature_celsius')) {
    const dev = (m.labels.device || '').replace('/dev/', '');
    if (dev) tempsByDev.set(dev, m.value);
  }
  for (const m of findAll(metrics, 'smart_device_active')) {
    const dev = (m.labels.device || '').replace('/dev/', '');
    if (!dev) continue;
    if (m.value === 0) {
      drives.push({ dev, temp_c: null, idle: true });
    } else {
      const t = tempsByDev.get(dev);
      drives.push({ dev, temp_c: t != null ? Math.floor(t) : null, idle: false });
    }
  }

  const docker = await dockerCounts();

  const body = {
    host: os.hostname(),
    uptime_seconds: uptime,
    load: [load1?.value ?? null, load5?.value ?? null, load15?.value ?? null],
    cpu_temp_c: cpuTemp ? Math.floor(cpuTemp.value) : null,
    ram_used_gb: ramUsedGb,
    ram_total_gb: ramTotalGb,
    disk: {
      system: diskFor(metrics, '/'),
      storage: diskFor(metrics, '/mnt/storage'),
      cloud: diskFor(metrics, '/mnt/cloud'),
    },
    drives,
    docker,
  };

  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (req.method === 'GET' && pathname === '/api/stats') {
    handleStats(req, res).catch((err) => {
      process.stderr.write(`[homepage-stats] error: ${err?.stack || err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[homepage-stats] listening on ${HOST}:${PORT}\n`);
});
