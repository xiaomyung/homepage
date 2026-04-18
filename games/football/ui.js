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

import {
  PHASE_TRAINING,
  PHASE_RELOADING,
  PHASE_DONE,
  phaseAfterStatsPoll,
} from './api/reset-client.js';
import { DEFAULT_DOT_INTERVAL_MS, RESPAWN_STAGE, RELOAD_STAGE } from './api/reset-pipeline.js';
import { runWarmStart } from './warm-start-orchestrator.js';
import { WARM_START_HYPERPARAMS } from './evolution/warm-start-lib.js';

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

/**
 * The start button has three states:
 *   - unseeded:  broker has no population (fresh clone / deleted
 *                warm_start_weights.json) → clicking kicks off the
 *                full reset pipeline with cycling-dots progress, then
 *                hard-reloads the page
 *   - idle:      seeded, not running → clicking spawns workers
 *   - running:   workers spawned → clicking stops them
 */
export function createStartStopButton({ apiBase, onStart, onStop, renderLabel, renderReloading, getWorkerCount }) {
  const btn = document.getElementById('game-start-btn');
  let running = false;
  let seeded = true;  // optimistic until first /stats poll says otherwise

  const render = () => {
    if (!seeded) {
      btn.textContent = '[ seed ]';
      btn.dataset.running = 'false';
      btn.title = 'Population is empty. Click to train warm-start seed and initialize.';
      return;
    }
    btn.textContent = running ? '[ stop ]' : '[ start ]';
    btn.dataset.running = running ? 'true' : 'false';
    btn.title = '';
  };

  btn.addEventListener('click', async () => {
    if (!seeded) {
      btn.disabled = true;
      await runResetPipelineWithProgress(apiBase, btn, {
        renderLabel,
        renderReloading,
        workerCount: getWorkerCount?.() ?? 1,
      });
      return;  // page reloads on completion
    }
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
    setSeeded(next) {
      if (next === seeded) return;
      seeded = next;
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
    runtime: document.getElementById('stat-runtime'),
    gen: document.getElementById('stat-gen'),
    avg: document.getElementById('stat-avg'),
    top: document.getElementById('stat-top'),
    sps: document.getElementById('stat-sps'),
    matches: document.getElementById('stat-matches'),
    pop: document.getElementById('stat-pop'),
    mut: document.getElementById('stat-mut'),
    fbwr: document.getElementById('stat-fbwr'),
    zerozero: document.getElementById('stat-zerozero'),
    draws: document.getElementById('stat-draws'),
    decisive: document.getElementById('stat-decisive'),
    blowout: document.getElementById('stat-blowout'),
  };

  let simsPerSec = 0;
  let spsDecay = 0; // ticks since the last worker report; decays display to 0

  /** Format a millisecond duration as a compact H:MM:SS (or M:SS below
   *  one hour) so the runtime cell stays narrow. */
  function formatRuntime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const ss = s.toString().padStart(2, '0');
    if (h > 0) {
      const mm = m.toString().padStart(2, '0');
      return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
  }

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
      el.fbwr.textContent = `${(stats.fallback_win_rate * 100).toFixed(1)}%`;
      const md = stats.match_distribution;
      const pctTxt = (r) => md && md.total > 0 ? `${(r * 100).toFixed(1)}%` : '—';
      if (el.zerozero) el.zerozero.textContent = pctTxt(md?.zero_zero_rate);
      if (el.draws)    el.draws.textContent    = pctTxt(md?.nonzero_draw_rate);
      if (el.decisive) el.decisive.textContent = pctTxt(md?.decisive_rate);
      if (el.blowout)  el.blowout.textContent  = pctTxt(md?.blowout_rate);
      // `runtime_ms` is the broker-authoritative cumulative active
      // training time since the last reset — shared across tabs and
      // devices, persisted across broker restarts and page reloads.
      if (typeof stats.runtime_ms === 'number' && el.runtime) {
        el.runtime.textContent = formatRuntime(stats.runtime_ms);
      }
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
  const LABEL_FONT = '11px "Iosevka Term", monospace';
  const LABEL_MIN_GAP = 13;

  /** Resize the canvas backing store to match its CSS box × devicePixelRatio,
   *  then reset the 2D context transform so subsequent draw calls use CSS
   *  pixel coordinates. Returns the CSS-pixel dimensions (or null when the
   *  canvas is hidden / not laid out yet, in which case drawing is a no-op). */
  function syncDPR() {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    if (cssW <= 0 || cssH <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);
    if (canvas.width !== bufW)  canvas.width  = bufW;
    if (canvas.height !== bufH) canvas.height = bufH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  function draw() {
    const dims = syncDPR();
    if (!dims) return;
    const { w, h } = dims;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) {
      ctx.fillStyle = color.muted;
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('no history yet', w / 2, h / 2);
      return;
    }

    // Broker returns history oldest → newest (ASC), already stride-
    // downsampled to at most ~512 points spanning the full run. No
    // local reverse or resample needed — just plot left-to-right.
    const data = history;
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

  // Redraw whenever the canvas box changes (DPR shift, panel open, window
  // resize) so the backing store stays in step with the CSS layout.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => draw()).observe(canvas);
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
  // Default is the full hardware count so training ramps up to the
  // client's maximum throughput the moment [start] is pressed — users
  // who want to throttle back can step down manually. No artificial
  // ceiling: a 16-thread CPU should get 16 workers if it asks for them.
  const hardwareMax = Math.max(1, navigator.hardwareConcurrency || 4);
  let workerCount = hardwareMax;
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
 * Drive a button's label through the full reset pipeline. Used by
 * both the reset button and the start button (when the broker has
 * population=0 on a fresh install).
 *
 * Flow:
 *   1. Orchestrator spawns N Web Workers (N = configured count) that
 *      each run one epoch of SGD on their shard; main thread averages
 *      their weights per epoch. ~N× faster than single-worker.
 *   2. On completion: POST averaged weights to /reset?hard=1.
 *   3. Broker wipes, seeds from the POSTed weights, exits → systemd respawn.
 *   4. Client polls /stats waiting for the respawned broker.
 *   5. Cache-bust reload.
 */
function runResetPipelineWithProgress(apiBase, btn, {
  renderLabel,
  renderReloading,
  workerCount,
  epochs = WARM_START_HYPERPARAMS.epochs,
  matches = WARM_START_HYPERPARAMS.matches,
  ticksPerMatch = WARM_START_HYPERPARAMS.ticksPerMatch,
  baseSeed = WARM_START_HYPERPARAMS.baseSeed,
}) {
  const pollIntervalMs = 300;
  const dotIntervalMs = DEFAULT_DOT_INTERVAL_MS;
  const currentStage = 'training seed';
  const stageStartedAt = Date.now();
  let phase = PHASE_TRAINING;
  let currentProgress = null;
  let reloadingStartedAt = 0;
  let reloadingStage = RESPAWN_STAGE;
  let lastPoll = 0;

  const trainPromise = runWarmStart({
    workerCount,
    workerUrl: new URL('./warm-start-worker.js', import.meta.url),
    epochs,
    matches,
    ticksPerMatch,
    baseSeed,
    onProgress: ({ current, total }) => {
      currentProgress = { current, total };
    },
  });

  // Handle orchestrator completion separately from the animation loop
  // so a slow POST doesn't stall the label animation. Every outcome
  // (ok, HTTP error, network error) transitions to RELOADING — the
  // broker exits on hard=1 so a network error is expected, and we
  // want a fresh load either way.
  const afterTrain = (async () => {
    try {
      const { weights } = await trainPromise;
      await fetch(`${apiBase}/reset?hard=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weights: Array.from(weights) }),
      });
    } catch (err) {
      console.error('[reset] warm-start failed:', err);
    }
    phase = PHASE_RELOADING;
    reloadingStartedAt = Date.now();
  })();
  afterTrain.catch(() => { /* already handled */ });

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const now = Date.now();

      if (phase === PHASE_TRAINING) {
        const elapsed = now - stageStartedAt;
        btn.textContent = renderLabel(currentStage, elapsed, dotIntervalMs, currentProgress);
      } else if (phase === PHASE_RELOADING) {
        const elapsed = now - reloadingStartedAt;
        btn.textContent = renderReloading(reloadingStage, elapsed, dotIntervalMs);
        if (now - lastPoll >= pollIntervalMs) {
          lastPoll = now;
          fetch(`${apiBase}/stats`, { cache: 'no-store' })
            .then((res) => {
              if (res.ok) {
                // Broker is back. Flip to the "reloading page" label and
                // hold for a beat — otherwise the DONE branch fires on
                // the next tick and the browser navigates before the new
                // label ever paints, leaving "restarting broker" on
                // screen right up to the unload. 250ms is perceptible
                // against a ~5 s wait without feeling like added drag.
                reloadingStage = RELOAD_STAGE;
                reloadingStartedAt = Date.now();
                setTimeout(() => { phase = PHASE_DONE; }, 250);
                return;
              }
              phase = phaseAfterStatsPoll({ ok: false, networkError: false });
            })
            .catch(() => {
              phase = phaseAfterStatsPoll({ ok: false, networkError: true });
            });
        }
      } else if (phase === PHASE_DONE) {
        clearInterval(timer);
        const url = new URL(window.location.href);
        url.searchParams.set('_cb', Date.now().toString(36));
        window.location.replace(url.toString());
        resolve();
      }
    }, 100);
  });
}

export function createResetButton({ apiBase, renderLabel, renderReloading, getWorkerCount }) {
  const btn = document.getElementById('game-reset-btn');
  btn.addEventListener('click', async () => {
    if (!confirm('Nuke the training run? Broker restarts and the page reloads with a cache-bust.')) return;
    btn.disabled = true;
    await runResetPipelineWithProgress(apiBase, btn, {
      renderLabel,
      renderReloading,
      workerCount: getWorkerCount?.() ?? 1,
    });
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
