/**
 * AI controller tunables — single source of truth.
 * Tests import from here so changes don't break tests.
 */

import { TICK_MS, PLAYER_WIDTH, BALL_RADIUS } from '../physics.js';

export const ACTION_STRIDE_TICKS = 1;

export const MATCH_DURATION_MS = 30000;
export const MAX_SHOWCASE_TICKS = 4000;

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

// Lateral sidestep — when self is within SIDESTEP_TRIGGER_DIST of opp,
// the move target is biased perpendicular to the self→opp axis (toward
// the side that puts target nearer). Stops players dwelling at pair
// contact and reads as "try to circle around" instead of "press into".
// Trigger distance is a few units beyond the new pair-collision min
// (2 * STICKMAN_HEAD_RADIUS = 8) so the bias engages before contact.
export const SIDESTEP_TRIGGER_DIST = 14;
export const SIDESTEP_OFFSET = 12;


export const KICK_AIM_OFFSET_RANGE = 0.03;
export const PUSH_POWER_RANGE = 0.10;
export const KICK_POWER_NEAR = 0.6;
export const KICK_POWER_FAR = 1.0;

export const PUSH_POWER_BASE = 0.8;
export const PUSH_RANGE_FRAC = 0.9;

export const FALLBACK_DEAD_ZONE = 0.15;
export const FALLBACK_CAPTURE_RADIUS = PLAYER_WIDTH / 2;
export const FALLBACK_SAFETY_MARGIN = 2;

export const ATTACK_OFFSET = BALL_RADIUS + 2;

export const NEAR_BLOCK_DIST = 20;
export const NEAR_BLOCK_RADIUS = PLAYER_WIDTH / 2 + BALL_RADIUS;

export const GOALIE_THREAT_VEL = 2.0;
export const GOALIE_THREAT_X_FRAC = 0.5;

export const LOB_OPPONENT_BLOCK_DIST = 30;
export const LOB_KICK_DZ = 0.7;

export const LOB_BALL_FAST = 6.0;
