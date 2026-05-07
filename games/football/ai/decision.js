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
  BALL_TIEBREAK_SPEED_GATE,
  CONTENDER_MARGIN_TICKS,
  ROLE_HYSTERESIS_TICKS,
  FALLBACK_SAFETY_MARGIN,
  SIDESTEP_TRIGGER_DIST,
  SIDESTEP_OFFSET,
  PUSH_WINDUP_LEAD_DIST,
} from './tuning.js';

import { canKickReach } from '../physics/index.js';

export const INTENT_KINDS = Object.freeze({
  NEUTRAL: 'NEUTRAL',
  CONTENDER_KICK: 'CONTENDER_KICK',
  CONTENDER_RUN: 'CONTENDER_RUN',
  SUPPORT: 'SUPPORT',
  GOALIE: 'GOALIE',
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
function rawContenderSide(perception) {
  const selfTicks = perception.selfInterceptTicks;
  const oppTicks = perception.oppInterceptTicks;
  const selfFinite = Number.isFinite(selfTicks);
  const oppFinite = Number.isFinite(oppTicks);
  if (selfFinite && oppFinite) {
    if (selfTicks + CONTENDER_MARGIN_TICKS < oppTicks) return ROLE_CONTENDER;
    if (oppTicks + CONTENDER_MARGIN_TICKS < selfTicks) return ROLE_SUPPORT;
    return null;
  }
  if (selfFinite) return ROLE_CONTENDER;
  if (oppFinite) return ROLE_SUPPORT;
  return null;
}

/** Pick a tiebreak winner when ranges are within margin. */
function tiebreakContender(state, selfSide) {
  const ball = state.ball;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > BALL_TIEBREAK_SPEED_GATE) {
    return (ball.vx < 0) === (selfSide === 'left') ? ROLE_CONTENDER : ROLE_SUPPORT;
  }
  return selfSide === 'left' ? ROLE_CONTENDER : ROLE_SUPPORT;
}

/** Resolve role with hysteresis. Conditional fast-flip when opp possesses
 *  the ball (opp.kick.active or opp within kick reach). */
function resolveRole(state, side, perception) {
  const roleState = state.aiRoleState[side];
  const tick = state.tick | 0;

  const oppPossesses = perception.oppWindingUp || perception.oppHasKickReach;

  let raw = rawContenderSide(perception);
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
 * Decide intent. Returns `{ kind, role, push, target? }` — `target` is
 * present for CONTENDER_RUN, SUPPORT, and GOALIE; absent for
 * CONTENDER_KICK and NEUTRAL.
 */
export function decide(state, which, perception) {
  const self = state[which];
  const opp = state[which === 'p1' ? 'p2' : 'p1'];

  if (perception.selfBlocked) {
    return { kind: INTENT_KINDS.NEUTRAL, role: null, push: false };
  }

  if (perception.threatensOwnGoal) {
    const yTarget = perception.ownGoalInterceptY;
    const goalX = self.side === 'left' ? state.field.goalLineL : state.field.goalLineR;
    return {
      kind: INTENT_KINDS.GOALIE,
      role: state.aiRoleState[self.side].role,
      target: { x: goalX, y: yTarget },
      push: false,
    };
  }

  const role = resolveRole(state, self.side, perception);

  // Mercy gate: don't push an exhausted opponent. They can't react
  // (their NEUTRAL intent zeros all gates) so it would just be
  // pummelling a downed body. Resumes when opp recovers to
  // STAMINA_EXHAUSTION_THRESHOLD = 0.5 and physics clears the flag.
  const pushAvailable = !perception.oppExhausted
    && (perception.pushOpportunity
        || (perception.oppWindingUp
            && perception.selfDistToBall < perception.oppDistToBall + PUSH_WINDUP_LEAD_DIST));

  // Run-onto-the-shot: target the kick spot (just behind the ball on the
  // ball→opp-goal line) so heading aligns with kick direction during the
  // approach. canKickReach passes with the player already squared up —
  // kick fires same tick. Relies on world-proportional pursuit (closes y
  // proportionally to x) and physics' tryStartKick running before
  // applyMovement, so the controller and gate share the same player state.
  let ballTarget = perception.attackKickSpot;

  // Sidestep when in true pair contact AND can't kick — bias the target
  // perpendicular to the self→opp axis, toward the side where the
  // original target lies. Kick reach takes priority: if the player can
  // already kick we don't want to bias them sideways and miss the shot.
  if (perception.selfDistToOpp < SIDESTEP_TRIGGER_DIST && !perception.selfHasKickReach) {
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

  // Push is suppressed when the player can also kick — pushing locks
  // the player for ~1s (windup + recovery) and burns the kick window.
  // The lob branch in action.js::kickApproach handles opp-on-lane via
  // air kick, so we don't need to refuse the kick when oppBlocksLane.
  if (role === ROLE_CONTENDER) {
    if (perception.selfHasKickReach && !opp.kick.active) {
      const oppCanReach = canKickReach(state, opp, FALLBACK_SAFETY_MARGIN);
      const oppD = perception.oppDistToBall;
      const myD = perception.selfDistToBall;
      const yieldToOpp = oppCanReach && (oppD < myD || (oppD === myD && self.side === 'right'));
      if (!yieldToOpp) return { kind: INTENT_KINDS.CONTENDER_KICK, role, push: false };
    }
    return { kind: INTENT_KINDS.CONTENDER_RUN, role, target: ballTarget, push: pushAvailable };
  }

  // SUPPORT — pure-press: also chase the ball, just from farther away.
  if (perception.selfHasKickReach && !opp.kick.active) {
    return { kind: INTENT_KINDS.CONTENDER_KICK, role, push: false };
  }

  return { kind: INTENT_KINDS.SUPPORT, role, target: ballTarget, push: pushAvailable };
}
