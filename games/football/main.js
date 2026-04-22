/**
 * Football v2 — main entry point.
 *
 * Composes all the pieces:
 *   - renderer.js:  three.js scene (solid 3D geometry — no glyphs)
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

import { Renderer } from './renderer.js';
import {
  createField,
  createState,
  resetStateInPlace,
  tick as physicsTick,
  buildInputs,
  TICK_MS,
  NN_INPUT_SIZE,
  NN_ACTION_STRIDE,
} from './physics.js';
import { NeuralNet, WEIGHT_COUNT } from './nn.js';
import { fallbackAction } from './fallback.js';
import { createTrainingOrchestrator } from './training-orchestrator.js';
import { computeTicks } from './frame-loop.js';
import { renderStageLabel } from './api/reset-pipeline.js';
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
// Showcase match length, in milliseconds. Fixed — no longer surfaced in
// the UI. Training workers pick up the broker's /config default (which
// currently matches this constant) so visual and headless match
// durations stay consistent.
const SHOWCASE_MATCH_MS = 30000;
// Hard safety limit — a stalled match still times out even if the
// physics state is wedged for some reason.
const MAX_SHOWCASE_TICKS = 4000;

/* ── Bootstrap ────────────────────────────────────────── */

let renderer = null;
let scoreboard = null;
let startStopBtn = null;
let statsPanel = null;
let configControls = null;
let orchestrator = null;
let currentMatch = null;
// Fixed-timestep accumulator — decouples physics from rAF so the
// showcase runs at 60 Hz regardless of the display refresh rate
// (otherwise 120 Hz monitors see 2× speed, 144 Hz see 2.4×, etc.).
let lastFrameTime = 0;
let tickAccumulator = 0;
// Hard ceiling on ticks-per-frame to avoid a "spiral of death" if the
// tab was backgrounded or the browser stalled — we skip ahead instead
// of catching up in slow motion.
const MAX_TICKS_PER_FRAME = 5;
// Reused NN input buffers — avoid per-tick allocation in buildInputs().
const p1InputBuf = new Array(NN_INPUT_SIZE);
const p2InputBuf = new Array(NN_INPUT_SIZE);

// Persistent showcase state + field + rng + NN pair. One allocation
// per page lifetime — every showcase match reuses them via
// resetStateInPlace + loadWeights. Prevents a steady allocation drip
// on the main thread (~once per 30s) compounding over long sessions;
// more importantly, keeps the showcase path symmetric with the
// per-worker reuse pattern in worker.js.
let showcaseRngSeed = 1;
function showcaseRngFn() {
  showcaseRngSeed = (Math.imul(showcaseRngSeed, 1664525) + 1013904223) >>> 0;
  return showcaseRngSeed / 4294967296;
}
const showcaseField = createField();
const showcaseState = createState(showcaseField, showcaseRngFn);
const showcaseP1Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));
const showcaseP2Brain = new NeuralNet(new Float64Array(WEIGHT_COUNT));

