async function checkService(card) {
  const dot = card.querySelector('.dot');
  const label = card.querySelector('.status-label');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(card.dataset.check, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (res.status >= 500) throw new Error(res.status);
    dot.className = 'dot up';
    label.textContent = 'online';
  } catch {
    clearTimeout(timeout);
    dot.className = 'dot down';
    label.textContent = 'offline';
  }
}

async function run() {
  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((card, i) => card.style.setProperty('--i', i));
  await Promise.all([
    ...cards.filter(c => c.dataset.check).map(checkService),
    loadStats(),
  ]);
  updateBanner();
}

run();
setInterval(run, 30000);

/* ── Banner: live counts + clock ── */

const setText = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null ? '—' : value;
};

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function nowString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatUptime(seconds) {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `↑ ${d}d ${h}h ${m}m`;
}

function updateBanner() {
  setText('hdr-time', nowString());
}

/* ── Stats shim (live infra panel) ── */

const fmtBytes = (gb) => gb == null ? '—' : (gb >= 1000 ? (gb / 1000).toFixed(1) + 'T' : gb.toFixed(1) + 'G');

async function loadStats() {
  let s;
  try {
    const r = await fetch('/api/stats', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    s = await r.json();
  } catch {
    ['hdr-load', 'hdr-cpu-temp', 'hdr-ram', 'hdr-system', 'hdr-storage',
     'hdr-cloud', 'hdr-drives', 'hdr-docker', 'hdr-uptime'].forEach(id => setText(id, '—'));
    return;
  }

  setText('hdr-load', s.load && s.load[0] != null
    ? s.load.map(x => x.toFixed(2)).join('  ')
    : '—');
  setText('hdr-cpu-temp', s.cpu_temp_c != null ? s.cpu_temp_c + '°C' : '—');
  setText('hdr-ram', s.ram_used_gb != null && s.ram_total_gb
    ? `${fmtBytes(s.ram_used_gb)} / ${fmtBytes(s.ram_total_gb)}  (${Math.round(s.ram_used_gb / s.ram_total_gb * 100)}%)`
    : '—');

  const disk = (d) => d && d.total_gb != null
    ? `${fmtBytes(d.used_gb)} / ${fmtBytes(d.total_gb)}  (${d.pct}%)`
    : '—';
  setText('hdr-system',  disk(s.disk && s.disk.system));
  setText('hdr-storage', disk(s.disk && s.disk.storage));
  setText('hdr-cloud',   disk(s.disk && s.disk.cloud));

  setText('hdr-drives', s.drives && s.drives.length
    ? s.drives.map(x => x.idle ? `${x.dev} idle` : `${x.dev} ${x.temp_c}°C`).join(' · ')
    : '—');

  const dk = s.docker || {};
  if (dk.running != null) {
    const parts = [`${dk.running}↑`];
    if (dk.stopped)   parts.push(`${dk.stopped} stopped`);
    if (dk.unhealthy) parts.push(`${dk.unhealthy} unhealthy`);
    if (dk.other)     parts.push(`${dk.other} other`);
    setText('hdr-docker', parts.join(' · '));
  } else {
    setText('hdr-docker', '—');
  }

  setText('hdr-uptime', formatUptime(s.uptime_seconds));
}

/* ── Cap grids at 2.2 visible cards ── */

function capGrids() {
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-gap')) || 8;
  document.querySelectorAll('.grid').forEach(grid => {
    const cards = grid.querySelectorAll('.card');
    if (cards.length < 3) { grid.style.maxHeight = ''; return; }
    const cardH = cards[0].offsetHeight;
    grid.style.maxHeight = `${cardH * 2.2 + gap * 2}px`;
  });
}

capGrids();
window.addEventListener('resize', capGrids);
