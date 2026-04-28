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
