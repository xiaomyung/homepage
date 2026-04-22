/**
 * Football v2 — deterministic fallback AI (possession-based teacher).
 *
 * Drives the warm-start imitation target: `evolution/build-warm-start.mjs`
 * plays fallback-vs-fallback, pairs `(buildInputs(state), fallbackAction(state))`
 * each tick, and fits the NN by MSE. The NN eventually learns to emit
 * the same 9-dim action vector this function produces.
 *
 * Behaviour model:
 *   possession = sign(intercept_time_opp − intercept_time_self)
 *     positive → attack (chase kick-spot behind ball, shoot when lane clear)
 *     negative → defend (hold intercept line to own goal, or press when
 *                        I can still beat opp to the ball)
 *
 * Time-hysteresis on possession (cooldown before mode re-evaluation) and
 * press-duration commitment both kill the classic "flicker between press
 * and hold every tick" failure of a stateless policy.
 *
 * Teacher state lives on each player record under `.teacher`; physics.js
 * never touches it, so tests against raw physics state still pass. The
 * policy is deterministic given (state, teacher) — `resetTeacher` clears
 * the memory for test fixtures.
 */

import {
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FIELD_HEIGHT,
  BALL_RADIUS,
  MAX_PLAYER_SPEED,
  TICK_MS,
  NN_OUTPUT_SIZE,
  ACTION_MOVE_X,
  ACTION_MOVE_Y,
  ACTION_KICK_GATE,
  ACTION_KICK_DX,
  ACTION_KICK_DY,
  ACTION_KICK_DZ,
  ACTION_KICK_POWER,
  ACTION_PUSH_GATE,
  ACTION_PUSH_POWER,
  canKickReach,
} from './physics.js';

/* ── Tunables ─────────────────────────────────────────────────── */

// ~500 ms prediction window — long enough to cover a ball crossing
// midfield at typical kick speed, short enough to not extrapolate past
// a goal-line bounce or reflection.
export const PREDICTION_HORIZON_TICKS = Math.round(500 / TICK_MS);
// Minimum dwell-time in a possession mode before re-evaluation runs.
// Kills per-tick flicker at close intercept-time ties.
export const POSSESSION_COOLDOWN_TICKS = Math.round(300 / TICK_MS);
// Once the teacher commits to a press (charge the ball) it stays
// committed this long regardless of signal drift, so the player
// actually reaches the ball instead of abandoning the run.
export const PRESS_COMMITMENT_TICKS    = Math.round(400 / TICK_MS);
// Max intercept-time (ticks) at which the defender commits to a
// press. Above this, the ball is too far to meaningfully contest
// and the defender holds the intercept line instead. Tuned so a
// defender ~150 world-units from the ball still presses.
export const PRESS_INTERCEPT_CEIL      = 15;
// Ignore tiny movement commands so the NN can't oscillate ±ε on
// moveX/Y and burn stamina in place.
export const FALLBACK_DEAD_ZONE        = 0.15;
// Within this distance of a waypoint, emit zero movement so the
// teacher doesn't "run in place" orbiting a point.
export const FALLBACK_CAPTURE_RADIUS   = PLAYER_WIDTH / 2;
// Reject a kick only when the opponent is directly *behind* the
// ball from the kicker's perspective AND within blocking range —
// i.e., the ball would hit their legs within the first few units
// of flight. Based on physical sizes so it scales with rig changes.
export const NEAR_BLOCK_DIST           = 20;                // world units
export const NEAR_BLOCK_RADIUS         = PLAYER_WIDTH / 2 + BALL_RADIUS;
// Conservative margin on the hip-reach gate (mirrors the physics
// `canKickReach` call). Prevents flapping on the edge.
export const FALLBACK_SAFETY_MARGIN    = 2;
export const KICK_POWER_NORM           = 1.0;   // max power (clear-lane ⇒ no finesse)
export const KICK_DZ_DEFAULT           = 0.0;   // ground kick
export const PUSH_POWER_NORM           = 0.5;

/* ── Teacher state ────────────────────────────────────────────── */

/**
 * Lazily attach per-player teacher memory to `player`. Fields:
 *   mode       — 'attack' | 'defend'
 *   modeSince  — state.tick at which the current mode was entered
 *   pressUntil — state.tick until which press sub-mode is committed
 */
