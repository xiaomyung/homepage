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
    setTimer(seconds, totalSeconds) {
      const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      };
      el.timer.textContent = totalSeconds != null
        ? `${fmt(seconds)} / ${fmt(totalSeconds)}`
        : fmt(seconds);
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
  // style.css variables without hard-coding hex values. Monochrome:
  // `top` uses bright --text, `avg` uses the dimmer --text-dim so the
  // two series are distinguishable purely by brightness — no hue.
  const rootStyle = getComputedStyle(document.documentElement);
  const color = {
    top: rootStyle.getPropertyValue('--text').trim() || '#d0d0d0',
    avg: rootStyle.getPropertyValue('--text-dim').trim() || '#707070',
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

  // Right-side padding reserved for the endpoint labels ("top 0.83" /
  // "avg 0.33") that double as the color legend — wider than a pure
  // number so the key word survives on narrow layouts.
  const RIGHT_PAD = 64;
  const LABEL_FONT = '10px "Iosevka Term", monospace';
  const LABEL_MIN_GAP = 12;

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) {
      ctx.fillStyle = color.muted;
      ctx.font = LABEL_FONT;
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

    const plotW = w - RIGHT_PAD;
    const n = data.length;
    const x = (i) => (i / Math.max(1, n - 1)) * (plotW - 2) + 1;
    const y = (v) => h - ((v - yMin) / range) * (h - 4) - 2;

    // Zero line (dashed) — only spans the plot area, not the label gutter
    ctx.strokeStyle = color.dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(plotW, y(0));
    ctx.stroke();
    ctx.setLineDash([]);

    const drawSeries = (series, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const px = x(i);
        const py = y(series[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    drawSeries(avgs, color.avg);
    drawSeries(tops, color.top);

    // Endpoint labels — colored to match each series, positioned at the
    // final data point's y with a small horizontal offset into the
    // reserved right gutter. If both labels would collide vertically,
    // nudge them apart so neither occludes the other.
    const lastAvgY = y(avgs[n - 1]);
    const lastTopY = y(tops[n - 1]);
    let avgLabelY = lastAvgY;
    let topLabelY = lastTopY;
    if (Math.abs(avgLabelY - topLabelY) < LABEL_MIN_GAP) {
      const mid = (avgLabelY + topLabelY) / 2;
      if (avgs[n - 1] < tops[n - 1]) {
        avgLabelY = mid + LABEL_MIN_GAP / 2;
        topLabelY = mid - LABEL_MIN_GAP / 2;
      } else {
        avgLabelY = mid - LABEL_MIN_GAP / 2;
        topLabelY = mid + LABEL_MIN_GAP / 2;
      }
    }
    const labelX = plotW + 4;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color.top;
    ctx.fillText(`top ${tops[n - 1].toFixed(2)}`, labelX, topLabelY);
    ctx.fillStyle = color.avg;
    ctx.fillText(`avg ${avgs[n - 1].toFixed(2)}`, labelX, avgLabelY);
  }

  poll();
  setInterval(poll, pollIntervalMs);

  return { refresh: poll };
}

/* ── Config sliders + reset button ──────────────────────── */

/**
 * Binds the client-side worker-count stepper buttons. Match duration and
 * mutation rate are fixed at the broker's /config defaults — the UI no
 * longer surfaces them. Returns a handle with `getWorkerCount()` so
 * main.js can spawn workers to match the current stepper value.
 */
export function createConfigControls() {
  const workerStepper = {
    dec: document.getElementById('cfg-workers-dec'),
    inc: document.getElementById('cfg-workers-inc'),
    val: document.getElementById('cfg-workers-val'),
  };

  // Worker count is a client-side-only setting clamped to [1, hardwareMax].
  const hardwareMax = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  let workerCount = Math.max(1, Math.floor(hardwareMax / 2));
  const workerChangeListeners = [];
  const renderWorkerStepper = () => {
    workerStepper.val.textContent = workerCount;
    workerStepper.dec.disabled = workerCount <= 1;
    workerStepper.inc.disabled = workerCount >= hardwareMax;
  };
  const setWorkerCount = (n) => {
    const clamped = Math.max(1, Math.min(hardwareMax, n));
    if (clamped === workerCount) return;
    workerCount = clamped;
    renderWorkerStepper();
    for (const fn of workerChangeListeners) fn(workerCount);
  };
  workerStepper.dec.addEventListener('click', () => setWorkerCount(workerCount - 1));
  workerStepper.inc.addEventListener('click', () => setWorkerCount(workerCount + 1));
  renderWorkerStepper();

  return {
    getWorkerCount: () => workerCount,
    onWorkerCountChange: (fn) => workerChangeListeners.push(fn),
  };
}

/* ── Free camera toggle ─────────────────────────────────── */

/**
 * Wires the options-panel freecam toggle to the renderer's debug cam.
 * Shows a keybind help block while freecam is active. Mutually
 * exclusive with follow-cam — the renderer disables one when the
 * other is enabled, so we re-sync both buttons on every toggle.
 */
export function createFreeCamToggle({ renderer, onChange }) {
  const btn = document.getElementById('game-freecam-btn');
  const help = document.getElementById('game-freecam-help');
  if (!btn || !help) return null;
  const render = () => {
    const on = renderer.isDebugCamActive();
    btn.textContent = on ? '[ freecam: on ]' : '[ freecam: off ]';
    btn.dataset.active = on ? 'true' : 'false';
    help.dataset.open = on ? 'true' : 'false';
  };
  btn.addEventListener('click', () => {
    renderer.setDebugCam(!renderer.isDebugCamActive());
    render();
    onChange?.();
  });
  render();
  return { refresh: render };
}

/* ── Follow-ball camera toggle ──────────────────────────── */

/**
 * Wires the options-panel follow-ball toggle to the renderer.
 * Mutually exclusive with freecam — see createFreeCamToggle.
 */
export function createFollowCamToggle({ renderer, onChange }) {
  const btn = document.getElementById('game-followcam-btn');
  if (!btn) return null;
  const render = () => {
    const on = renderer.isFollowCamActive();
    btn.textContent = on ? '[ follow ball: on ]' : '[ follow ball: off ]';
    btn.dataset.active = on ? 'true' : 'false';
  };
  btn.addEventListener('click', () => {
    renderer.setFollowCam(!renderer.isFollowCamActive());
    render();
    onChange?.();
  });
  render();
  return { refresh: render };
}

/**
 * Wires the reset button to POST /reset after a confirmation dialog.
 * On success, calls the provided callback (usually to refresh local state).
 */
export function createResetButton({ apiBase, onReset }) {
  const btn = document.getElementById('game-reset-btn');
  btn.addEventListener('click', async () => {
    if (!confirm('Reset the population and start over from the warm-start seed?')) return;
    try {
      const res = await fetch(`${apiBase}/reset`, { method: 'POST' });
      if (res.ok) onReset?.();
    } catch {
      /* ignore */
    }
  });
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
