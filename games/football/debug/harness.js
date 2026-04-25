// Dev-only test-harness factory for the football renderer.
//
// A "harness" is ONE canvas showing N stickmen/scenarios side by
// side. Each scenario defines its own slice of state and a per-tick
// step; the harness composes them into a single renderState() call
// via the N-player path (state.players[]).
//
// Not part of the shipped game — this whole directory is gitignored.
// Import paths are relative; the file lives at games/football/debug/
// so ../renderer.js and ../physics.js resolve to the shipped code.

import { Renderer } from '../renderer.js';
import {
  createField,
  createState,
  createSeededRng,
  FIELD_WIDTH_REF,
  PLAYER_WIDTH,
  Z_STRETCH,
} from '../physics.js';

// ── Lazy mount / unmount registry ──────────────────────────────
// Each canvas starts as a Renderer-shaped proxy; the real three.js
// WebGLRenderer only gets instantiated when the canvas enters the
// viewport. On exit, the context is released AND the canvas DOM
// element is swapped for a fresh one — because `getContext()` on a
// canvas that already holds a lost context returns the lost context
// (per WebGL spec), which would leave the strip frozen/blank on
// remount.
export const CONTEXT_CAP = Math.min(
  6,
  Math.max(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4),
);
const proxies = new Map();    // canvas -> proxy (persists across mount/unmount)
const activeQueue = [];        // [canvas, ...] LRU (head = oldest active)
let io = null;                 // IntersectionObserver; wired up by startLazyMount()

function _mountProxy(proxy) {
  if (proxy._real) return;
  while (activeQueue.length >= CONTEXT_CAP) {
    const oldestCanvas = activeQueue.shift();
    const oldestProxy = proxies.get(oldestCanvas);
    if (oldestProxy && oldestProxy !== proxy) _unmountProxy(oldestProxy);
  }
  const real = new Renderer(proxy._canvas);
  real.autoResize();
  real.setDebugCam(true);
  for (const [m, args] of proxy._setupQueue) real[m](...args);
  proxy._real = real;
  Object.defineProperty(proxy, '_animByPlayer', {
    get() { return real._animByPlayer; },
    configurable: true,
  });
  proxy._onLost = (e) => { e.preventDefault(); _unmountProxy(proxy); };
  proxy._onRestored = () => { _mountProxy(proxy); };
  proxy._canvas.addEventListener('webglcontextlost', proxy._onLost, false);
  proxy._canvas.addEventListener('webglcontextrestored', proxy._onRestored, false);
  activeQueue.push(proxy._canvas);
}

function _unmountProxy(proxy) {
  if (!proxy._real) return;
  if (proxy._onLost) proxy._canvas.removeEventListener('webglcontextlost', proxy._onLost);
  if (proxy._onRestored) proxy._canvas.removeEventListener('webglcontextrestored', proxy._onRestored);
  proxy._onLost = null;
  proxy._onRestored = null;
  try {
    const gl = proxy._real.renderer.getContext();
    const ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  } catch (err) { /* already gone */ }
  try { proxy._real.dispose(); }
  catch (err) { console.warn('renderer dispose failed', err); }
  proxy._real = null;
  Object.defineProperty(proxy, '_animByPlayer', {
    value: proxy._placeholderAnim,
    configurable: true,
    writable: true,
  });
  const idx = activeQueue.indexOf(proxy._canvas);
  if (idx >= 0) activeQueue.splice(idx, 1);
  // Swap canvas so the next mount gets a fresh GL context.
  const old = proxy._canvas;
  if (old && old.parentNode) {
    const fresh = document.createElement('canvas');
    for (const attr of old.attributes) fresh.setAttribute(attr.name, attr.value);
    // Preserve dev-time hooks (e.g. _harnessProbe) so Playwright
    // probes continue to work across remounts.
    if (old._harnessProbe) fresh._harnessProbe = old._harnessProbe;
    old.parentNode.replaceChild(fresh, old);
    proxies.delete(old);
    proxy._canvas = fresh;
    proxies.set(fresh, proxy);
    if (io) { io.unobserve(old); io.observe(fresh); }
  }
}