// Prime `modeSince` to the negative cooldown so the very first call
// is outside the cooldown window and re-evaluates immediately.
// Without this the initial default 'attack' sticks for 300 ms even
// when the teacher should be defending from tick 0.
const PRIMED_MODE_SINCE = -POSSESSION_COOLDOWN_TICKS;

function freshTeacher() {
  return { mode: 'attack', modeSince: PRIMED_MODE_SINCE, pressUntil: 0 };
}

function ensureTeacher(player) {
  if (!player.teacher) {
    player.teacher = freshTeacher();
  }
  return player.teacher;
}

/** Clear teacher memory on both players. Call before deterministic
 *  tests to remove state carried over from previous runs. */
export function resetTeacher(state) {
  state.p1.teacher = freshTeacher();
  state.p2.teacher = freshTeacher();
}

/* ── Geometric helpers ────────────────────────────────────────── */

/**
 * Earliest tick within `horizon` at which `player` can reach the
 * ball (straight-line, max player speed, linear ball prediction).
 * Returns Infinity if unreachable in horizon. Pure.
 */
export function interceptTicks(ball, player, horizon = PREDICTION_HORIZON_TICKS) {
  const cx = player.x + PLAYER_WIDTH / 2;
  const cy = player.y + PLAYER_HEIGHT / 2;
  const speed = MAX_PLAYER_SPEED;
  // A ball tick k ≥ 0 is reachable iff `|ball_at_k − player| ≤ speed * k`.
  // Closed-form root would be messier with ball velocity; small
  // horizon (~30) makes per-tick evaluation trivial and robust.
  for (let k = 0; k <= horizon; k++) {
    const bx = ball.x + ball.vx * k;
    const by = ball.y + ball.vy * k;
    const d = Math.hypot(bx - cx, by - cy);
    if (d <= speed * k + 1e-6) return k;
  }
  return Infinity;
}

/**
 * Signed possession advantage for `which`. Positive values mean I
 * reach the ball first. Magnitude = tick-difference (clamped at
 * ±HORIZON for unreachable on either side).
 */
export function possessionSignal(state, which) {
  const self = state[which];
  const opp  = state[which === 'p1' ? 'p2' : 'p1'];
  const myT  = interceptTicks(state.ball, self);
  const oppT = interceptTicks(state.ball, opp);
  if (!isFinite(myT) && !isFinite(oppT)) return 0;
  if (!isFinite(myT)) return -PREDICTION_HORIZON_TICKS;
  if (!isFinite(oppT)) return +PREDICTION_HORIZON_TICKS;
  return oppT - myT;
}

/**
 * Is the opponent directly in the ball's path from the kicker, close
 * enough that the kick would hit them immediately? True iff the
 * opponent centre sits within `NEAR_BLOCK_DIST` along the kick-
 * direction ray starting at the ball AND within `NEAR_BLOCK_RADIUS`
 * perpendicular to it. Long-range shots where the opponent is far
 * along the lane are NOT blocked — the physics trap already handles
 * the corner case where the ball reaches them after travelling.
 * Pure.
 */
export function opponentBlocksKick(bx, by, dirX, dirY, ox, oy) {
  const t = (ox - bx) * dirX + (oy - by) * dirY;
  if (t <= 0 || t > NEAR_BLOCK_DIST) return false;
  const perpX = (ox - bx) - t * dirX;
  const perpY = (oy - by) - t * dirY;
  const perp  = Math.hypot(perpX, perpY);
  return perp < NEAR_BLOCK_RADIUS;
}

/**
 * Waypoint for attack-mode pursuit: a point just behind the ball on
 * the line from ball → shot-target, so running toward it sets up a
 * first-touch shot on arrival. Writes (x, y) into `out` (a plain
 * `{x, y}` object; no allocation when `out` is pre-provided).
 */
export function attackWaypoint(state, self, out) {
  const f = state.field;
  const b = state.ball;
  const tgx = self.side === 'left' ? f.goalLineR : f.goalLineL;
  const tgy = FIELD_HEIGHT / 2;
  // Unit vector from ball toward opponent's goal.
  const dx = tgx - b.x;
  const dy = tgy - b.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Kick-spot = ball − (BALL_RADIUS + small margin) along (ux, uy).
  // Running at this point lands the player on the ball from the
  // right side; `BALL_RADIUS + 2` is empirical headroom for the
  // foot-ball contact sphere.
  const offset = BALL_RADIUS + 2;
  out.x = b.x - ux * offset;
  out.y = b.y - uy * offset;
  return out;
}

