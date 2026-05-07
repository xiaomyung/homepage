/**
 * Football v2 — renderer tuning constants.
 *
 * Visual / camera / particle / label / shadow / debug-cam tunables.
 * World-model constants (BALL_RADIUS, STICKMAN_*, Z_STRETCH, etc.) live
 * in physics/tuning.js; they are imported here only when a derived
 * renderer constant needs them. No magic numbers anywhere outside
 * this file inside the renderer.
 */

import {
  BALL_RADIUS,
  STICKMAN_TORSO_RADIUS,
  STICKMAN_LEG_RADIUS,
  STICKMAN_LOWER_ARM_RADIUS,
} from '../physics/index.js';

/* ── Layout ──────────────────────────────────────────────────── */

// Small margin so field edges don't touch the canvas boundary.
export const HORIZONTAL_MARGIN = 1.15;

/* ── Stickman rig (renderer-only — physics rig dimensions are in physics/tuning.js) ── */

// Stamina fill capsule is inset inside the outline shell, creating a
// visible "shell wall" (the outline appears thicker inward while the
// outer silhouette is unchanged). Delta is in world units.
export const STICKMAN_TORSO_SHELL_THICKNESS = 1.0;
export const STICKMAN_TORSO_FILL_RADIUS     = STICKMAN_TORSO_RADIUS - STICKMAN_TORSO_SHELL_THICKNESS;
// Joint spheres — a small bump at each hinge. Slightly under the
// shaft radius so they read as joint detail, not a growth.
export const STICKMAN_KNEE_RADIUS  = STICKMAN_LEG_RADIUS * 0.92;
export const STICKMAN_ELBOW_RADIUS = STICKMAN_LOWER_ARM_RADIUS * 0.92;
// Sphere pool: 1 head + 2 elbows + 2 knees = 5 per stickman × 2
// stickmen = 10, plus 2 spare = 12.
export const STICKMAN_SPH_POOL = 12;

// Ball visual radius mirrors physics so the rendered sphere and
// the collision envelope are the same object.
export const BALL_VISUAL_RADIUS = BALL_RADIUS;

// Stamina indicator opacity for the torso outline shell.
export const STAMINA_OUTLINE_OPACITY = 0.55;

/* ── Math helpers ────────────────────────────────────────────── */

export const TWO_PI = Math.PI * 2;

/* ── Particles ───────────────────────────────────────────────── */

export const PARTICLE_POOL          = 120;
export const PARTICLE_BASE_COUNT    = 2;    // minimum particles per bounce
export const PARTICLE_FORCE_COUNT   = 1.4;  // extra particles per force unit
export const PARTICLE_MAX_COUNT     = 14;
export const PARTICLE_BASE_SPEED    = 0.25; // outward speed as fraction of force
export const PARTICLE_SPREAD        = 0.6;  // lateral randomness multiplier
export const PARTICLE_LIFE_BASE     = 18;   // frames
export const PARTICLE_LIFE_VARIANCE = 10;
export const PARTICLE_GRAVITY       = 0.28;
export const PARTICLE_GROUND_DRAG   = 0.45;
export const PARTICLE_VISUAL_RADIUS = 0.9;

// Footstep burst — fires twice per walk cycle (one per planted foot).
export const FOOTSTEP_MIN_SPEED   = 1.5;  // physics units / tick — gates idle/turn
export const FOOTSTEP_BASE_COUNT  = 1;
export const FOOTSTEP_FORCE_COUNT = 7;    // extra particles per unit speed01
export const FOOTSTEP_MAX_COUNT   = 8;
export const FOOTSTEP_SPEED       = 1.1;  // world units / frame at speed=1
export const FOOTSTEP_BACK_OFFSET = 4;    // spawn offset behind motion vector

// Push-contact burst — fires when a punch lands on the victim.
export const PUSH_CONTACT_BASE_COUNT  = 8;
export const PUSH_CONTACT_FORCE_COUNT = 14;   // extra particles per unit force
export const PUSH_CONTACT_MAX_COUNT   = 22;
export const PUSH_CONTACT_SPEED       = 1.6;  // world units / frame at force=1
export const PUSH_CONTACT_LIFT_BIAS   = 0.45; // adds to the up axis component

// Goal-scored burst — much bigger and longer-lived than a bounce.
export const GOAL_BURST_COUNT     = 42;
export const GOAL_BURST_SPEED     = 1.8;
export const GOAL_BURST_LIFT      = 1.6;   // upward kick
export const GOAL_BURST_LIFE_BASE = 35;
export const GOAL_BURST_LIFE_VAR  = 20;