async function main() {
  const canvas = document.getElementById('game-canvas');
  renderer = new Renderer(canvas);
  renderer.autoResize();
  // Always exposed so the freecam toggle (and ad-hoc debugging) can drive it.
  window.__footballRenderer = renderer;

  scoreboard = createScoreboard();
  orchestrator = createTrainingOrchestrator({
    apiBase: API_BASE,
    // Cache-bust: browsers aggressively reuse web-worker URLs across
    // reloads; a hard refresh re-fetches the main page but can serve
    // worker.js stale. Bump the query string when the worker protocol
    // changes (e.g., this edit added `seed` to the result payload and
    // the broker expects it).
    workerUrl: new URL('./worker.js?v=5', import.meta.url),
    onStats: ({ simsPerSec }) => statsPanel?.setSimsPerSec(simsPerSec),
  });
  // Runtime is broker-authoritative and comes back in the /stats
  // response, so the panel doesn't need a client-side callback.
  statsPanel = createStatsPanel({ apiBase: API_BASE });
  createFitnessGraph({ apiBase: API_BASE });
  configControls = createConfigControls();

  // Shared label renderers: both reset and start (during seeding)
  // drive the button label through the pipeline's cycling dots. The
  // reloading path receives its stage name from the caller so the UI
  // can distinguish "restarting broker" (slow) from "reloading page"
  // (brief tail) — see RESPAWN_STAGE/RELOAD_STAGE in reset-pipeline.js.
  const renderLabel = (stage, elapsed, interval, progress) => `[ ${renderStageLabel(stage, elapsed, interval, progress)} ]`;
  const renderReloading = (stage, elapsed, interval) => `[ ${renderStageLabel(stage, elapsed, interval)} ]`;

  startStopBtn = createStartStopButton({
    apiBase: API_BASE,
    onStart: () => { void orchestrator.start(configControls.getWorkerCount()); },
    onStop:  () => { void orchestrator.stop(); statsPanel?.setSimsPerSec(0); },
    renderLabel,
    renderReloading,
    getWorkerCount: () => configControls.getWorkerCount(),
  });

  // Poll /stats once on boot to detect an unseeded broker (empty
  // population → fresh clone or deleted warm_start_weights.json).
  // When unseeded, the start button shows "[ seed ]" and clicking it
  // runs the full reset pipeline.
  void fetch(`${API_BASE}/stats`).then((r) => r.ok ? r.json() : null).then((s) => {
    if (s && s.population === 0) startStopBtn.setSeeded(false);
  }).catch(() => { /* broker down — leave optimistic default */ });

  configControls.onWorkerCountChange((n) => {
    if (startStopBtn.isRunning()) {
      // Rebuild worker pool to the new size by restarting the orchestrator.
      void (async () => {
        await orchestrator.stop();
        await orchestrator.start(n);
      })();
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
  // Default the page to follow-ball mode on every fresh load. The
  // showcase looks best when the camera tracks the ball — the static
  // wide-angle default made the action feel distant.
  renderer.setFollowCam(true);
  followCamCtl.refresh();
  // The reset button hard-reloads the page after the broker restarts,
  // so no onReset callback is needed — the showcase rebuilds from
  // scratch on the new page load.
  createResetButton({
    apiBase: API_BASE,
    renderLabel,
    renderReloading,
    getWorkerCount: () => configControls.getWorkerCount(),
  });

  installAutoPause(() => {
    if (startStopBtn.isRunning()) {
      void orchestrator.stop();
      statsPanel?.setSimsPerSec(0);
      startStopBtn.setRunning(false);
    }
  });

  // Heap watchdog — belt-and-braces for runaway memory. The main fix
  // is the per-match state/NN reuse above; this catches any residual
  // drift (three.js internals, worker protocol queues, module
  // registrations from devtools, etc.) before the tab crashes with
  // SIGILL (V8 FatalProcessOutOfMemory). Non-Chromium browsers don't
  // expose performance.memory, so we silently no-op there.
  installHeapWatchdog();

  // Kick off the showcase loop
  nextShowcase();
  requestAnimationFrame(frame);
}

function installHeapWatchdog() {
  const mem = performance.memory;
  if (!mem || !Number.isFinite(mem.jsHeapSizeLimit)) return;
  const RELOAD_FRAC = 0.75;
  // Grace period after load — a large initial heap (module graph,
  // three.js, warm-start fetch) is normal; we want to catch the
  // monotonic drift that appears after training has been running
  // for a while, not a tall first read.
  const GRACE_MS = 60000;
  const startedAt = Date.now();
  setInterval(() => {
    if (Date.now() - startedAt < GRACE_MS) return;
    const used = mem.usedJSHeapSize;
    const limit = mem.jsHeapSizeLimit;
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return;
    if (used / limit < RELOAD_FRAC) return;
    try { console.warn(`[football] heap ${Math.round(used / 1048576)}MB / ${Math.round(limit / 1048576)}MB — reloading to avoid OOM`); } catch { /* ignore */ }
    location.reload();
  }, 10000);
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

  // Prefer the seed the broker supplies (deterministic replay of a
  // known-decisive training match); otherwise pick a fresh random
  // seed for a live simulation.
  const isReplay = Number.isFinite(matchup?.seed);
  const seed = isReplay
    ? (matchup.seed >>> 0)
    : (Math.random() * 2 ** 31) >>> 0;
  showcaseRngSeed = seed || 1;
  const state = resetStateInPlace(showcaseState, showcaseField, showcaseRngFn);
  state.graceFrames = 0;
  // Let the renderer consume ball-bounce events for splash particles.
  state.recordEvents = true;
  // Zero ball.z on replays — createState spawns the ball at
  // RESPAWN_DROP_Z=60 for a visual drop on live matches, but the
  // worker resets it to 0 before running, so replays need to match
  // or the initial physics diverges. Post-goal kickoffs now go
  // through the same resetToKickoff (via advancePause's waiting
  // branch) in BOTH paths, so the visual can run the celebrate/
  // reposition pauses and still end up bit-identical to the worker
  // by the time play resumes.
  if (isReplay) state.ball.z = 0;

  let p1Brain = null;
  let p2Brain = null;
  let p1Source = null;
  let p2Source = null;

  if (matchup && matchup.p1) {
    p1Source = matchup.p1;
    try {
      showcaseP1Brain.loadWeights(matchup.p1.weights);
      p1Brain = showcaseP1Brain;
    } catch {
      p1Brain = null;
    }
    if (matchup.mode === 'vs_fallback') {
      p2Source = { type: 'fallback', name: 'fallback' };
      p2Brain = null;
    } else if (matchup.p2) {
      p2Source = matchup.p2;
      try {
        showcaseP2Brain.loadWeights(matchup.p2.weights);
        p2Brain = showcaseP2Brain;
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
  // p1Action / p2Action are sticky across `NN_ACTION_STRIDE` physics
  // ticks so the visual showcase decision cadence matches the headless
  // trainer exactly (see feedback_training_visual_parity).
  currentMatch = { state, p1Brain, p2Brain, p1Action: null, p2Action: null };
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!currentMatch) { lastFrameTime = now; return; }
  const { state, p1Brain, p2Brain } = currentMatch;

  const matchDurationTicks = Math.ceil(SHOWCASE_MATCH_MS / TICK_MS);

  if (state.matchOver || state.tick >= matchDurationTicks || state.tick > MAX_SHOWCASE_TICKS) {
    nextShowcase();
    lastFrameTime = now;
    tickAccumulator = 0;
    return;
  }

  // Advance the physics by as many fixed ticks as real time has
  // elapsed since the last frame. On a 60 Hz display that's ~1 tick
  // per frame; on 120 Hz it's ~0.5 (so we tick every other frame)
  // and on 30 Hz it's ~2. Guarantees the showcase plays at the same
  // wall-clock speed everywhere.
  if (lastFrameTime === 0) lastFrameTime = now;
  const result = computeTicks(now - lastFrameTime, tickAccumulator, TICK_MS, MAX_TICKS_PER_FRAME);
  lastFrameTime = now;
  tickAccumulator = result.accumulator;
  let ticksThisFrame = result.ticks;

  while (ticksThisFrame-- > 0) {
    if (state.matchOver) break;
    if (state.pauseState !== null) {
      physicsTick(state, null, null);
      continue;
    }
    // Only recompute actions every NN_ACTION_STRIDE ticks — the
    // in-between ticks reuse the previous decision. Same rule
    // applied headless in worker.js so the trained policy runs at
    // the exact cadence it was selected against.
    if (state.tick % NN_ACTION_STRIDE === 0) {
      currentMatch.p1Action = p1Brain
        ? p1Brain.forward(buildInputs(state, 'p1', p1InputBuf))
        : fallbackAction(state, 'p1');
      currentMatch.p2Action = p2Brain
        ? p2Brain.forward(buildInputs(state, 'p2', p2InputBuf))
        : fallbackAction(state, 'p2');
    }
    physicsTick(state, currentMatch.p1Action, currentMatch.p2Action);
  }

  if (state.pauseState === 'matchend' && state.winner) {
    scoreboard.setWinner(state.winner);
  } else {
    scoreboard.setScore(state.scoreL, state.scoreR);
  }
  scoreboard.setTimer(
    (state.tick * TICK_MS) / 1000,
    SHOWCASE_MATCH_MS / 1000,
  );
  renderer.renderState(state);
}

/* ── Go ──────────────────────────────────────────────── */

main().catch((err) => {
  console.error('[football] boot failed:', err);
});
