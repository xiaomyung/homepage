/**
 * Football v2 — main entry point.
 *
 * Live showcase: deterministic controller-vs-controller, continuous play.
 */

import { Renderer } from './renderer/index.js';
import {
  createField,
  createState,
  resetStateInPlace,
  createSeededRng,
  tick as physicsTick,
  endMatchByTime,
  TICK_MS,
  MAX_TICKS_PER_FRAME,
  TAB_HIDDEN_RELOAD_MS,
} from './physics/index.js';
import { decide, derivePersonality } from './ai/controller.js';
import { pickMatchNames } from './ai/names.js';
import { computeTicks } from './util/frame-loop.js';
import {
  createScoreboard,
  createOptionsToggle,
  createFreeCamToggle,
  createFollowCamToggle,
  createDebugToggle,
} from './ui/index.js';
import { MATCH_DURATION_MS, MAX_SHOWCASE_TICKS } from './ai/tuning.js';
import { RNG_SALT_PERSONALITY, RNG_SALT_NAMES, SEED_UPPER } from './util/rng-salts.js';

let renderer = null;
let scoreboard = null;
let currentMatch = null;
let lastFrameTime = 0;
let tickAccumulator = 0;
let rafId = 0;
let hiddenSinceMs = 0;

let showcaseRng = createSeededRng(1);
const showcaseField = createField();
const showcaseState = createState(showcaseField, showcaseRng);

async function main() {
  const canvas = document.getElementById('game-canvas');
  renderer = new Renderer(canvas);
  renderer.autoResize();
  window.__footballRenderer = renderer;

  scoreboard = createScoreboard();

  createOptionsToggle();
  let freeCamCtl = null;
  let followCamCtl = null;
  freeCamCtl = createFreeCamToggle({ renderer, onChange: () => followCamCtl?.refresh() });
  followCamCtl = createFollowCamToggle({ renderer, onChange: () => freeCamCtl?.refresh() });
  createDebugToggle({ renderer });
  renderer.setFollowCam(true);
  followCamCtl.refresh();

  installRecovery(canvas);

  nextShowcase();
  rafId = requestAnimationFrame(frame);
}

/**
 * Recovery hooks for the long-lived showcase:
 *   - visibilitychange→hidden: cancel the rAF chain, snapshot the
 *     hide timestamp. With the loop fully halted nothing accumulates
 *     (no physics, no render, no GC pressure).
 *   - visibilitychange→visible: if hidden ≥ TAB_HIDDEN_RELOAD_MS,
 *     reload the page for a clean slate; otherwise restart rAF and
 *     force a fresh match.
 *   - webglcontextlost/restored: dispose + recreate. Browsers can
 *     evict the canvas's WebGL context under memory pressure or when
 *     another tab steals contexts, leaving the page permanently blank
 *     until the user closes and reopens.
 */
function installRecovery(canvas) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      hiddenSinceMs = performance.now();
      return;
    }
    const hiddenMs = performance.now() - hiddenSinceMs;
    if (hiddenMs >= TAB_HIDDEN_RELOAD_MS) {
      location.reload();
      return;
    }
    lastFrameTime = 0;
    tickAccumulator = 0;
    nextShowcase();
    if (!rafId) rafId = requestAnimationFrame(frame);
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[football] WebGL context lost — waiting for restore');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[football] WebGL context restored — reinitialising');
    try {
      renderer.dispose?.();
    } catch (err) {
      console.error('[football] renderer dispose failed:', err);
    }
    renderer = new Renderer(canvas);
    renderer.autoResize();
    renderer.setFollowCam(true);
    window.__footballRenderer = renderer;
    nextShowcase();
    lastFrameTime = 0;
    tickAccumulator = 0;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }, false);
}

function nextShowcase() {
  const seed = (Math.random() * SEED_UPPER) >>> 0 || 1;
  showcaseRng = createSeededRng(seed);
  resetStateInPlace(showcaseState, showcaseField, showcaseRng);
  const state = showcaseState;
  state.recordEvents = true;

  state.aiPersonality = derivePersonality(createSeededRng(seed ^ RNG_SALT_PERSONALITY));
  state.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  state.matchNames = pickMatchNames(createSeededRng(seed ^ RNG_SALT_NAMES));

  scoreboard.setMatchup(
    { name: state.matchNames.p1 },
    { name: state.matchNames.p2 },
  );
  scoreboard.setScore(0, 0);

  currentMatch = { state };
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  try {
    frameInner(now);
  } catch (err) {
    console.error('[football] frame error — recovering with new match:', err);
    try { nextShowcase(); } catch (e) { console.error('[football] nextShowcase failed during recovery:', e); }
    lastFrameTime = 0;
    tickAccumulator = 0;
  }
}

function frameInner(now) {
  if (!currentMatch) { lastFrameTime = now; return; }
  const { state } = currentMatch;

  const matchDurationTicks = Math.ceil(MATCH_DURATION_MS / TICK_MS);

  // Match over (cinematic done, finalizeMatch fired) — start the
  // next match. MAX_SHOWCASE_TICKS is a hard safety cap in case the
  // matchend machine ever wedges.
  if (state.matchOver || state.tick > MAX_SHOWCASE_TICKS) {
    nextShowcase();
    lastFrameTime = now;
    tickAccumulator = 0;
    return;
  }

  // Match clock expired with no winner — kick off the time-up matchend
  // (walk-back-only, no celebrate/grieve). Idempotent if it's already
  // running.
  if (state.tick >= matchDurationTicks && state.pauseState === null) {
    endMatchByTime(state);
  }

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
    physicsTick(state, decide(state, 'p1'), decide(state, 'p2'));
  }

  if (state.pauseState === 'matchend' && state.winner) {
    scoreboard.setWinner(state.winner);
  } else {
    scoreboard.setScore(state.scoreL, state.scoreR);
  }
  // Clamp at MATCH_DURATION_MS so the display doesn't overshoot
  // while the time-up matchend reposition runs.
  const elapsedMs = Math.min(state.tick * TICK_MS, MATCH_DURATION_MS);
  scoreboard.setTimer(elapsedMs / 1000, MATCH_DURATION_MS / 1000);
  const paused = state.pauseState !== null;
  scoreboard.setRoles(
    paused ? null : state.aiRoleState.left.role,
    paused ? null : state.aiRoleState.right.role,
  );
  renderer.renderState(state);
}

main().catch((err) => {
  console.error('[football] boot failed:', err);
});
