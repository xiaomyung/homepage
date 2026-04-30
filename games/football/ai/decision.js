/**
 * Pure (with bounded mutation): perception + state.aiRoleState ->
 * tactical intent. The only mutated fields are state.aiRoleState[side],
 * which carries role hysteresis across ticks.
 *
 * Intent kinds:
 *   NEUTRAL          — selfBlocked or matchend
 *   CONTENDER_KICK   — closer to ball, kick reach OK -> shoot
 *   CONTENDER_RUN    — closer to ball, not in kick reach -> chase
 *   SUPPORT          — opp closer, also press the ball (pure-press)
 *   GOALIE           — own goal threatened: cover the line
 *
 * push: bool overlay on any of the above.
 */

import {
  CONTENDER_MARGIN_TICKS,
  ROLE_HYSTERESIS_TICKS,
  FALLBACK_SAFETY_MARGIN,
  SIDESTEP_TRIGGER_DIST,
  SIDESTEP_OFFSET,
} from './tuning.js';

import { canKickReach } from '../physics.js';

const INTENT_NEUTRAL = 'NEUTRAL';
const INTENT_CONTENDER_KICK = 'CONTENDER_KICK';
const INTENT_CONTENDER_RUN = 'CONTENDER_RUN';
const INTENT_SUPPORT = 'SUPPORT';
const INTENT_GOALIE = 'GOALIE';

export const INTENT_KINDS = Object.freeze({
  NEUTRAL: INTENT_NEUTRAL,
  CONTENDER_KICK: INTENT_CONTENDER_KICK,
  CONTENDER_RUN: INTENT_CONTENDER_RUN,
  SUPPORT: INTENT_SUPPORT,
  GOALIE: INTENT_GOALIE,
});

const ROLE_CONTENDER = 'contender';
const ROLE_SUPPORT = 'support';

export const ROLES = Object.freeze({
  CONTENDER: ROLE_CONTENDER,
  SUPPORT: ROLE_SUPPORT,
  NONE: null,
});

/** Decide which side is contender by raw intercept-tick comparison.
 *  Tiebreak: ball-velocity-vector points toward whose half-line; if
 *  velocity is small, default to side='left'. */
function rawContenderSide(perception, opp) {
  const m = perception.selfInterceptTicks;
  const o = perception.oppInterceptTicks;
  if (Number.isFinite(m) && Number.isFinite(o)) {
    if (m + CONTENDER_MARGIN_TICKS < o) return ROLE_CONTENDER;
    if (o + CONTENDER_MARGIN_TICKS < m) return ROLE_SUPPORT;
  } else {
    if (Number.isFinite(m) && !Number.isFinite(o)) return ROLE_CONTENDER;
    if (!Number.isFinite(m) && Number.isFinite(o)) return ROLE_SUPPORT;
  }
  return null;
}

/** Pick a tiebreak winner when ranges are within margin. */
function tiebreakContender(state, selfSide) {
  const ball = state.ball;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 0.5) {
    const ballHeadsLeft = ball.vx < 0;
    const selfIsLeft = selfSide === 'left';
    if (ballHeadsLeft && selfIsLeft) return ROLE_CONTENDER;
    if (!ballHeadsLeft && !selfIsLeft) return ROLE_CONTENDER;
    return ROLE_SUPPORT;
  }
  return selfSide === 'left' ? ROLE_CONTENDER : ROLE_SUPPORT;
}

/** Resolve role with hysteresis. Conditional fast-flip when opp possesses
 *  the ball (opp.kick.active or opp within kick reach). */
function resolveRole(state, side, perception, opp) {
  const roleState = state.aiRoleState[side];
  const tick = state.tick | 0;

  const oppPossesses = perception.oppWindingUp || perception.oppHasKickReach;

  let raw = rawContenderSide(perception, opp);
  if (raw === null) raw = tiebreakContender(state, perception.selfSide);

  if (roleState.role === null) {
    roleState.role = raw;
    roleState.since = tick;
    return raw;
  }

  if (roleState.role === ROLE_CONTENDER && oppPossesses && raw === ROLE_SUPPORT) {
    roleState.role = ROLE_SUPPORT;
    roleState.since = tick;
    return ROLE_SUPPORT;
  }

  const elapsed = tick - roleState.since;
  if (raw !== roleState.role && elapsed >= ROLE_HYSTERESIS_TICKS) {
    roleState.role = raw;
    roleState.since = tick;
  }
  return roleState.role;
}