function makeProxy(canvas) {
  const placeholderAnim = new WeakMap();
  const setupQueue = [];
  const proxy = {
    _canvas: canvas,
    _real: null,
    _setupQueue: setupQueue,
    _animByPlayer: placeholderAnim,
    _placeholderAnim: placeholderAnim,
    _onLost: null,
    _onRestored: null,
  };
  for (const method of ['autoResize', 'setDebugCam', 'setCameraFocus', 'setFollowCam']) {
    proxy[method] = (...args) => {
      setupQueue.push([method, args]);
      if (proxy._real) proxy._real[method](...args);
    };
  }
  proxy.renderState = (state) => { if (proxy._real) proxy._real.renderState(state); };
  proxies.set(canvas, proxy);
  return proxy;
}

/** Wire the IntersectionObserver. Call after all harnesses register.*/
export function startLazyMount() {
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const proxy = proxies.get(e.target);
      if (!proxy) continue;
      if (e.isIntersecting) {
        try { _mountProxy(proxy); }
        catch (err) { console.error(`mount ${e.target.id} failed:`, err); }
      } else {
        _unmountProxy(proxy);
      }
    }
  }, { rootMargin: '300px 0px' });
  for (const canvas of proxies.keys()) io.observe(canvas);
}

// ── Shared state helpers ───────────────────────────────────────
export function freshState(seed = 7) {
  const field = createField(FIELD_WIDTH_REF);
  const state = createState(field, createSeededRng(seed));
  state.graceFrames = 0;
  state.recordEvents = true;
  return state;
}

// ── The harness factory ────────────────────────────────────────
//
// A harness = one canvas + N scenarios ticking in parallel.
//
// Config:
//   id         — canvas element id
//   scenarios  — [{ label, init(state, i), step?(state, i, frame) }]
//                Each scenario gets its OWN independent state object;
//                the factory composes them into one render call by
//                filling `state.players` and one shared ball (first
//                scenario's ball wins — harnesses needing many
//                simultaneously visible balls stay as single-
//                scenario-per-frame for now).
//   camera     — { targetX, targetY, targetZ, distance, pitchDeg, yawDeg }
//                or 'auto' to use the renderer's default.
//   renderGhostBalls — if true, renders a tiny ghost ball marker per
//                scenario at the scenario's ball position using the
//                shared ball mesh cycled. Off by default.
//
// The factory registers the canvas with the lazy-mount registry;
// mounting happens lazily on viewport enter.

