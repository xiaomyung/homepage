/**
 * AI controller tunables — single source of truth.
 */

import { TICK_MS, PLAYER_WIDTH, BALL_RADIUS } from '../physics/index.js';

export const MATCH_DURATION_MS = 60000;
export const MAX_SHOWCASE_TICKS = 8000;

export const PREDICTION_HORIZON_TICKS = Math.round(500 / TICK_MS);

export const ROLE_HYSTERESIS_TICKS = 15;
export const CONTENDER_MARGIN_TICKS = 2;
// Ball speed (physics units / tick) above which the role tiebreak
// uses ball direction instead of falling back to side='left'.
export const BALL_TIEBREAK_SPEED_GATE = 0.5;

export const STAMINA_CONSERVE_THRESHOLD = 0.30;
export const STAMINA_CONSERVE_MAGNITUDE = 0.7;

// Distance-based approach slowdown so the player arrives at the kick
// spot with low velocity instead of full speed. Linear ramp: at
// distance ≥ RAMP runs full speed; at distance 0 sits at MIN. The
// MIN floor is small but non-zero so the player keeps making fine
// y-corrections under the world-proportional pursuit (a hard zero
// would freeze any sub-dead-zone perp residue at the ball).
export const APPROACH_RAMP_DIST = 80;
export const APPROACH_MIN_MAGNITUDE = 0.15;

// Lateral sidestep — only when self is at true pair contact AND
// can't kick. Trigger distance is just outside the pair-collision
// min (2 * STICKMAN_HEAD_RADIUS = 8) so the bias engages only at
// real contact, not whenever the players are merely near. Gated on
// !selfHasKickReach in decision.js so kicking always takes priority
// over circling — without this, the player ends up walking around
// the ball without ever facing it.
export const SIDESTEP_TRIGGER_DIST = 10;
export const SIDESTEP_OFFSET = 12;

// Lead distance (physics units) — how much closer self has to be than
// opp to commit to a disruptive push while opp is mid-windup. Lets self
// reach opp before opp's kick fires.
export const PUSH_WINDUP_LEAD_DIST = 30;

export const KICK_AIM_OFFSET_RANGE = 0.03;
export const PUSH_POWER_RANGE = 0.10;
export const KICK_POWER_NEAR = 0.6;
export const KICK_POWER_FAR = 1.0;

export const PUSH_POWER_BASE = 0.8;
export const PUSH_RANGE_FRAC = 0.9;

// Floating-point dead zone on the action MOVE vector — values below this
// magnitude are treated as zero. Paired with `MOVE_INPUT_DEAD_ZONE` in
// physics/tuning.js (same value, applied symmetrically on both sides of the seam).
export const FALLBACK_DEAD_ZONE = 0.02;
export const FALLBACK_CAPTURE_RADIUS = PLAYER_WIDTH / 2;
// canKickReach margin. Zero means the controller's reach gate matches
// physics' tryStartKick gate exactly. Effective horizontal kick reach is
// ~12.25 world units (3D leg-budget 20, with ~15.8 always burned by the
// hip-to-ground vertical drop).
export const FALLBACK_SAFETY_MARGIN = 0;

export const ATTACK_OFFSET = BALL_RADIUS + 2;

export const NEAR_BLOCK_DIST = 20;
export const NEAR_BLOCK_RADIUS = PLAYER_WIDTH / 2 + BALL_RADIUS;

export const GOALIE_THREAT_VEL = 2.0;

export const LOB_OPPONENT_BLOCK_DIST = 30;
export const LOB_KICK_DZ = 0.7;

export const LOB_BALL_FAST = 6.0;

// Minimum ball altitude (world-z above ground) for the airkick lob to
// fire. Below this the ball is effectively on the ground and the
// airkick — which makes the player jump up and strike at the peak of
// the jump arc — would whiff over the top of a ball that never left
// the floor.
export const LOB_MIN_BALL_Z = 5;
