/**
 * Football v2 — UI wiring.
 *
 * Binds the DOM elements authored in index.html to the game loop.
 * Covers:
 *   - Scoreboard (tags, names, score, timer)
 *   - Start/Stop button
 *   - Options button + panel toggle (panel contents wired in ui_options.js
 *     in phase 4d2/4d3)
 *   - Auto-pause via visibilitychange + pagehide + pageshow
 *
 * Design: pure functions + small handle objects. No single god-class.
 * main.js composes the pieces and holds the top-level state.
 */

/* ── Scoreboard ─────────────────────────────────────────── */

export function createScoreboard() {
  const el = {
    p1Tag: document.getElementById('game-p1-tag'),
    p1Name: document.getElementById('game-p1-name'),
    p2Tag: document.getElementById('game-p2-tag'),
    p2Name: document.getElementById('game-p2-name'),
    score: document.getElementById('game-score'),
    timer: document.getElementById('game-timer'),
  };

  return {
    setMatchup(p1, p2Source) {
      el.p1Tag.textContent = '[nn]';
      el.p1Name.textContent = (p1?.name ?? '—').toLowerCase();
      if (p2Source && p2Source.type === 'fallback') {
        el.p2Tag.textContent = '[fb]';
        el.p2Name.textContent = 'fallback';
      } else {
        el.p2Tag.textContent = '[nn]';
        el.p2Name.textContent = (p2Source?.name ?? '—').toLowerCase();
      }
    },
    setScore(scoreL, scoreR) {
      el.score.textContent = `${scoreL} — ${scoreR}`;
    },
    setTimer(seconds) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      el.timer.textContent =
        `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    },
  };
}

/* ── Start/Stop button ──────────────────────────────────── */

export function createStartStopButton({ onStart, onStop }) {
  const btn = document.getElementById('game-start-btn');
  let running = false;

  const render = () => {
    btn.textContent = running ? '[ stop ]' : '[ start ]';
    btn.dataset.running = running ? 'true' : 'false';
  };

  btn.addEventListener('click', () => {
    if (running) {
      running = false;
      render();
      onStop?.();
    } else {
      running = true;
      render();
      onStart?.();
    }
  });

  render();

  return {
    setRunning(next) {
      if (next === running) return;
      running = next;
      render();
    },
    isRunning() {
      return running;
    },
  };
}

/* ── Options button (panel toggle) ──────────────────────── */

export function createOptionsToggle() {
  const btn = document.getElementById('game-options-btn');
  const panel = document.getElementById('game-options-panel');
  let open = false;

  const render = () => {
    btn.textContent = open ? '[ close ]' : '[ options ]';
    panel.dataset.open = open ? 'true' : 'false';
  };

  btn.addEventListener('click', () => {
    open = !open;
    render();
  });

  render();

  return {
    isOpen: () => open,
    setOpen(next) {
      if (next === open) return;
      open = next;
      render();
    },
  };
}

/* ── Stats panel ────────────────────────────────────────── */

/**
 * Polls /api/football/stats (and /config for mutation rate) and updates
 * the corresponding <dd> elements in the options panel. Stats are shown
 * whether the panel is open or closed — it's cheap, and the polling
 * stops naturally when the page is closed.
 *
 * Returns a handle with a `setSimsPerSec(value)` method so the training
 * worker can feed sim throughput without going through the API.
 */
export function createStatsPanel({ apiBase, pollIntervalMs = 2000 }) {
  const el = {
    gen: document.getElementById('stat-gen'),
    avg: document.getElementById('stat-avg'),
    top: document.getElementById('stat-top'),
    sps: document.getElementById('stat-sps'),
    matches: document.getElementById('stat-matches'),
    pop: document.getElementById('stat-pop'),
    mut: document.getElementById('stat-mut'),
    fbwr: document.getElementById('stat-fbwr'),
  };

  let simsPerSec = 0;
  let spsDecay = 0; // ticks since the last worker report; decays display to 0

  async function pollStats() {
    try {
      const res = await fetch(`${apiBase}/stats`);
      if (!res.ok) return;
      const stats = await res.json();
      el.gen.textContent = stats.generation;
      el.avg.textContent = stats.avg_fitness.toFixed(3);
      el.top.textContent = stats.top_fitness.toFixed(3);
      el.matches.textContent = stats.total_matches;
      el.pop.textContent = stats.population;
      el.fbwr.textContent = (stats.fallback_win_rate * 100).toFixed(1) + '%';
    } catch {
      /* ignore network blips */
    }
  }

  async function pollConfig() {
    try {
      const res = await fetch(`${apiBase}/config`);
      if (!res.ok) return;
      const cfg = await res.json();
      el.mut.textContent = cfg.mutation_rate.toFixed(2);
    } catch {
      /* ignore */
    }
  }

  function updateSpsDisplay() {
    // Sims/s decays to 0 if no recent worker reports (worker stopped)
    spsDecay++;
    if (spsDecay > 3) simsPerSec = 0;
    el.sps.textContent = simsPerSec.toFixed(0);
  }

  pollStats();
  pollConfig();
  setInterval(pollStats, pollIntervalMs);
  setInterval(pollConfig, pollIntervalMs * 4); // config changes less often
  setInterval(updateSpsDisplay, pollIntervalMs);

  return {
    setSimsPerSec(value) {
      simsPerSec = value;
      spsDecay = 0;
    },
  };
}

/* ── Fitness history graph ──────────────────────────────── */

/**
 * Draws a 1px Canvas2D line graph of avg/top fitness over the last N
 * generations. Auto-scales the Y axis; dashed zero line in text-dim.
 * Polls /api/football/history periodically.
 */
export function createFitnessGraph({ apiBase, pollIntervalMs = 5000 }) {
  const canvas = document.getElementById('game-fitness-canvas');
  const ctx = canvas.getContext('2d');

  // Resolve palette colors from the document root so the graph picks up
  // style.css variables without hard-coding hex values.
  const rootStyle = getComputedStyle(document.documentElement);
  const color = {
    green: rootStyle.getPropertyValue('--green').trim() || '#9ece6a',
    amber: rootStyle.getPropertyValue('--amber').trim() || '#e0af68',
    dim: rootStyle.getPropertyValue('--text-dim').trim() || '#707070',
    muted: rootStyle.getPropertyValue('--muted').trim() || '#505050',
  };

  let history = [];

  async function poll() {
    try {
      const res = await fetch(`${apiBase}/history`);
      if (!res.ok) return;
      history = await res.json();
      draw();
    } catch {
      /* ignore */
    }
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) {
      ctx.fillStyle = color.muted;
      ctx.font = '10px "Iosevka Term", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('no history yet', w / 2, h / 2);
      return;
    }

    // History is returned newest first (DESC by gen); reverse for left-to-right plot
    const data = history.slice().reverse();
    const avgs = data.map((d) => d.avg);
    const tops = data.map((d) => d.top);
    const all = avgs.concat(tops);
    const yMin = Math.min(...all, 0);
    const yMax = Math.max(...all, 1);
    const range = Math.max(0.01, yMax - yMin);

    const n = data.length;
    const x = (i) => (i / Math.max(1, n - 1)) * (w - 2) + 1;
    const y = (v) => h - ((v - yMin) / range) * (h - 4) - 2;

    // Zero line (dashed)
    ctx.strokeStyle = color.dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(w, y(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Avg (green)
    ctx.strokeStyle = color.green;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = x(i);
      const py = y(avgs[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Top (amber)
    ctx.strokeStyle = color.amber;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = x(i);
      const py = y(tops[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  poll();
  setInterval(poll, pollIntervalMs);

  return { refresh: poll };
}

/* ── Auto-pause gate ────────────────────────────────────── */

/**
 * Installs visibility listeners. Calls `onAway` when the tab becomes
 * hidden or navigates away (including bfcache pagehide). NEVER calls
 * anything on return — the user must explicitly click Start to resume.
 *
 * Returns an `uninstall` function for tests.
 */
export function installAutoPause(onAway) {
  const handler = () => {
    if (document.hidden) onAway?.();
  };
  const pageHideHandler = () => onAway?.();

  document.addEventListener('visibilitychange', handler);
  window.addEventListener('pagehide', pageHideHandler);
  // pageshow is deliberately NOT wired to resume — resume is always manual.

  return () => {
    document.removeEventListener('visibilitychange', handler);
    window.removeEventListener('pagehide', pageHideHandler);
  };
}
