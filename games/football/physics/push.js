/**
 * Football v2 — push FSM + arm pose.
 *
 * Per-tick advance (`advancePush` commits the impulse on the strike
 * tick), gate check (`tryPush`), push-velocity damper
 * (`applyPushPhysics`), victim hit-reaction timer, and the scripted
 * three-keyframe arm pose (`pushArmPose`) the renderer reads.
 */

import {
  TICK_MS, Z_STRETCH,
  PLAYER_HEIGHT, PLAYER_WIDTH,
  HEAD_CENTER_Z, STICKMAN_HEAD_RADIUS,
  REACT_ANIM_MS,
  PUSH_RANGE_X, PUSH_RANGE_Y,
  MAX_PUSH_FORCE,
  PUSH_DAMP, PUSH_APPLY,
  PUSH_VEL_THRESHOLD_SQ, MIN_PUSH_STAMINA,
  PUSH_ANIM_MS, PUSH_FACE_TOL,
  PUSH_WINDUP_FRAC, PUSH_STRIKE_FRAC,
  PUSH_WINDUP_PEAK_TEFF, WINDUP_LOAD_FRAC,
  PUSH_STAMINA_COST, PUSH_VICTIM_STAMINA_MULT,
  PUSH_STRIKE_TIMER, PUSH_UPPERCUT_RANGE, PUSH_HOOK_RANGE,
  JAB_REST, JAB_WINDUP, JAB_STRIKE,
  HOOK_REST, HOOK_WINDUP, HOOK_STRIKE,
  UPPERCUT_REST, UPPERCUT_WINDUP, UPPERCUT_STRIKE,
} from './tuning.js';
import { clamp, wrapAngle } from './state.js';

/** Same gates as tryPush, used at the strike-commit tick to verify
 *  the victim hasn't escaped the range/facing cone during the windup. */
function pushStillInRange(state, pusher, victim) {
  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;
  if (Math.abs(pusherCenterX - victimCenterX) > PUSH_RANGE_X) return false;
  if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) return false;
  const victimZ = (victim.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  return facingToward(pusher, victimCenterX, victimZ, PUSH_FACE_TOL);
}

/** Local copy of `player.js::facingToward` so push.js stays a leaf
 *  of state.js + tuning.js. */
function facingToward(p, worldX, worldZ, tol) {
  const centerX = p.x + PLAYER_WIDTH / 2;
  const centerZ = (p.y + PLAYER_HEIGHT / 2) * Z_STRETCH;
  const want = Math.atan2(worldZ - centerZ, worldX - centerX);
  return Math.abs(wrapAngle(want - p.heading)) < tol;
}

/** Tick a push cooldown forward. Returns true if the player is still
 *  mid-push and should not accept new actions this tick — mirrors
 *  `advanceKick`'s in-flight-lock contract. Also commits the pending
 *  push impulse to the victim at the strike tick so the victim only
 *  moves on contact rather than on the windup frame. */
export function advancePush(state, p) {
  if (p.pushTimer <= 0) return false;
  const prevTimer = p.pushTimer;
  p.pushTimer -= TICK_MS;
  if (p.pushTimer < 0) p.pushTimer = 0;
  // Strike fires on the single tick where pushTimer crosses the
  // per-type threshold. One-shot by construction: after committing,
  // the pending pointer is nulled so subsequent ticks through the
  // recovery phase do not re-apply the impulse.
  const threshold = PUSH_STRIKE_TIMER[p.pushType] || PUSH_STRIKE_TIMER.jab;
  if (p.pendingPushVictim && prevTimer > threshold && p.pushTimer <= threshold) {
    const victim = p.pendingPushVictim;
    if (!pushStillInRange(state, p, victim)) {
      p.pendingPushVictim = null;
      p.pendingPushVx = 0;
      p.pendingPushVy = 0;
      if (state.recordEvents) {
        state.events.push({
          type: 'push_missed',
          pusher: p === state.p1 ? 'p1' : 'p2',
          reason: 'out_of_range',
        });
      }
      return true;
    }
    victim.pushVx = p.pendingPushVx;
    victim.pushVy = p.pendingPushVy;
    // Hit-reaction state. Stored on the victim so the pose composer
    // can play a recoil animation keyed to type, direction, and force.
    const impulseWX = p.pendingPushVx;
    const impulseWZ = p.pendingPushVy * Z_STRETCH;
    const impulseMag = Math.sqrt(impulseWX * impulseWX + impulseWZ * impulseWZ);
    if (impulseMag > 1e-6) {
      victim.reactDirX = impulseWX / impulseMag;
      victim.reactDirZ = impulseWZ / impulseMag;
    } else {
      victim.reactDirX = 0;
      victim.reactDirZ = 0;
    }
    victim.reactForce = Math.min(1, impulseMag / MAX_PUSH_FORCE);
    victim.reactTimer = REACT_ANIM_MS;
    victim.reactType = p.pushType;
    // Hook recoil sign: the victim's body whips opposite the fist's
    // sweep direction, regardless of impulse direction (which is axial
    // along pusher heading for all punch types).
    const pH = p.heading, vH = victim.heading;
    const sweepX = p.pushArm === 'right' ? -Math.sin(pH) :  Math.sin(pH);
    const sweepZ = p.pushArm === 'right' ?  Math.cos(pH) : -Math.cos(pH);
    const vLatX = -Math.sin(vH), vLatZ = Math.cos(vH);
    victim.reactLatSign = (sweepX * vLatX + sweepZ * vLatZ) >= 0 ? -1 : 1;
    p.pendingPushVictim = null;
    p.pendingPushVx = 0;
    p.pendingPushVy = 0;
    if (state.recordEvents) {
      const f = state.field;
      state.events.push({
        type: 'push_contact',
        x: victim.x + f.playerWidth / 2,
        y: victim.y,
        z: HEAD_CENTER_Z,
        force: victim.reactForce,
      });
    }
  }
  return true;
}