/**
 * Defensive waypoint: a point on the line between the ball and my
 * own goal's centre, `frac` of the way from goal to ball. A `frac`
 * near 1.0 presses the ball; near 0.0 hugs the goal line; 0.5 is
 * the mid-point (default intercept position).
 */
export function defenseWaypoint(state, self, frac, out) {
  const f = state.field;
  const b = state.ball;
  const ogx = self.side === 'left' ? f.goalLineL : f.goalLineR;
  const ogy = FIELD_HEIGHT / 2;
  out.x = ogx + frac * (b.x - ogx);
  out.y = ogy + frac * (b.y - ogy);
  return out;
}

/* ── Action helpers ───────────────────────────────────────────── */

/**
 * Produce a unit movement vector from `self` toward (tx, ty),
 * applying capture-radius and dead-zone. Writes (mx, my) into `out`.
 */
function moveToward(self, tx, ty, out) {
  const cx = self.x + PLAYER_WIDTH / 2;
  const cy = self.y + PLAYER_HEIGHT / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const d = Math.hypot(dx, dy);
  if (d <= FALLBACK_CAPTURE_RADIUS) {
    out.mx = 0; out.my = 0;
    return out;
  }
  let mx = dx / d;
  let my = dy / d;
  if (Math.abs(mx) < FALLBACK_DEAD_ZONE) mx = 0;
  if (Math.abs(my) < FALLBACK_DEAD_ZONE) my = 0;
  out.mx = mx;
  out.my = my;
  return out;
}

/**
 * Attack-mode action: move toward kick-spot, kick when reach-gated
 * AND the lane to goal centre is clear. Writes into `out` (the full
 * 9-vec); caller owns the buffer.
 */
const _wp = { x: 0, y: 0 };
const _mv = { mx: 0, my: 0 };
function attackAction(state, self, opp, out) {
  const f = state.field;
  attackWaypoint(state, self, _wp);
  moveToward(self, _wp.x, _wp.y, _mv);

  const kickDirX = self.side === 'left' ? 1 : -1;
  const canReach = canKickReach(state, self, FALLBACK_SAFETY_MARGIN);
  // Contested-kick resolution. Same-tick simultaneous kicks are a
  // physics tick-order artefact (last executeKick wins), which makes
  // mirror-symmetric F-vs-F matches systematically biased toward p2.
  // Resolve by letting only the CLOSER player kick. Deterministic
  // tiebreak on perfect equality: left side (p1) wins — a one-off
  // asymmetry that saves us from breaking teacher determinism with
  // an rng tiebreak. Also suppress while opp already has a kick in
  // flight to avoid overlapping strike-windows.
  const oppKicking = opp.kick && opp.kick.active;
  const oppCanReach = canKickReach(state, opp, FALLBACK_SAFETY_MARGIN);
  let yieldToOpp = oppKicking;
  if (!yieldToOpp && canReach && oppCanReach) {
    const myD  = Math.hypot(
      state.ball.x - (self.x + PLAYER_WIDTH / 2),
      state.ball.y - (self.y + PLAYER_HEIGHT / 2),
    );
    const oppD = Math.hypot(
      state.ball.x - (opp.x + PLAYER_WIDTH / 2),
      state.ball.y - (opp.y + PLAYER_HEIGHT / 2),
    );
    yieldToOpp = oppD < myD || (oppD === myD && self.side === 'right');
  }

  let kickGate = false;
  if (canReach && !yieldToOpp) {
    const ocx = opp.x + PLAYER_WIDTH / 2;
    const ocy = opp.y + PLAYER_HEIGHT / 2;
    // Reject only near-blocks — opponent pressed up against the ball
    // on the kick side. A distant opponent on the shot line is still
    // a legitimate kick; the trap/bounce handles corner cases.
    kickGate = !opponentBlocksKick(state.ball.x, state.ball.y, kickDirX, 0, ocx, ocy);
  }
  // Reach-gated but not kicking (yielded, blocked, or opp active):
  // stop and wait rather than running into the opponent.
  if (canReach && !kickGate) {
    _mv.mx = 0; _mv.my = 0;
  }

  out[ACTION_MOVE_X]     = _mv.mx;
  out[ACTION_MOVE_Y]     = _mv.my;
  out[ACTION_KICK_GATE]  = kickGate ? 1 : -1;
  out[ACTION_KICK_DX]    = kickDirX;
  out[ACTION_KICK_DY]    = 0;
  out[ACTION_KICK_DZ]    = KICK_DZ_DEFAULT;
  out[ACTION_KICK_POWER] = KICK_POWER_NORM;
}