/**
 * Decide intent. Returns a plain object:
 *   { kind, target, kickDirX, kickDirY, kickDirZ, push, role }
 */
export function decide(state, which, perception) {
  const self = state[which];
  const opp = state[which === 'p1' ? 'p2' : 'p1'];

  state.aiRoleState ||= { left: { role: null, since: 0 }, right: { role: null, since: 0 } };
  state.aiRoleState[self.side] ||= { role: null, since: 0 };

  if (perception.selfBlocked) {
    return { kind: INTENT_NEUTRAL, role: null, push: false };
  }

  if (perception.threatensOwnGoal) {
    const yTarget = perception.ownGoalInterceptY;
    const goalX = self.side === 'left' ? state.field.goalLineL : state.field.goalLineR;
    return {
      kind: INTENT_GOALIE,
      role: state.aiRoleState[self.side].role,
      target: { x: goalX, y: yTarget },
      push: false,
    };
  }

  const role = resolveRole(state, self.side, perception, opp);

  // Mercy gate: don't push an exhausted opponent. They can't react
  // (their NEUTRAL intent zeros all gates) so it would just be
  // pummelling a downed body. Resumes when opp recovers to
  // STAMINA_EXHAUSTION_THRESHOLD = 0.5 and physics clears the flag.
  const push = !perception.oppExhausted
    && (perception.pushOpportunity || (perception.oppWindingUp && perception.selfDistToBall < perception.oppDistToBall + 30));

  // Pure-press target: chase the ball directly. The attackKickSpot is
  // good geometry for a "set up a clean shot" approach but it parks the
  // player a few units shy of the ball — if canKickReach fails inside
  // the capture-radius window the player gets stuck. Chasing the ball
  // itself keeps the player nudging it until heading + reach align.
  let ballTarget = { x: state.ball.x, y: state.ball.y };

  // Sidestep when in pair contact: bias the target perpendicular to the
  // self→opp axis, toward the side where the original target lies. The
  // controller stops pressing straight into the opp and tries to circle
  // around instead.
  if (perception.selfDistToOpp < SIDESTEP_TRIGGER_DIST) {
    const ox = perception.oppCx - perception.selfCx;
    const oy = perception.oppCy - perception.selfCy;
    const oLen = Math.hypot(ox, oy) || 1;
    const ux = ox / oLen;
    const uy = oy / oLen;
    const tx = ballTarget.x - perception.selfCx;
    const ty = ballTarget.y - perception.selfCy;
    // Cross product picks which perpendicular side puts target ahead:
    // positive cross => target is left of self→opp axis, negative => right.
    const cross = ux * ty - uy * tx;
    const sign = cross >= 0 ? 1 : -1;
    const perpX = -uy * sign;
    const perpY = ux * sign;
    ballTarget = {
      x: ballTarget.x + perpX * SIDESTEP_OFFSET,
      y: ballTarget.y + perpY * SIDESTEP_OFFSET,
    };
  }

  if (role === ROLE_CONTENDER) {
    if (perception.selfHasKickReach && !perception.oppBlocksLane && !opp.kick.active) {
      const oppCanReach = canKickReach(state, opp, FALLBACK_SAFETY_MARGIN);
      const myD = perception.selfDistToBall;
      const oppD = perception.oppDistToBall;
      const yieldToOpp = oppCanReach && (oppD < myD || (oppD === myD && self.side === 'right'));
      if (!yieldToOpp) {
        return { kind: INTENT_CONTENDER_KICK, role, push };
      }
    }
    return { kind: INTENT_CONTENDER_RUN, role, target: ballTarget, push };
  }

  // SUPPORT — pure-press: also chase the ball, just from farther away.
  if (perception.selfHasKickReach && !perception.oppBlocksLane && !opp.kick.active) {
    return { kind: INTENT_CONTENDER_KICK, role, push };
  }

  return { kind: INTENT_SUPPORT, role, target: ballTarget, push };
}
