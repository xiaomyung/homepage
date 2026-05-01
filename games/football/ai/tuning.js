/**
 * AI controller tunables — single source of truth.
 * Tests import from here so changes don't break tests.
 */

import { TICK_MS, PLAYER_WIDTH, BALL_RADIUS } from '../physics.js';

export const ACTION_STRIDE_TICKS = 1;

export const MATCH_DURATION_MS = 60000;
export const MAX_SHOWCASE_TICKS = 8000;

export const PREDICTION_HORIZON_TICKS = Math.round(500 / TICK_MS);

export const ROLE_HYSTERESIS_TICKS = 15;
export const CONTENDER_MARGIN_TICKS = 2;

export const STAMINA_CONSERVE_THRESHOLD = 0.30;
export const STAMINA_CONSERVE_MAGNITUDE = 0.7;

// CONTENDER_KICK still emits a small forward MOVE so the player keeps
// nudging into the ball at low speed. Without it, MOVE=0 stops the
// player and freezes heading; any small ball drift then breaks the
// face cone, the intent flips back to CONTENDER_RUN, and the visible
// effect is wiggling-near-the-ball. The half-speed nudge keeps the
// heading tracking the ball; once tryStartKick succeeds and
// kick.active=true, physics' applyAction returns before applyMovement
// so the kick animation isn't disturbed.
export const CONTENDER_KICK_NUDGE_MAGNITUDE = 0.4;

// Inertia handling: with PLAYER_ACCEL = 0.5/tick, stopping from full
// speed (10) takes 20 ticks and ~100 world units. Without slowdown on
// approach, the player runs onto the ball at full speed and then one
// tick of CONTENDER_KICK movement carries them past — kick gets
// rejected with 'facing_away' because the ball is now behind them.
//
// Linear magnitude ramp: at distance ≥ APPROACH_RAMP_DIST the player
// runs full speed; at distance 0 they're at APPROACH_MIN_MAGNITUDE.
// 80-unit ramp gives ~12 ticks of decel from full speed, which is
// enough to end up at a controlled 4 units/tick at the ball.
export const APPROACH_RAMP_DIST = 80;
export const APPROACH_MIN_MAGNITUDE = 0.4;

// Lateral sidestep — only when self is at true pair contact AND
// can't kick. Trigger distance is just outside the pair-collision
// min (2 * STICKMAN_HEAD_RADIUS = 8) so the bias engages only at
// real contact, not whenever the players are merely near. Gated on
// !selfHasKickReach in decision.js so kicking always takes priority
// over circling — without this, the player ends up walking around
// the ball without ever facing it.
export const SIDESTEP_TRIGGER_DIST = 10;
export const SIDESTEP_OFFSET = 12;


export const KICK_AIM_OFFSET_RANGE = 0.03;
export const PUSH_POWER_RANGE = 0.10;
export const KICK_POWER_NEAR = 0.6;
export const KICK_POWER_FAR = 1.0;

export const PUSH_POWER_BASE = 0.8;
export const PUSH_RANGE_FRAC = 0.9;

// Was 0.15 to filter NN noise; for the deterministic controller it
// just throws away small lateral corrections needed to align with
// the ball's physics-y. Dropped to 0.02 (floating-point-only). Paired
// with the same change in physics' MOVE_INPUT_DEAD_ZONE.
export const FALLBACK_DEAD_ZONE = 0.02;
export const FALLBACK_CAPTURE_RADIUS = PLAYER_WIDTH / 2;
// canKickReach safety margin — was 2 to keep the AI from emitting
// kicks at the very edge of physics' tryStartKick reach. With the
// distance-based approach slowdown the player no longer arrives at
// the edge with full velocity, so the buffer isn't needed. Dropping
// to 0 makes canKickReach match tryStartKick exactly: effective
// horizontal reach grows from ~8.6 to ~12.25 (3D budget is 20, with
// 15.8 always burned by hip-to-ground vertical), so kicks fire
// substantially earlier.
export const FALLBACK_SAFETY_MARGIN = 0;

export const ATTACK_OFFSET = BALL_RADIUS + 2;

export const NEAR_BLOCK_DIST = 20;
export const NEAR_BLOCK_RADIUS = PLAYER_WIDTH / 2 + BALL_RADIUS;

export const GOALIE_THREAT_VEL = 2.0;
export const GOALIE_THREAT_X_FRAC = 0.5;

export const LOB_OPPONENT_BLOCK_DIST = 30;
export const LOB_KICK_DZ = 0.7;

export const LOB_BALL_FAST = 6.0;