/* ── Camera ──────────────────────────────────────────────────── */

export const CAMERA_FOV       = 60;
export const CAMERA_TILT_DEG  = 55;

// Follow-cam zoom multipliers — smaller = closer.
export const FOLLOW_ZOOM_LIVE     = 0.60;
export const FOLLOW_ZOOM_DEAD     = 1.00;
// Lead distance fraction — actionX is offset by leadX = ballSide *
// distance * LEAD_FRACTION so the camera looks slightly past the ball
// in the direction of play.
export const FOLLOW_LEAD_FRACTION = 0.22;

// Debug freecam input sensitivities.
export const DEBUG_CAM_DRAG_SENS  = 0.005;   // rad / pixel
export const DEBUG_CAM_PAN_FRAC   = 0.01;    // fraction of distance per frame
export const DEBUG_CAM_WHEEL_SENS = 0.001;   // dist multiplier per wheel-delta
export const DEBUG_CAM_DIST_MIN   = 40;
export const DEBUG_CAM_DIST_MAX   = 4000;

/* ── Name labels (billboarded sprites above the head) ────────── */

export const NAME_LABEL_HEAD_GAP     = 5;
export const NAME_LABEL_CANVAS_W     = 256;
export const NAME_LABEL_CANVAS_H     = 64;
export const NAME_LABEL_FONT         = '500 38px "Iosevka Term", monospace';
export const NAME_LABEL_TEXT_COLOR   = '#cdd6f4';
export const NAME_LABEL_SHADOW_COLOR = 'rgba(0,0,0,0.9)';
export const NAME_LABEL_SHADOW_BLUR  = 6;
export const NAME_LABEL_SCALE_X      = 36;
export const NAME_LABEL_SCALE_Y      = 9;
// Overlap-fade thresholds (screen-space pixels between the two labels).
export const NAME_LABEL_FADE_BELOW   = 80;
export const NAME_LABEL_FADE_FULL    = 30;

/* ── Shadows ─────────────────────────────────────────────────── */

// Ball shadow scaling per world-z of altitude — shadow grows + fades
// as the ball climbs.
export const BALL_SHADOW_GROWTH_PER_Z = 0.04;
export const BALL_SHADOW_FADE_PER_Z   = 0.06;

export const PLAYER_SHADOW_RADIUS = 12;   // world units — fits under stickman silhouette
export const SHADOW_ALPHA_BASE    = 0.55;
export const SHADOW_Y             = 0.2;  // tiny offset above ground to avoid z-fight with field lines

// Soft drop-shadow disc (flat on the xz plane). Center is opaque,
// fading to transparent at the edge.
export const SHADOW_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Fragment outputs a dim gray, not pure black — on the black page
// background a true black shadow is invisible. The gray reads as a
// subtle ground-contact disc instead.
export const SHADOW_FRAGMENT_SHADER = /* glsl */ `
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p);
    float falloff = smoothstep(0.5, 0.15, d);
    float a = falloff * uAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.22, 0.22, 0.24, a);
  }
`;

/* ── Rest stars (exhausted player's orbiting indicator) ──────── */

export const REST_STAR_RADIUS_FRAC   = 1.55;  // × head radius — orbit radius
export const REST_STAR_HEIGHT_FRAC   = 0.85;  // × head radius — vertical lift
export const REST_STAR_SCALE_BASE    = 0.6;   // baseline visual scale
export const REST_STAR_SCALE_OPACITY = 0.4;   // opacity-modulated scale
export const REST_STAR_TUMBLE_FRAC   = 0.6;   // tumble-vs-orbit ratio
export const REST_STAR_COUNTER_SPIN  = -1.6;  // counter-spin rad/sec

/* ── Palette (matches style.css design tokens) ───────────────── */

// Pre-converted from the source hex values (#d0d0d0, #f7768e, #e0af68,
// #9ece6a) into normalized [r, g, b] triples. The conversion is
// `parseInt(hh, 16) / 255` per channel — kept eager here so renderer
// modules can import these as plain values without going through
// rgb() at module-init time.
const _hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
};

export const COLOR_TEXT     = _hexToRgb('#d0d0d0');
export const COLOR_STAM_LOW = _hexToRgb('#f7768e');
export const COLOR_STAM_MID = _hexToRgb('#e0af68');
export const COLOR_STAM_HIGH = _hexToRgb('#9ece6a');
