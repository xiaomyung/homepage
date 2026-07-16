/**
 * Football v2 — match flow.
 *
 * Pause state machine (celebrate / reposition / waiting), matchend
 * cinematic (reposition / pose / neutral), scoring, ball-out, ball
 * reset, and finalization. No physics math here — every routine
 * mutates state and reads from the field/players.
 */

import {
  FIELD_HEIGHT, RESPAWN_DROP_Z, RESPAWN_GRACE,
  WIN_SCORE, CELEBRATE_TICKS,
  MATCHEND_REPOSITION_MAX_TICKS, MATCHEND_POSE_TICKS, MATCHEND_NEUTRAL_TICKS,
  REPOSITION_SPEED, REPOSITION_TOL,
  REPOSITION_LERP_FRAC, REPOSITION_Y_SPEED_FRAC,
  RESPAWN_DELAY_TICKS,
  STAMINA_REGEN,
} from './tuning.js';
import { kickoffSpawnX } from './state.js';

/** Snap the whole pitch back to its kickoff state in one tick — used by
 *  the headless path after every goal or ball-out so the match budget
 *  isn't burned on celebrate/reposition/waiting pause frames. Teleports
 *  players to their starting spots, zeros all velocities + pending
 *  animation timers, drops the ball at midfield on the ground, and
 *  clears any pause/grace state. */
export function resetToKickoff(state) {
  const f = state.field;
  const ball = state.ball;
  ball.x = f.midX;
  ball.y = FIELD_HEIGHT / 2;
  ball.z = 0;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.frozen = false;
  ball.inGoal = false;
  ball.crossedLineL = false;
  ball.crossedLineR = false;

  const cy = FIELD_HEIGHT / 2;
  const { p1, p2 } = state;
  p1.x = kickoffSpawnX(f, 'left');
  p1.y = cy;
  p1.vx = 0; p1.vy = 0;
  p1.pushVx = 0; p1.pushVy = 0;
  clearInProgressActions(p1);
  p2.x = kickoffSpawnX(f, 'right');
  p2.y = cy;
  p2.vx = 0; p2.vy = 0;
  p2.pushVx = 0; p2.pushVy = 0;
  clearInProgressActions(p2);

  state.pauseState = null;
  state.pauseTimer = 0;
  state.matchEndPhase = null;
  state.goalScorer = null;
  state.graceFrames = 0;
  state.lastKickTick = state.tick;
}

/** Zero in-progress kick / push / hit-reaction state on a player.
 *
 *  applyAction, advancePush, and advanceReactTimer are all gated off
 *  while `state.pauseState !== null`, so a player who was mid-kick
 *  (or mid-push, or recoiling) when play stopped would otherwise keep
 *  `kick.active = true` / `pushTimer > 0` / `reactTimer > 0` frozen
 *  through the entire celebrate → matchend pause. The pose composer
 *  reads those flags directly and renders the leg stretched forward
 *  or the arm thrown forward indefinitely — the matchend arm override
 *  doesn't touch legs, and the LPF dead-zone tail uncovers the kick
 *  layer once celebrate fades. Clearing here at the play-stop boundary
 *  lets the celebrate/grieve/matchend overrides take over a clean base
 *  pose. */
export function clearInProgressActions(p) {
  p.airZ = 0;
  p.pushTimer = 0;
  p.pendingPushVictim = null;
  p.pendingPushVx = 0;
  p.pendingPushVy = 0;
  p.reactTimer = 0;
  p.reactForce = 0;
  p.reactDirX = 0;
  p.reactDirZ = 0;
  p.reactLatSign = 1;
  p.kick.active = false;
  p.kick.timer = 0;
  p.kick.fired = false;
}

export function scoreGoal(state, side) {
  if (state.pauseState !== null) return;

  state.p1.stamina = 1;
  state.p2.stamina = 1;
  state.p1.exhausted = false;
  state.p2.exhausted = false;

  clearInProgressActions(state.p1);
  clearInProgressActions(state.p2);

  if (side === 'left') {
    // Ball into LEFT goal = RIGHT scored
    state.scoreR++;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p2' });
    if (!state.headless) state.goalScorer = state.p2;
  } else {
    state.scoreL++;
    if (state.recordEvents) state.events.push({ type: 'goal', scorer: 'p1' });
    if (!state.headless) state.goalScorer = state.p1;
  }

  if (state.headless) {
    if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
      state.matchOver = true;
      state.winner = state.scoreL >= WIN_SCORE ? 'left' : 'right';
    } else {
      resetToKickoff(state);
    }
    return;
  }

  // Ball keeps moving under gravity through the pause so a scored
  // shot visibly settles into the net instead of freezing in mid-air.
  state.ball.inGoal = true;
  state.graceFrames = RESPAWN_GRACE;

  // Winning goal: skip the at-spot celebrate, walk straight back to
  // kickoff and run the matchend cinematic. The "winner / loser"
  // moment happens at the centre after both players are repositioned.
  if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
    state.winner = state.scoreL >= WIN_SCORE ? 'left' : 'right';
    state.goalScorer = null;
    state.pauseState = 'matchend';
    state.matchEndPhase = 'reposition';
    state.pauseTimer = MATCHEND_REPOSITION_MAX_TICKS;
    return;
  }

  state.pauseState = 'celebrate';
  state.pauseTimer = CELEBRATE_TICKS;
}

export function ballOut(state) {
  if (state.pauseState !== null) return;
  if (state.recordEvents) state.events.push({ type: 'out' });
  if (state.headless) {
    resetToKickoff(state);
    return;
  }
  clearInProgressActions(state.p1);
  clearInProgressActions(state.p2);
  // Ball keeps moving — gravity settles it naturally wherever it is.
  // Reposition pause drives the players back to kickoff; at the end
  // of the waiting pause, resetBall snaps the ball to midfield.
  state.pauseState = 'reposition';
  state.pauseTimer = 0;
}

