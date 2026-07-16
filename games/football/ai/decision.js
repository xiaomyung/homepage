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

/** Per-side intent scratch. `decide` writes into `intentScratch[which].intent`
 *  instead of allocating a literal each call. `.target` is a per-side owned
 *  {x,y} object that the intent's `target` field points at when populated
 *  (CONTENDER_RUN / SUPPORT / GOALIE); for CONTENDER_KICK and NEUTRAL the
 *  intent's `target` is set to null. It is never aliased to perception's
 *  nested objects — attackKickSpot values are *copied* in, so the sidestep
 *  write below can't corrupt the facts scratch. */
function makeIntentScratch() {
  return {
    intent: { kind: null, role: null, push: false, target: null },
    target: { x: 0, y: 0 },
  };
}

const intentScratch = { p1: makeIntentScratch(), p2: makeIntentScratch() };

/**
 * Decide intent. Returns the reused per-side scratch intent
 * `{ kind, role, push, target }` — `target` is a populated {x,y} object for
 * CONTENDER_RUN, SUPPORT, and GOALIE; `null` for CONTENDER_KICK and NEUTRAL.
 * The caller consumes it synchronously (see `intentScratch` note); holding a
 * result across a later same-side `decide` aliases it.
 */
export function decide(state, which, perception) {
  const self = state[which];
  const opp = state[which === 'p1' ? 'p2' : 'p1'];

  const scratch = intentScratch[which];
  const intent = scratch.intent;
  const ownedTarget = scratch.target;

  if (perception.selfBlocked) {
    intent.kind = INTENT_KINDS.NEUTRAL;
    intent.role = null;
    intent.push = false;
    intent.target = null;
    return intent;
  }

  if (perception.threatensOwnGoal) {
    const yTarget = perception.ownGoalInterceptY;
    const goalX = self.side === 'left' ? state.field.goalLineL : state.field.goalLineR;
    ownedTarget.x = goalX;
    ownedTarget.y = yTarget;
    intent.kind = INTENT_KINDS.GOALIE;
    intent.role = state.aiRoleState[self.side].role;
    intent.target = ownedTarget;
    intent.push = false;
    return intent;
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
  // Copy (never alias) the facts' attackKickSpot into the owned target so
  // the sidestep write below stays local to this intent's scratch.
  ownedTarget.x = perception.attackKickSpot.x;
  ownedTarget.y = perception.attackKickSpot.y;

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
    const tx = ownedTarget.x - perception.selfCx;
    const ty = ownedTarget.y - perception.selfCy;
    // Cross product picks which perpendicular side puts target ahead:
    // positive cross => target is left of self→opp axis, negative => right.
    const cross = ux * ty - uy * tx;
    const sign = cross >= 0 ? 1 : -1;
    const perpX = -uy * sign;
    const perpY = ux * sign;
    ownedTarget.x = ownedTarget.x + perpX * SIDESTEP_OFFSET;
    ownedTarget.y = ownedTarget.y + perpY * SIDESTEP_OFFSET;
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
      if (!yieldToOpp) {
        intent.kind = INTENT_KINDS.CONTENDER_KICK;
        intent.role = role;
        intent.push = false;
        intent.target = null;
        return intent;
      }
    }
    intent.kind = INTENT_KINDS.CONTENDER_RUN;
    intent.role = role;
    intent.target = ownedTarget;
    intent.push = pushAvailable;
    return intent;
  }

  // SUPPORT — pure-press: also chase the ball, just from farther away.
  if (perception.selfHasKickReach && !opp.kick.active) {
    intent.kind = INTENT_KINDS.CONTENDER_KICK;
    intent.role = role;
    intent.push = false;
    intent.target = null;
    return intent;
  }

  intent.kind = INTENT_KINDS.SUPPORT;
  intent.role = role;
  intent.target = ownedTarget;
  intent.push = pushAvailable;
  return intent;
}