/**
 * Defense-mode action: choose press or hold sub-mode (with 400 ms
 * commitment once press fires). Press = chase a kick-spot like
 * attack; hold = stand on intercept-line midpoint.
 */
function defenseAction(state, self, out) {
  const tm = self.teacher;
  const t = state.tick || 0;

  // If we're already committed to press, stay pressing regardless of
  // the current possession signal.
  let pressing = t < tm.pressUntil;
  if (!pressing) {
    // Enter press when I can reach the ball reasonably quickly —
    // a defender close enough that charging meaningfully disrupts
    // the opponent. Use the raw intercept-time, not the gap, so
    // "I'm near the ball" triggers press even when the opp is
    // closer still.
    const myT = interceptTicks(state.ball, self);
    if (myT <= PRESS_INTERCEPT_CEIL) {
      pressing = true;
      tm.pressUntil = t + PRESS_COMMITMENT_TICKS;
    }
  }

  if (pressing) {
    attackWaypoint(state, self, _wp);
  } else {
    // Mid-line intercept: 0.5 of the way from own goal to ball.
    defenseWaypoint(state, self, 0.5, _wp);
  }
  moveToward(self, _wp.x, _wp.y, _mv);

  out[ACTION_MOVE_X]     = _mv.mx;
  out[ACTION_MOVE_Y]     = _mv.my;
  // Defenders rarely kick toward own goal by mistake: gate off unless
  // we're actively pressing and happen to reach the ball (then the
  // ball-kick-toward-opp-goal reflex fires).
  const canReach = pressing && canKickReach(state, self, FALLBACK_SAFETY_MARGIN);
  out[ACTION_KICK_GATE]  = canReach ? 1 : -1;
  out[ACTION_KICK_DX]    = self.side === 'left' ? 1 : -1;
  out[ACTION_KICK_DY]    = 0;
  out[ACTION_KICK_DZ]    = KICK_DZ_DEFAULT;
  out[ACTION_KICK_POWER] = KICK_POWER_NORM;
}

/* ── Entry point ──────────────────────────────────────────────── */

/**
 * 9-dim fallback action. Pure apart from the teacher memory attached
 * to `state[which]`. Re-uses a fresh array per call — callers that
 * hit this at >100 Hz can optimise with a per-caller buffer later.
 */
export function fallbackAction(state, which) {
  const self = state[which];
  const opp  = state[which === 'p1' ? 'p2' : 'p1'];
  const tm   = ensureTeacher(self);
  const t    = state.tick || 0;

  // Re-evaluate mode once the cooldown window expires. Press
  // commitment is a defend SUB-mode and never blocks a cross-mode
  // switch — if possession genuinely flips, we abandon the press
  // and attack instead.
  if (t - tm.modeSince >= POSSESSION_COOLDOWN_TICKS) {
    const sig = possessionSignal(state, which);
    const desired = sig > 0 ? 'attack' : 'defend';
    if (desired !== tm.mode) {
      tm.mode = desired;
      tm.modeSince = t;
      if (desired === 'attack') tm.pressUntil = 0;  // press only lives inside defend
    }
  }

  const out = new Array(NN_OUTPUT_SIZE);

  if (tm.mode === 'attack') {
    attackAction(state, self, opp, out);
  } else {
    defenseAction(state, self, out);
  }

  // Push is disabled in the teacher. Symmetric fallback-vs-fallback
  // matches converge to identical states where both players meet the
  // push criteria on the same tick — mutual pushes blast them apart
  // and destroy the match dynamics. Evolution can rediscover push
  // as a tactic if it turns out useful; the teacher doesn't need to.
  out[ACTION_PUSH_GATE]  = -1;
  out[ACTION_PUSH_POWER] = PUSH_POWER_NORM;

  return out;
}
