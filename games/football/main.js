/**
 * Football v2 — main entry point.
 *
 * Live showcase: deterministic controller-vs-controller, continuous play.
 * No broker, no replays, no training. Future learned controllers slot in
 * by exporting `decide(state, side) -> Float64Array(9)` like ai/controller.js.
 */

import { Renderer } from './renderer.js';
import {
  createField,
  createState,
  resetStateInPlace,
  createSeededRng,
  tick as physicsTick,
  TICK_MS,
} from './physics.js';
import { decide, derivePersonality } from './ai/controller.js';
import { pickMatchNames } from './ai/names.js';
import { computeTicks } from './frame-loop.js';
import {
  createScoreboard,
  createOptionsToggle,
  createFreeCamToggle,
  createFollowCamToggle,
} from './ui.js';
import { MATCH_DURATION_MS, MAX_SHOWCASE_TICKS, ACTION_STRIDE_TICKS } from './ai/tuning.js';

let renderer = null;
let scoreboard = null;
let currentMatch = null;
let lastFrameTime = 0;
let tickAccumulator = 0;
const MAX_TICKS_PER_FRAME = 5;

let showcaseRngSeed = 1;
function showcaseRngFn() {
  showcaseRngSeed = (Math.imul(showcaseRngSeed, 1664525) + 1013904223) >>> 0;
  return showcaseRngSeed / 4294967296;
}
const showcaseField = createField();
const showcaseState = createState(showcaseField, showcaseRngFn);

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
  renderer.setFollowCam(true);
  followCamCtl.refresh();

  // Visibility-change recovery skeleton (full WebGL recovery + try/catch
  // wrapper land in commit 8). When tab returns to visible after a long
  // hide, restart the showcase from a fresh seed so a stale physics
  // state can't surface a frozen render.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFrameTime = 0;
      tickAccumulator = 0;
    }
  });

  nextShowcase();
  requestAnimationFrame(frame);
}

function nextShowcase() {
  const seed = (Math.random() * 2 ** 31) >>> 0 || 1;
  showcaseRngSeed = seed;
  resetStateInPlace(showcaseState, showcaseField, showcaseRngFn);
  const state = showcaseState;
  state.recordEvents = true;

  const personalityRng = createSeededRng(seed ^ 0x5A5A5A5A);
  state.aiPersonality = derivePersonality(personalityRng);
  state.aiRoleState = { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  state.aiRng = createSeededRng(seed ^ 0xA5A5A5A5);

  const nameRng = createSeededRng(seed ^ 0x12345678);
  state.matchNames = pickMatchNames(nameRng);

  scoreboard.setMatchup(
    { name: state.matchNames.p1 },
    { name: state.matchNames.p2 },
  );
  scoreboard.setScore(0, 0);

  currentMatch = { state };
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!currentMatch) { lastFrameTime = now; return; }
  const { state } = currentMatch;

  const matchDurationTicks = Math.ceil(MATCH_DURATION_MS / TICK_MS);

  if (state.matchOver || state.tick >= matchDurationTicks || state.tick > MAX_SHOWCASE_TICKS) {
    nextShowcase();
    lastFrameTime = now;
    tickAccumulator = 0;
    return;
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
    let p1Action = currentMatch.p1Action;
    let p2Action = currentMatch.p2Action;
    if (state.tick % ACTION_STRIDE_TICKS === 0 || !p1Action) {
      p1Action = decide(state, 'p1');
      p2Action = decide(state, 'p2');
      currentMatch.p1Action = p1Action;
      currentMatch.p2Action = p2Action;
    }
    physicsTick(state, p1Action, p2Action);
  }

  if (state.pauseState === 'matchend' && state.winner) {
    scoreboard.setWinner(state.winner);
  } else {
    scoreboard.setScore(state.scoreL, state.scoreR);
  }
  scoreboard.setTimer(
    (state.tick * TICK_MS) / 1000,
    MATCH_DURATION_MS / 1000,
  );
  const lr = state.aiRoleState?.left?.role;
  const rr = state.aiRoleState?.right?.role;
  scoreboard.setRoles(
    state.pauseState !== null ? null : lr,
    state.pauseState !== null ? null : rr,
  );
  renderer.renderState(state);
}

main().catch((err) => {
  console.error('[football] boot failed:', err);
});