export function makeHarness({ id, scenarios, camera, label }) {
  const canvas = document.getElementById(id);
  if (!canvas) { console.warn(`no canvas #${id}`); return null; }
  const proxy = makeProxy(canvas);
  if (label) canvas.setAttribute('aria-label', label);

  // Per-scenario state objects. Each gets its own players/ball so
  // scenarios are isolated. init() is called once.
  const scenarioStates = scenarios.map((sc, i) => {
    const st = freshState(7 + i);
    sc.init?.(st, i);
    return st;
  });

  // How many players each scenario contributes. Default = both p1 and
  // p2; scenarios that use only one player declare `players: 'p1'`
  // (or 'p2') to avoid polluting the scene with an idle second
  // stickman.
  const pickPlayers = (sc, st) => {
    if (sc.players === 'p1') return [st.p1];
    if (sc.players === 'p2') return [st.p2];
    if (sc.players === 'none') return [];
    if (typeof sc.players === 'function') return sc.players(st);
    return [st.p1, st.p2];
  };

  // Apply camera setup once — queued on the proxy so it re-applies
  // on remount.
  if (camera && camera !== 'auto') {
    proxy.setCameraFocus(
      camera.targetX, camera.targetY, camera.targetZ,
      camera.distance, camera.pitchDeg, camera.yawDeg,
    );
  }

  // Composite render state — reused each frame to avoid allocation.
  // state.players and state.balls concatenate across scenarios so
  // the renderer draws every independent physics world into one
  // scene. state.events is merged across scenarios so particles /
  // bursts fire from each.
  const composite = {
    tick: 0,
    pauseState: null,
    goalScorer: null,
    players: [],
    balls: [],
    ball: scenarioStates[0].ball,   // kept for code paths that still read state.ball
    events: [],
    field: scenarioStates[0].field,
  };

  // Animation loop. Global `window.__animSpeed` scales physics
  // ticks per rAF:
  //   0  — physics fully paused, scene still renders at last state
  //   1  — one physics tick per frame (default)
  //   2  — two physics ticks per frame (double speed)
  // Fractional values accumulate so e.g. 0.5 runs one tick every 2
  // frames. Capped at 4 ticks/frame to prevent runaway catch-up if
  // the tab was throttled.
  let stepAccum = 0;
  function loop() {
    if (proxy._real) {
      const speed = (typeof globalThis !== 'undefined' && globalThis.__animSpeed != null)
        ? globalThis.__animSpeed : 1;
      stepAccum += Math.max(0, speed);
      const runs = Math.min(4, Math.floor(stepAccum));
      stepAccum -= runs;

      for (let r = 0; r < runs; r++) {
        for (let i = 0; i < scenarios.length; i++) {
          const sc = scenarios[i];
          const st = scenarioStates[i];
          sc.step?.(st, i, composite.tick, proxy);
        }
        composite.tick++;
      }

      // Rebuild composite from current scenario states every frame
      // — even at speed=0 (so paused scenes still render cleanly
      // with current players/ball/pose, and editor-driven overrides
      // take effect immediately without needing physics to advance).
      composite.players.length = 0;
      composite.balls.length = 0;
      composite.events.length = 0;
      composite.pauseState = null;
      composite.goalScorer = null;
      for (let i = 0; i < scenarios.length; i++) {
        const sc = scenarios[i];
        const st = scenarioStates[i];
        // Stamp per-player the scenario-specific dead-ball state so
        // the renderer can tell scenarios apart inside one composite.
        // Without this, a global composite.pauseState would leak
        // (e.g. a 'celebrate' scenario's flag would apply to a
        // 'matchend' scenario's players too).
        for (const p of pickPlayers(sc, st)) {
          p._scenePauseState = st.pauseState;
          p._sceneGoalScorer = st.goalScorer;
          p._sceneWinner     = st.winner;
          p._sceneSide       = p === st.p1 ? 'left' : p === st.p2 ? 'right' : null;
          composite.players.push(p);
        }
        if (sc.showBall !== false) composite.balls.push(st.ball);
        if (st.events && st.events.length) {
          for (const ev of st.events) composite.events.push(ev);
          st.events.length = 0;
        }
        if (st.pauseState === 'celebrate') {
          composite.pauseState = 'celebrate';
          if (st.goalScorer) composite.goalScorer = st.goalScorer;
        }
      }
      composite.ball = composite.balls[0] || scenarioStates[0].ball;

      try { proxy._real.renderState(composite); }
      catch (e) { console.error(`render error in ${id}:`, e); }
    }
    requestAnimationFrame(loop);
  }
  loop();

  // Expose scenario states on the canvas for Playwright probing.
  // Dev-only; never called by production code.
  canvas._harnessProbe = () => ({
    id, scenarios: scenarioStates.map((st, i) => ({
      label: scenarios[i].label,
      p1: { x: st.p1.x, y: st.p1.y, heading: st.p1.heading, pushTimer: st.p1.pushTimer, kickActive: st.p1.kick.active, kickStage: st.p1.kick.stage, airZ: st.p1.airZ, stamina: st.p1.stamina, vx: st.p1.vx, vy: st.p1.vy },
      p2: { x: st.p2.x, y: st.p2.y, heading: st.p2.heading, pushTimer: st.p2.pushTimer, kickActive: st.p2.kick.active, kickStage: st.p2.kick.stage, airZ: st.p2.airZ, vx: st.p2.vx, vy: st.p2.vy },
      ball: { x: st.ball.x, y: st.ball.y, z: st.ball.z, vx: st.ball.vx, vy: st.ball.vy, vz: st.ball.vz, frozen: st.ball.frozen, inGoal: st.ball.inGoal },
      pauseState: st.pauseState, tick: st.tick,
    })),
  });

  return { proxy, scenarios: scenarioStates };
}

// ── Convenience: place a pair of players in a line ─────────────
//
// For harnesses that want "N scenarios in a line", use this to
// compute the x-position for scenario i out of N so stickmen don't
// overlap visually.
export function lineupX(i, n, worldWidth = FIELD_WIDTH_REF, margin = 180) {
  // Default margin keeps scenarios clear of the goal boxes (each
  // goal + its box extends ~100 units into the field). Margin 180
  // leaves comfortable clearance for the scenario's own zone width.
  const usable = worldWidth - 2 * margin;
  if (n <= 1) return worldWidth / 2;
  return margin + (i / (n - 1)) * usable;
}

export { PLAYER_WIDTH, Z_STRETCH };