export function resetBall(state) {
  const ball = state.ball;
  ball.x = state.field.midX;
  ball.y = FIELD_HEIGHT / 2;
  ball.vx = 0;
  ball.vy = 0;
  ball.z = RESPAWN_DROP_Z;
  ball.vz = 0;
  ball.frozen = false;
  ball.inGoal = false;
  ball.crossedLineL = false;
  ball.crossedLineR = false;
  state.graceFrames = RESPAWN_GRACE;
  state.lastKickTick = state.tick;
}

/** Finalize the match after the matchend pause. Flips the terminal
 *  flags only — no reset work. */
function finalizeMatch(state) {
  state.matchOver = true;
  state.pauseState = null;
  state.pauseTimer = 0;
  state.matchEndPhase = null;
}

/* ── Pause state machine ──────────────────────────────────────── */

export function advancePause(state) {
  if (state.pauseState === 'matchend') {
    advanceMatchend(state);
    return;
  }

  if (state.pauseState === 'celebrate') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) {
      state.pauseState = 'reposition';
      state.pauseTimer = 0;
      state.goalScorer = null;
    }
    return;
  }

  if (state.pauseState === 'reposition') {
    const { tx1, tx2, cy } = stepBothPlayersToKickoff(state);
    if (bothPlayersAtKickoff(state, tx1, tx2, cy)) {
      state.pauseState = 'waiting';
      state.pauseTimer = RESPAWN_DELAY_TICKS;
    }
    return;
  }

  if (state.pauseState === 'waiting') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) {
      resetToKickoff(state);
    }
  }
}

/** Trigger the time-up matchend flow: walk both players back to
 *  kickoff and then finalize. No celebrate/grieve cinematic since
 *  there's no winner to highlight. Idempotent — silently no-ops if a
 *  pause is already running or the match is already over. */
export function endMatchByTime(state) {
  if (state.pauseState !== null || state.matchOver) return;
  clearInProgressActions(state.p1);
  clearInProgressActions(state.p2);
  state.pauseState = 'matchend';
  state.matchEndPhase = 'reposition';
  state.pauseTimer = MATCHEND_REPOSITION_MAX_TICKS;
  state.winner = null;
  state.goalScorer = null;
}

/** Matchend cinematic phase machine. Sub-phases under
 *  pauseState='matchend' transition reposition → pose → neutral →
 *  finalize. Camera dolly + face-camera / face-each-other heading
 *  overrides are read off `state.matchEndPhase` by the renderer.
 *
 *  Time-up matchends (no winner) skip pose + neutral and finalize
 *  the moment both players reach kickoff. */
function advanceMatchend(state) {
  if (state.matchEndPhase === 'reposition') {
    const { tx1, tx2, cy } = stepBothPlayersToKickoff(state);
    state.pauseTimer--;
    if (bothPlayersAtKickoff(state, tx1, tx2, cy) || state.pauseTimer <= 0) {
      state.p1.heading = 0;
      state.p2.heading = Math.PI;
      if (state.winner) {
        state.matchEndPhase = 'pose';
        state.pauseTimer = MATCHEND_POSE_TICKS;
      } else {
        finalizeMatch(state);
      }
    }
    return;
  }
  if (state.matchEndPhase === 'pose') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) {
      state.matchEndPhase = 'neutral';
      state.pauseTimer = MATCHEND_NEUTRAL_TICKS;
    }
    return;
  }
  if (state.matchEndPhase === 'neutral') {
    state.pauseTimer--;
    if (state.pauseTimer <= 0) finalizeMatch(state);
    return;
  }
  finalizeMatch(state);
}

function stepReposition(p, tx, ty) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx > REPOSITION_TOL || absDy > REPOSITION_TOL) {
    p.x += Math.sign(dx) * Math.min(absDx * REPOSITION_LERP_FRAC, REPOSITION_SPEED);
    p.y += Math.sign(dy) * Math.min(absDy * REPOSITION_LERP_FRAC, REPOSITION_SPEED * REPOSITION_Y_SPEED_FRAC);
  } else {
    p.x = tx;
    p.y = ty;
  }
}

/** Slow stamina regen + walk both players one step toward their
 *  kickoff spots. Returns the spot coordinates so the caller can
 *  pass them to bothPlayersAtKickoff without recomputing. Returns a
 *  reused module-scope scratch object — both callers destructure the
 *  result into scalars immediately, so no caller retains it. */
const _scratchKickoffSpots = { tx1: 0, tx2: 0, cy: 0 };
function stepBothPlayersToKickoff(state) {
  const f = state.field;
  const tx1 = kickoffSpawnX(f, 'left');
  const tx2 = kickoffSpawnX(f, 'right');
  const cy = FIELD_HEIGHT / 2;
  state.p1.stamina = Math.min(1, state.p1.stamina + STAMINA_REGEN);
  state.p2.stamina = Math.min(1, state.p2.stamina + STAMINA_REGEN);
  stepReposition(state.p1, tx1, cy);
  stepReposition(state.p2, tx2, cy);
  _scratchKickoffSpots.tx1 = tx1;
  _scratchKickoffSpots.tx2 = tx2;
  _scratchKickoffSpots.cy = cy;
  return _scratchKickoffSpots;
}

function bothPlayersAtKickoff(state, tx1, tx2, cy) {
  return Math.abs(state.p1.x - tx1) < REPOSITION_TOL
      && Math.abs(state.p2.x - tx2) < REPOSITION_TOL
      && Math.abs(state.p1.y - cy) < REPOSITION_TOL
      && Math.abs(state.p2.y - cy) < REPOSITION_TOL;
}