/** Tick the victim's hit-reaction timer down. Purely cosmetic — does
 *  NOT lock the victim's action, so they can retaliate while still
 *  playing the reaction animation. */
export function advanceReactTimer(p) {
  if (p.reactTimer <= 0) return;
  p.reactTimer -= TICK_MS;
  if (p.reactTimer <= 0) {
    p.reactTimer = 0;
    p.reactForce = 0;
  }
}

/** Damp + decay the push-velocity component on a player. Runs every
 *  tick after the player's normal movement so a push impulse decays
 *  smoothly into rest instead of teleporting on. */
export function applyPushPhysics(p) {
  if (p.pushVx * p.pushVx > PUSH_VEL_THRESHOLD_SQ) {
    p.x += p.pushVx * PUSH_APPLY;
    p.pushVx *= PUSH_DAMP;
  } else {
    p.pushVx = 0;
  }
  if (p.pushVy * p.pushVy > PUSH_VEL_THRESHOLD_SQ) {
    p.y += p.pushVy * PUSH_APPLY;
    p.pushVy *= PUSH_DAMP;
  } else {
    p.pushVy = 0;
  }
}

/**
 * Stage-aware arm extension for a punch. Pure function of `pushTimer`
 * in ms. Windup is split into a load (0 → PUSH_WINDUP_PEAK_TEFF over
 * the first WINDUP_LOAD_FRAC of windup) and a rise (PEAK_TEFF → 1
 * over the rest), so the fist reaches full extension by the
 * windup→strike boundary instead of jumping there.
 */
export function pushArmExtension(pushTimer) {
  if (pushTimer <= 0) return 0;
  const t = 1 - (pushTimer / PUSH_ANIM_MS);
  const loadEndT = PUSH_WINDUP_FRAC * WINDUP_LOAD_FRAC;
  if (t < loadEndT) {
    return PUSH_WINDUP_PEAK_TEFF * (t / loadEndT);
  }
  if (t < PUSH_WINDUP_FRAC) {
    const riseT = (t - loadEndT) / (PUSH_WINDUP_FRAC - loadEndT);
    return PUSH_WINDUP_PEAK_TEFF + (1 - PUSH_WINDUP_PEAK_TEFF) * riseT;
  }
  if (t < PUSH_STRIKE_FRAC) return 1;
  const recT = (t - PUSH_STRIKE_FRAC) / Math.max(1e-6, 1 - PUSH_STRIKE_FRAC);
  return Math.max(0, 1 - recT);
}

const _lerp = (a, b, t) => a + (b - a) * t;

function blendPose(out, a, b, t, armSign) {
  out.upperAngle = _lerp(a[0], b[0], t);
  out.lowerAngle = _lerp(a[1], b[1], t);
  out.upperYaw   = _lerp(a[2], b[2], t) * armSign;
  out.lowerYaw   = _lerp(a[3], b[3], t) * armSign;
}

function resolvePoseKeyframes(pushType) {
  if (pushType === 'hook')     return [HOOK_REST,     HOOK_WINDUP,     HOOK_STRIKE];
  if (pushType === 'uppercut') return [UPPERCUT_REST, UPPERCUT_WINDUP, UPPERCUT_STRIKE];
  return [JAB_REST, JAB_WINDUP, JAB_STRIKE];
}

