/**
 * Football v2 — main entry point.
 *
 * Composes all the pieces:
 *   - atlas.js:     Iosevka SDF atlas (one-time at boot, IndexedDB cached)
 *   - renderer.js:  three.js scene + glyph instances
 *   - physics.js:   tick function (showcase runs in main thread)
 *   - nn.js:        NN forward pass for the showcase match
 *   - fallback.js:  fallback opponent / API-down fallback
 *   - worker.js:    training web workers (spawned on [start], terminated on [stop])
 *   - ui.js:        scoreboard, buttons, options panel, stats, graph, config
 *
 * On page load, showcase starts immediately in fallback-vs-fallback mode
 * (in case the broker is unreachable). As soon as the first /showcase
 * request succeeds, switches to brain-vs-brain or brain-vs-fallback based
 * on the server's 4:1 rotation. Training workers are NEVER spawned until
 * the user clicks [start].
 */

import { buildAtlas } from './atlas.js';
import { Renderer } from './renderer.js?v=73';
import {
  createField,
  createState,
  createSeededRng,
  tick as physicsTick,
  buildInputs,
  TICK_MS,
} from './physics.js?v=38';
import { NeuralNet } from './nn.js';
import { fallbackAction } from './fallback.js';
import {
  createScoreboard,
  createStartStopButton,
  createOptionsToggle,
  createStatsPanel,
  createFitnessGraph,
  createConfigControls,
  createResetButton,
  createFreeCamToggle,
  createFollowCamToggle,
  installAutoPause,
} from './ui.js';

const API_BASE = '/api/football';
// Hard safety limit — a stalled match still times out even if the config
// slider was pushed past this. Real match length comes from the config
// controls via getMatchDurationMs().
const MAX_SHOWCASE_TICKS = 4000;

/* ── Bootstrap ────────────────────────────────────────── */

let renderer = null;
let scoreboard = null;
let startStopBtn = null;
let statsPanel = null;
let configControls = null;
let workers = [];
let currentMatch = null;
// Reused NN input buffers — avoid per-tick allocation in buildInputs().
const p1InputBuf = new Array(18);
const p2InputBuf = new Array(18);

async function main() {
  // Load the SDF atlas first — everything else depends on it
  const atlas = await buildAtlas();

  const canvas = document.getElementById('game-canvas');
  renderer = new Renderer(canvas, atlas);
  renderer.autoResize();
  // Always exposed so the freecam toggle (and ad-hoc debugging) can drive it.
  window.__footballRenderer = renderer;

  scoreboard = createScoreboard();
  statsPanel = createStatsPanel({ apiBase: API_BASE });
  createFitnessGraph({ apiBase: API_BASE });
  configControls = createConfigControls({ apiBase: API_BASE });

  startStopBtn = createStartStopButton({
    onStart: () => startWorkers(configControls.getWorkerCount()),
    onStop: () => stopWorkers(),
  });

  configControls.onWorkerCountChange((n) => {
    if (startStopBtn.isRunning()) {
      // Rebuild worker pool to the new size
      startWorkers(n);
    }
  });

  createOptionsToggle();
  // Freecam and follow-cam are mutually exclusive; each toggle
  // refreshes the other's label after its click so the UI mirrors
  // the renderer's actual state.
  let freeCamCtl = null;
  let followCamCtl = null;
  freeCamCtl = createFreeCamToggle({ renderer, onChange: () => followCamCtl?.refresh() });
  followCamCtl = createFollowCamToggle({ renderer, onChange: () => freeCamCtl?.refresh() });
  createResetButton({
    apiBase: API_BASE,
    onReset: () => {
      // Force next showcase to pick up the reset population
      currentMatch = null;
      nextShowcase();
    },
  });

  installAutoPause(() => {
    if (startStopBtn.isRunning()) {
      stopWorkers();
      startStopBtn.setRunning(false);
    }
  });

  // Kick off the showcase loop
  nextShowcase();
  requestAnimationFrame(frame);
}

/* ── Showcase loop ────────────────────────────────────── */

async function nextShowcase() {
  let matchup = null;
  try {
    const res = await fetch(`${API_BASE}/showcase`);
    if (res.ok) matchup = await res.json();
  } catch {
    /* API unreachable — fall through to fallback-vs-fallback */
  }

  const state = createState(createField(), createSeededRng((Math.random() * 2 ** 31) >>> 0));
  state.graceFrames = 0;
  // Let the renderer consume ball-bounce events for splash particles.
  state.recordEvents = true;

  let p1Brain = null;
  let p2Brain = null;
  let p1Source = null;
  let p2Source = null;

  if (matchup && matchup.p1) {
    p1Source = matchup.p1;
    try {
      p1Brain = new NeuralNet(matchup.p1.weights);
    } catch {
      p1Brain = null;
    }
    if (matchup.mode === 'vs_fallback') {
      p2Source = { type: 'fallback', name: 'fallback' };
      p2Brain = null;
    } else if (matchup.p2) {
      p2Source = matchup.p2;
      try {
        p2Brain = new NeuralNet(matchup.p2.weights);
      } catch {
        p2Brain = null;
      }
    }
  }

  // Fallback vs fallback when the broker is unreachable
  if (p1Source === null) {
    p1Source = { type: 'fallback', name: 'fallback' };
    p2Source = { type: 'fallback', name: 'fallback' };
  }

  scoreboard.setMatchup(p1Source, p2Source);
  scoreboard.setScore(0, 0);
  currentMatch = { state, p1Brain, p2Brain };
}

function frame() {
  requestAnimationFrame(frame);
  if (!currentMatch) return;
  const { state, p1Brain, p2Brain } = currentMatch;

  const matchDurationMs = configControls?.getMatchDurationMs() ?? 30000;
  const matchDurationTicks = Math.ceil(matchDurationMs / TICK_MS);

  if (state.matchOver || state.tick >= matchDurationTicks || state.tick > MAX_SHOWCASE_TICKS) {
    nextShowcase();
    return;
  }

  if (state.pauseState !== null) {
    physicsTick(state, null, null);
    renderer.renderState(state);
    return;
  }

  const p1Action = p1Brain
    ? p1Brain.forward(buildInputs(state, 'p1', p1InputBuf))
    : fallbackAction(state, 'p1');

  const p2Action = p2Brain
    ? p2Brain.forward(buildInputs(state, 'p2', p2InputBuf))
    : fallbackAction(state, 'p2');

  physicsTick(state, p1Action, p2Action);

  scoreboard.setScore(state.scoreL, state.scoreR);
  scoreboard.setTimer(
    (state.tick * TICK_MS) / 1000,
    matchDurationMs / 1000,
  );
  renderer.renderState(state);
}

/* ── Worker pool ──────────────────────────────────────── */

function startWorkers(count) {
  stopWorkers();
  for (let i = 0; i < count; i++) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'batch') {
        statsPanel?.setSimsPerSec(msg.simsPerSec * workers.length);
      } else if (msg.type === 'error') {
        console.error('[football worker]', msg.message);
      }
    };
    worker.postMessage({ type: 'start', apiBase: API_BASE });
    workers.push(worker);
  }
}

function stopWorkers() {
  for (const w of workers) {
    try { w.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    try { w.terminate(); } catch { /* ignore */ }
  }
  workers = [];
  statsPanel?.setSimsPerSec(0);
}

/* ── Go ──────────────────────────────────────────────── */

main().catch((err) => {
  console.error('[football] boot failed:', err);
});
