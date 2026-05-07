/**
 * Debug overlay tuning constants.
 *
 * Colours, opacities, and ground-lift offsets for the translucent
 * collider overlay rendered by debug-overlay.js. Adjust here, no edits
 * elsewhere needed. Physics-collider dimensions live in physics/tuning.js.
 */

// Render-order priority — overlay sits on top of the regular scene.
export const OVERLAY_RENDER_ORDER = 1000;

/* ── Colours per collider class ──────────────────────────────── */

export const COLOR_BODY       = 0xff5555;   // red — torso capsule
export const COLOR_HEAD       = 0xff9944;   // orange — head sphere
export const COLOR_PAIR       = 0xffd866;   // yellow — pair-collision disc
export const COLOR_KICK       = 0x66dd88;   // green — kick reach + face cone + lateral cap
export const COLOR_FOOT       = 0xee66ff;   // magenta — foot sphere
export const COLOR_PUSH       = 0x66bbff;   // blue — push range + face cone
export const COLOR_GOAL_BOX   = 0xff77cc;   // pink — goal interior planes
export const COLOR_GOAL_BAR   = 0xcc44dd;   // purple — posts + crossbar
export const COLOR_TOUCHLINE  = 0x66eedd;   // cyan — field touchline walls
export const COLOR_GROUND_SKY = 0xcccccc;   // grey — ground + ceiling

/* ── Opacities ───────────────────────────────────────────────── */

export const OPACITY_BODY        = 0.22;
export const OPACITY_HEAD        = 0.22;
export const OPACITY_PAIR        = 0.18;
export const OPACITY_KICK_BUDGET = 0.10;    // bounding sphere (looser)
export const OPACITY_KICK_CONE   = 0.18;
export const OPACITY_FOOT        = 0.55;
export const OPACITY_PUSH_PLATE  = 0.14;
export const OPACITY_PUSH_CONE   = 0.22;
export const OPACITY_GOAL_BOX    = 0.18;
export const OPACITY_GOAL_BAR    = 0.45;
export const OPACITY_TOUCHLINE   = 0.04;    // environmental — barely there
export const OPACITY_GROUND      = 0.025;
export const OPACITY_LATERAL     = 0.55;    // line slab

/* ── Z-fight avoidance lifts ─────────────────────────────────── */

export const SLAB_LIFT_Y       = 0.07;
export const PUSH_PLATE_LIFT_Y = 0.05;
export const PUSH_CONE_LIFT_Y  = 0.08;
export const PAIR_DISC_LIFT_Y  = 0.06;
export const KICK_CONE_LIFT_Y  = 0.07;
export const GROUND_LIFT_Y     = 0.02;