/**
 * Scripted striking-arm pose for a punch. Three visually-distinct
 * variants share a single three-keyframe rig — rest, windup-peak,
 * strike — interpolated by the progress scalar derived from pushTimer.
 *
 * Output is four angles: upperAngle, lowerAngle, upperYaw, lowerYaw.
 * Hook uses upperYaw to carry the arm laterally; jab and uppercut
 * stay in the sagittal plane. The pushArm sign flips hook polarity.
 */
export function pushArmPose(player, out) {
  if (!player || player.pushTimer <= 0) {
    out.upperAngle = 0;
    out.lowerAngle = 0;
    out.upperYaw   = 0;
    out.lowerYaw   = 0;
    return out;
  }
  const t = 1 - (player.pushTimer / PUSH_ANIM_MS);
  const [rest, windup, strike] = resolvePoseKeyframes(player.pushType);
  const armSign = player.pushArm === 'right' ? 1 : -1;

  if (t < PUSH_WINDUP_FRAC) {
    blendPose(out, rest, windup, t / PUSH_WINDUP_FRAC, armSign);
  } else if (t < PUSH_STRIKE_FRAC) {
    blendPose(out, windup, strike, (t - PUSH_WINDUP_FRAC) / (PUSH_STRIKE_FRAC - PUSH_WINDUP_FRAC), armSign);
  } else {
    const recT = (t - PUSH_STRIKE_FRAC) / Math.max(1e-6, 1 - PUSH_STRIKE_FRAC);
    blendPose(out, strike, rest, recT, armSign);
  }
  return out;
}

/**
 * Reachability + facing gate. Schedules the push impulse for the
 * strike tick (committed in advancePush). Picks the arm on the same
 * side as the victim and the punch variant based on pusher→victim
 * heading-plane distance.
 */
export function tryPush(state, pusher, victim, powerNorm) {
  if (pusher.kick.active) return;
  if (pusher.pushTimer > 0) return;
  if (!pushStillInRange(state, pusher, victim)) return;

  const f = state.field;
  const pusherCenterX = pusher.x + f.playerWidth / 2;
  const victimCenterX = victim.x + f.playerWidth / 2;
  const power01 = (clamp(powerNorm, -1, 1) + 1) / 2;
  const force = power01 * MAX_PUSH_FORCE * Math.max(MIN_PUSH_STAMINA, pusher.stamina);

  const fxWorld = Math.cos(pusher.heading);
  const fzWorld = Math.sin(pusher.heading);
  const fyPhys  = fzWorld / Z_STRETCH;
  const pMag    = Math.sqrt(fxWorld * fxWorld + fyPhys * fyPhys) || 1;
  pusher.pushTimer = PUSH_ANIM_MS;

  // Schedule the impulse for the strike tick instead of applying now.
  pusher.pendingPushVictim = victim;
  pusher.pendingPushVx = (fxWorld / pMag) * force;
  pusher.pendingPushVy = (fyPhys  / pMag) * force;

  // Punch animation state. Pick arm on same side as victim, variant
  // based on heading-plane distance.
  const victimCenterWX = victimCenterX;
  const victimCenterWZ = victim.y * Z_STRETCH;
  const pusherCenterWZ = pusher.y * Z_STRETCH;
  const dx = victimCenterWX - pusherCenterX;
  const dz = victimCenterWZ - pusherCenterWZ;
  const fwdDist = dx * fxWorld + dz * fzWorld;
  const perp    = -dx * fzWorld + dz * fxWorld;
  pusher.pushArm = perp >= 0 ? 'right' : 'left';
  if (fwdDist < PUSH_UPPERCUT_RANGE) pusher.pushType = 'uppercut';
  else if (fwdDist < PUSH_HOOK_RANGE) pusher.pushType = 'hook';
  else pusher.pushType = 'jab';
  // Target height: jab/hook aim at head centre; uppercut aims slightly
  // above so the arc sweeps UP through the chin.
  const headY      = HEAD_CENTER_Z;
  const aboveHeadY = HEAD_CENTER_Z + STICKMAN_HEAD_RADIUS * 0.5;
  pusher.pushTargetX = victimCenterWX;
  pusher.pushTargetY = pusher.pushType === 'uppercut' ? aboveHeadY : headY;
  pusher.pushTargetZ = victimCenterWZ;

  pusher.stamina = Math.max(0, pusher.stamina - PUSH_STAMINA_COST * power01);
  victim.stamina = Math.max(0, victim.stamina - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT);

  if (state.recordEvents) {
    const pusherWhich = pusher === state.p1 ? 'p1' : 'p2';
    state.events.push({ type: 'push', pusher: pusherWhich, force, variant: pusher.pushType, arm: pusher.pushArm });
  }
}
