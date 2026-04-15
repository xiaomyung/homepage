"""
Football v2 — Python port of games/football/physics.js.

Line-for-line translation with bit-identical PRNG and operation order. Used by:
  - build_warm_start.py to run fallback-vs-fallback matches for imitation data
  - local_test.py to run CLI training smoke tests without a browser

Parity against physics.js is enforced by tests/test_parity.py (spawns Node to
run the JS version on the same scenario, tick-by-tick comparison to 1e-9
tolerance; transcendentals may drift one ULP, hence 1e-6 on kick paths).

If the parity test fails, this file is wrong — the JS version is canonical.
"""

import math
from typing import Optional

# ── Constants (must match physics.js) ──────────────────────────

FIELD_WIDTH_REF = 900
FIELD_HEIGHT = 54.6
CEILING = 100

TICK_MS = 16
STALL_TICKS = math.ceil(10000 / TICK_MS)

# Ball
GRAVITY = 0.3
AIR_FRICTION = 0.99
GROUND_FRICTION = 0.944
BOUNCE_RETAIN = 0.8
AIR_BOUNCE = 0.6
WALL_BOUNCE_DAMP = 0.5
BOUNCE_VZ_MIN = 1.5
BALL_VEL_CUTOFF = 0.1
BALL_VEL_CUTOFF_SQ = BALL_VEL_CUTOFF * BALL_VEL_CUTOFF
BALL_RADIUS = 1.8711
RESPAWN_DROP_Z = 60

# Player
MAX_PLAYER_SPEED = 10
# Acceleration cap — see physics.js for rationale and tuning.
PLAYER_ACCEL_TICKS = 20
PLAYER_ACCEL = MAX_PLAYER_SPEED / PLAYER_ACCEL_TICKS
MOVE_THRESHOLD = 0.1
MOVE_THRESHOLD_SQ = MOVE_THRESHOLD * MOVE_THRESHOLD
STARTING_GAP = 40
PLAYER_WIDTH = 18
PLAYER_HEIGHT = 6
MIN_SPEED_STAMINA = 0.3

# Heading — must match physics.js exactly (parity-critical).
Z_STRETCH = 4.7
PLAYER_TURN_TICKS = 20
PLAYER_TURN_RATE = math.pi / PLAYER_TURN_TICKS
KICK_FACE_TOL = math.pi / 3
PUSH_FACE_TOL = math.pi / 3

# Stamina
STAMINA_REGEN = 0.005
STAMINA_MOVE_BASE = 0.003
STAMINA_MOVE_PER_UNIT = 0.00036
STAMINA_MOVE_THRESHOLD = 0.1
DIRECTION_CHANGE_DRAIN = 0.02
STAMINA_EXHAUSTION_THRESHOLD = 0.5
STAMINA_KICK_DRAIN = 0.3
STAMINA_AIRKICK_DRAIN = 0.1

# Kick
MAX_KICK_POWER = 22
MIN_KICK_POWER = 0.15
MIN_KICK_STAMINA = 0.2
KICK_NOISE_SCALE = 0.3
KICK_NOISE_VERT = 0.5
# Ground-kick reach: lateral leg extension is ~0, so depth tolerance
# is body-half + ball radius + small animation slack. Must stay in
# lock-step with physics.js — see test_parity.
KICK_REACH_SLACK_Y = 1.5
KICK_REACH_X_MULT = 1.0
KICK_REACH_Y = PLAYER_HEIGHT / 2 + BALL_RADIUS + KICK_REACH_SLACK_Y
AIRKICK_REACH_SLACK_Y = 3
AIRKICK_REACH_X_MULT = 1.5
AIRKICK_REACH_Y = PLAYER_HEIGHT / 2 + BALL_RADIUS + AIRKICK_REACH_SLACK_Y
AIRKICK_MAX_Z = 20
AIRKICK_MS = 350
AIRKICK_PEAK_FRAC = 0.4
AIRKICK_DZ_THRESHOLD = 0.5
# Ground-kick timing: fire impact at KICK_WINDUP_MS, deactivate at
# KICK_DURATION_MS (total elapsed, not a separate span).
KICK_WINDUP_MS = 96
KICK_DURATION_MS = 288
KICK_DIR_MIN_LEN = 0.01
WASTED_KICK_SPEED = MIN_KICK_POWER * 0.1

# Push
PUSH_RANGE_X = 30
# Push range on depth axis: fists have ~0 lateral reach, so bodies
# must overlap or near-touch in y. PLAYER_HEIGHT + slack.
PUSH_RANGE_SLACK_Y = 1
PUSH_RANGE_Y = PLAYER_HEIGHT + PUSH_RANGE_SLACK_Y
MAX_PUSH_FORCE = 200
PUSH_DAMP = 0.88
PUSH_APPLY = 0.12
PUSH_VEL_THRESHOLD = 0.5
PUSH_VEL_THRESHOLD_SQ = PUSH_VEL_THRESHOLD * PUSH_VEL_THRESHOLD
MIN_PUSH_STAMINA = 0.2
PUSH_ANIM_MS = 300
PUSH_STAMINA_COST = 0.15
PUSH_VICTIM_STAMINA_MULT = 3

# Goal
GOAL_BACK_OFFSET = 30
GOAL_DEPTH = 78
GOAL_LINE_INSET = 6
GOAL_POST_RADIUS = 1.2  # must match physics.js and renderer GOAL_BAR_RADIUS
GOAL_MOUTH_Z = 26  # crossbar height (unchanged)
GOAL_MOUTH_WIDTH = 28.6  # z-span of the mouth (30% + another 10% wider than the original 20)
GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - GOAL_MOUTH_WIDTH) / 2
GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + GOAL_MOUTH_WIDTH) / 2

# Match
WIN_SCORE = 3
CELEBRATE_TICKS = math.ceil(1500 / TICK_MS)
MATCHEND_PAUSE_TICKS = math.ceil(3000 / TICK_MS)
RESPAWN_GRACE = 30
REPOSITION_SPEED = 6
REPOSITION_TOL = 5
RESPAWN_DELAY_TICKS = math.ceil(300 / TICK_MS)


# ── Seeded PRNG (bit-identical to physics.js createSeededRng) ──

def create_seeded_rng(seed: int):
    """LCG PRNG matching the JS createSeededRng() exactly.

    JS: state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    Py: state = ((state * 1664525) + 1013904223) & 0xFFFFFFFF

    (a * b + c) mod 2^32 is bit-identical regardless of signed/unsigned
    interpretation, so the LCG output streams match.
    """
    state = [(seed & 0xFFFFFFFF) or 1]

    def rng() -> float:
        state[0] = ((state[0] * 1664525) + 1013904223) & 0xFFFFFFFF
        return state[0] / 4294967296

    return rng


def gauss_random(rng) -> float:
    """Box-Muller matching physics.js gaussRandom()."""
    u1 = rng() or 1e-10
    u2 = rng()
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


# ── Field / state factories ────────────────────────────────────

def create_field(width: float = FIELD_WIDTH_REF) -> dict:
    goal_l_left = GOAL_BACK_OFFSET
    goal_l_right = goal_l_left + GOAL_DEPTH
    goal_r_right = width - GOAL_BACK_OFFSET
    goal_r_left = goal_r_right - GOAL_DEPTH
    return {
        "width": width,
        "height": FIELD_HEIGHT,
        "ceiling": CEILING,
        "playerWidth": PLAYER_WIDTH,
        "playerHeight": PLAYER_HEIGHT,
        "goalLLeft": goal_l_left,
        "goalLRight": goal_l_right,
        "goalRLeft": goal_r_left,
        "goalRRight": goal_r_right,
        "goalLineL": goal_l_right - GOAL_LINE_INSET,
        "goalLineR": goal_r_left + GOAL_LINE_INSET,
        "goalMouthYMin": GOAL_MOUTH_Y_MIN,
        "goalMouthYMax": GOAL_MOUTH_Y_MAX,
        "goalMouthZMax": GOAL_MOUTH_Z,
        "midX": width / 2,
        "aiLimitL": goal_l_left + GOAL_LINE_INSET,
        "aiLimitR": goal_r_right - GOAL_LINE_INSET,
    }


def _create_player(side: str, field: dict) -> dict:
    x = (
        field["midX"] - STARTING_GAP - field["playerWidth"] / 2
        if side == "left"
        else field["midX"] + STARTING_GAP - field["playerWidth"] / 2
    )
    return {
        "side": side,
        "x": x,
        "y": FIELD_HEIGHT / 2,
        "vx": 0,
        "vy": 0,
        "pushVx": 0,
        "pushVy": 0,
        "stamina": 1,
        "exhausted": False,
        # Pre-allocated kick slot, gated by `.active`.
        "kick": {
            "active": False,
            "phase": "windup",
            "timer": 0,
            "airZ": 0,
            "fired": False,
            "dx": 0,
            "dy": 0,
            "dz": 0,
            "power": 0,
        },
        "pushTimer": 0,
        # Heading: 0 = facing +x (opposing goal for left side).
        "heading": 0.0 if side == "left" else math.pi,
        # Previous commanded move direction, per axis — used by
        # _apply_movement to fire DIRECTION_CHANGE_DRAIN only on
        # actual target-sign flips, not continuously.
        "prevTargetDirX": 0,
        "prevTargetDirY": 0,
        "airZ": 0,
    }


def create_state(field: dict, rng=None) -> dict:
    if rng is None:
        rng = create_seeded_rng(0)
    return {
        "field": field,
        "rng": rng,
        "ball": {
            "x": field["midX"],
            "y": FIELD_HEIGHT / 2,
            "vx": 0,
            "vy": 0,
            "z": RESPAWN_DROP_Z,
            "vz": 0,
            "frozen": False,
        },
        "p1": _create_player("left", field),
        "p2": _create_player("right", field),
        "scoreL": 0,
        "scoreR": 0,
        "tick": 0,
        "graceFrames": RESPAWN_GRACE,
        "lastKickTick": 0,
        "pauseState": None,
        "pauseTimer": 0,
        "goalScorer": None,
        "matchOver": False,
        "winner": None,
        "events": [],
        "recordEvents": False,
    }


# ── Main tick ──────────────────────────────────────────────────

def tick(state: dict, p1_act: Optional[list], p2_act: Optional[list]) -> dict:
    if state["recordEvents"]:
        state["events"].clear()
    state["tick"] += 1

    if state["matchOver"]:
        return state

    if state["pauseState"] is not None:
        _advance_pause(state)
        return state

    if state["graceFrames"] > 0:
        state["graceFrames"] -= 1

    pre1x, pre1y = state["p1"]["x"], state["p1"]["y"]
    pre2x, pre2y = state["p2"]["x"], state["p2"]["y"]

    _apply_regen_and_exhaustion(state["p1"])
    _apply_regen_and_exhaustion(state["p2"])

    if p1_act is not None:
        _apply_action(state, state["p1"], p1_act)
    if p2_act is not None:
        _apply_action(state, state["p2"], p2_act)

    _apply_push_physics(state["p1"])
    _apply_push_physics(state["p2"])

    _clamp_and_collide(state, state["p1"])
    _clamp_and_collide(state, state["p2"])

    _charge_stamina_from_displacement(state["p1"], pre1x, pre1y)
    _charge_stamina_from_displacement(state["p2"], pre2x, pre2y)

    _update_ball(state)
    _check_ball_score_or_out(state)
    # Goal-frame collision runs after the scoring check — see the
    # JS companion for the design.
    field = state["field"]
    _resolve_ball_goal_box(state, _goal_box(field, "left"))
    _resolve_ball_goal_box(state, _goal_box(field, "right"))

    if state["tick"] - state["lastKickTick"] > STALL_TICKS:
        _reset_ball(state)
        state["lastKickTick"] = state["tick"]

    return state


# ── Regen / exhaustion ─────────────────────────────────────────

def _apply_regen_and_exhaustion(p: dict) -> None:
    if p["stamina"] <= 0:
        p["exhausted"] = True
    if p["exhausted"] and p["stamina"] >= STAMINA_EXHAUSTION_THRESHOLD:
        p["exhausted"] = False
    p["stamina"] = min(1, p["stamina"] + STAMINA_REGEN)


# ── Action dispatch ───────────────────────────────────────────

# Action layout: [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower]
def _apply_action(state: dict, p: dict, out: list) -> None:
    # In-flight kicks must always tick forward to completion — even if the
    # player became exhausted during the kick.
    if _advance_kick(state, p):
        return

    # Push cooldown decrements unconditionally so a push issued right before
    # a kick doesn't get frozen at max for the kick's duration.
    if p["pushTimer"] > 0:
        p["pushTimer"] -= TICK_MS
        if p["pushTimer"] < 0:
            p["pushTimer"] = 0
        return

    if p["exhausted"]:
        p["vx"] = 0
        p["vy"] = 0
        return

    _apply_movement(state, p, out[0], out[1])

    if out[7] > 0:
        opp = state["p2"] if p is state["p1"] else state["p1"]
        _try_push(state, p, opp, out[8])

    if out[2] > 0 and _can_kick(state, p):
        _start_kick(p, out[3], out[4], out[5], out[6])


# ── Movement ───────────────────────────────────────────────────

def _wrap_angle(a: float) -> float:
    """Shortest-arc signed difference in (-pi, pi]. Matches physics.js."""
    while a > math.pi:
        a -= 2 * math.pi
    while a <= -math.pi:
        a += 2 * math.pi
    return a


def _turn_toward(current: float, target: float) -> float:
    diff = _wrap_angle(target - current)
    if diff > PLAYER_TURN_RATE:
        return current + PLAYER_TURN_RATE
    if diff < -PLAYER_TURN_RATE:
        return current - PLAYER_TURN_RATE
    return target


def _angle_to_target(p: dict, world_x: float, world_z: float) -> float:
    center_x = p["x"] + PLAYER_WIDTH / 2
    center_z = (p["y"] + PLAYER_HEIGHT / 2) * Z_STRETCH
    return math.atan2(world_z - center_z, world_x - center_x)


def _apply_movement(state: dict, p: dict, move_x: float, move_y: float) -> None:
    eff_speed = MAX_PLAYER_SPEED * max(MIN_SPEED_STAMINA, p["stamina"])
    target_vx = _clamp(move_x, -1, 1) * eff_speed
    target_vy = _clamp(move_y, -1, 1) * eff_speed

    if (p["y"] <= 0 and target_vy < 0) or (p["y"] >= FIELD_HEIGHT - PLAYER_HEIGHT and target_vy > 0):
        target_vy = 0
        p["vy"] = 0
    if (p["x"] <= 0 and target_vx < 0) or (
        p["x"] >= state["field"]["width"] - state["field"]["playerWidth"] and target_vx > 0
    ):
        target_vx = 0
        p["vx"] = 0

    # Fire DIRECTION_CHANGE_DRAIN exactly once per commanded reversal,
    # not every tick while velocity crosses zero toward the new target.
    target_dir_x = 1 if target_vx > 0 else (-1 if target_vx < 0 else 0)
    target_dir_y = 1 if target_vy > 0 else (-1 if target_vy < 0 else 0)
    x_flipped = target_dir_x != 0 and p["prevTargetDirX"] != 0 and target_dir_x != p["prevTargetDirX"]
    y_flipped = target_dir_y != 0 and p["prevTargetDirY"] != 0 and target_dir_y != p["prevTargetDirY"]
    if x_flipped or y_flipped:
        p["stamina"] = max(0, p["stamina"] - DIRECTION_CHANGE_DRAIN)
    p["prevTargetDirX"] = target_dir_x
    p["prevTargetDirY"] = target_dir_y

    dvx = target_vx - p["vx"]
    dvy = target_vy - p["vy"]
    dv_mag = math.sqrt(dvx * dvx + dvy * dvy)
    if dv_mag > PLAYER_ACCEL:
        scale = PLAYER_ACCEL / dv_mag
        p["vx"] += dvx * scale
        p["vy"] += dvy * scale
    else:
        p["vx"] = target_vx
        p["vy"] = target_vy

    speed_sq = p["vx"] * p["vx"] + p["vy"] * p["vy"]
    if speed_sq > MOVE_THRESHOLD_SQ:
        p["x"] += p["vx"]
        p["y"] += p["vy"]
        target_heading = math.atan2(p["vy"] * Z_STRETCH, p["vx"])
        p["heading"] = _turn_toward(p["heading"], target_heading)
    else:
        p["vx"] = 0
        p["vy"] = 0


# ── Push physics ──────────────────────────────────────────────

def _apply_push_physics(p: dict) -> None:
    if p["pushVx"] * p["pushVx"] > PUSH_VEL_THRESHOLD_SQ:
        p["x"] += p["pushVx"] * PUSH_APPLY
        p["pushVx"] *= PUSH_DAMP
    else:
        p["pushVx"] = 0
    if p["pushVy"] * p["pushVy"] > PUSH_VEL_THRESHOLD_SQ:
        p["y"] += p["pushVy"] * PUSH_APPLY
        p["pushVy"] *= PUSH_DAMP
    else:
        p["pushVy"] = 0


def _charge_stamina_from_displacement(p: dict, pre_x: float, pre_y: float) -> None:
    dx = p["x"] - pre_x
    dy = p["y"] - pre_y
    dist = math.sqrt(dx * dx + dy * dy)
    if dist < STAMINA_MOVE_THRESHOLD:
        return
    p["stamina"] -= STAMINA_MOVE_BASE + STAMINA_MOVE_PER_UNIT * dist
    if p["stamina"] < 0:
        p["stamina"] = 0


# ── Field bounds & goal-frame collision ──────────────────────
#
# Mirror of physics.js — see the JS doc block for the design:
# a single canonical goal-box AABB per side, shared by players
# (2D) and the ball (3D sphere-as-cube), with push-out along the
# axis of minimum penetration.


def _goal_box(f: dict, side: str) -> dict:
    if side == "left":
        return {
            "minX": f["goalLLeft"], "maxX": f["goalLineL"],
            "minY": f["goalMouthYMin"], "maxY": f["goalMouthYMax"],
            "minZ": 0.0, "maxZ": f["goalMouthZMax"],
        }
    return {
        "minX": f["goalLineR"], "maxX": f["goalRRight"],
        "minY": f["goalMouthYMin"], "maxY": f["goalMouthYMax"],
        "minZ": 0.0, "maxZ": f["goalMouthZMax"],
    }


def _min_penetration_push(ent: dict, box: dict, use_z: bool, vel: dict):
    if ent["maxX"] <= box["minX"] or ent["minX"] >= box["maxX"]:
        return None
    if ent["maxY"] <= box["minY"] or ent["minY"] >= box["maxY"]:
        return None
    if use_z and (ent["maxZ"] <= box["minZ"] or ent["minZ"] >= box["maxZ"]):
        return None

    vx = vel.get("vx", 0) or 0
    vy = vel.get("vy", 0) or 0
    vz = vel.get("vz", 0) or 0
    push_min_x = ent["maxX"] - box["minX"]
    push_max_x = box["maxX"] - ent["minX"]
    push_min_y = ent["maxY"] - box["minY"]
    push_max_y = box["maxY"] - ent["minY"]

    if vx > 0:
        dx = -push_min_x
    elif vx < 0:
        dx = push_max_x
    else:
        dx = -push_min_x if push_min_x < push_max_x else push_max_x
    if vy > 0:
        dy = -push_min_y
    elif vy < 0:
        dy = push_max_y
    else:
        dy = -push_min_y if push_min_y < push_max_y else push_max_y

    EPS = 1e-9
    tx = abs(dx) / (abs(vx) + EPS)
    ty = abs(dy) / (abs(vy) + EPS)

    if not use_z:
        return {"axis": "x", "delta": dx} if tx <= ty else {"axis": "y", "delta": dy}

    push_min_z = ent["maxZ"] - box["minZ"]
    push_max_z = box["maxZ"] - ent["minZ"]
    if vz > 0:
        dz = -push_min_z
    elif vz < 0:
        dz = push_max_z
    else:
        dz = -push_min_z if push_min_z < push_max_z else push_max_z
    tz = abs(dz) / (abs(vz) + EPS)
    if tx <= ty and tx <= tz:
        return {"axis": "x", "delta": dx}
    if ty <= tz:
        return {"axis": "y", "delta": dy}
    return {"axis": "z", "delta": dz}


def _clamp_player_to_field(p: dict, f: dict) -> None:
    if p["x"] < 0:
        p["x"] = 0
    elif p["x"] > f["width"] - f["playerWidth"]:
        p["x"] = f["width"] - f["playerWidth"]
    if p["y"] < 0:
        p["y"] = 0
    elif p["y"] > FIELD_HEIGHT - PLAYER_HEIGHT:
        p["y"] = FIELD_HEIGHT - PLAYER_HEIGHT


def _clamp_and_collide(state: dict, p: dict) -> None:
    f = state["field"]
    _clamp_player_to_field(p, f)
    _resolve_player_goal_box(p, f["playerWidth"], _goal_box(f, "left"))
    _resolve_player_goal_box(p, f["playerWidth"], _goal_box(f, "right"))
    # Goal resolution can push the player past a field edge; re-clamp.
    _clamp_player_to_field(p, f)


def _resolve_player_goal_box(p: dict, pw: float, box: dict) -> None:
    ent = {
        "minX": p["x"], "maxX": p["x"] + pw,
        "minY": p["y"], "maxY": p["y"] + PLAYER_HEIGHT,
    }
    push = _min_penetration_push(ent, box, False, p)
    if push is None:
        return
    if push["axis"] == "x":
        p["x"] += push["delta"]
        p["vx"] = 0
        p["pushVx"] = 0
    else:
        p["y"] += push["delta"]
        p["vy"] = 0
        p["pushVy"] = 0


def _resolve_ball_goal_box(state: dict, box: dict) -> None:
    ball = state["ball"]
    if ball.get("frozen"):
        return

    # Open-mouth exemption — inset by GOAL_POST_RADIUS so a ball
    # clipping the visible post cylinder still bounces. Matches the
    # scoring check exactly.
    in_mouth_y = (
        ball["y"] - BALL_RADIUS >= box["minY"] + GOAL_POST_RADIUS
        and ball["y"] + BALL_RADIUS <= box["maxY"] - GOAL_POST_RADIUS
    )
    in_mouth_z = ball["z"] + BALL_RADIUS <= box["maxZ"] - GOAL_POST_RADIUS
    if in_mouth_y and in_mouth_z:
        return

    ent = {
        "minX": ball["x"] - BALL_RADIUS, "maxX": ball["x"] + BALL_RADIUS,
        "minY": ball["y"] - BALL_RADIUS, "maxY": ball["y"] + BALL_RADIUS,
        "minZ": ball["z"] - BALL_RADIUS, "maxZ": ball["z"] + BALL_RADIUS,
    }
    push = _min_penetration_push(ent, box, True, ball)
    if push is None:
        return
    axis = push["axis"]
    delta = push["delta"]
    if axis == "x":
        ball["x"] += delta
        if ball["vx"] * delta < 0:
            pre_vx = abs(ball["vx"])
            ball["vx"] = -ball["vx"] * BOUNCE_RETAIN
            _record_bounce(state, "x", pre_vx)
    elif axis == "y":
        ball["y"] += delta
        if ball["vy"] * delta < 0:
            pre_vy = abs(ball["vy"])
            ball["vy"] = -ball["vy"] * BOUNCE_RETAIN
            _record_bounce(state, "y", pre_vy)
    else:
        ball["z"] += delta
        if ball["z"] < 0:
            ball["z"] = 0
        if ball["vz"] * delta < 0:
            pre_vz = abs(ball["vz"])
            ball["vz"] = -ball["vz"] * BOUNCE_RETAIN
            _record_bounce(state, "z", pre_vz)


# ── Kick state machine ────────────────────────────────────────

def _can_kick(state: dict, p: dict) -> bool:
    if p["kick"]["active"]:
        return False
    f = state["field"]
    center_x = p["x"] + f["playerWidth"] / 2
    center_y = p["y"] + PLAYER_HEIGHT / 2
    close_x = abs(state["ball"]["x"] - center_x) < f["playerWidth"] * KICK_REACH_X_MULT
    close_y = abs(state["ball"]["y"] - center_y) < KICK_REACH_Y
    if not (close_x and close_y):
        return False
    ball_z = state["ball"]["y"] * Z_STRETCH
    want_angle = _angle_to_target(p, state["ball"]["x"], ball_z)
    return abs(_wrap_angle(want_angle - p["heading"])) < KICK_FACE_TOL


def _start_kick(p: dict, dx: float, dy: float, dz: float, power: float) -> None:
    kick_dx = _clamp(dx, -1, 1)
    kick_dy = _clamp(dy, -1, 1)
    kick_dz = _clamp(dz, -1, 1)
    kick_power = (_clamp(power, -1, 1) + 1) / 2
    k = p["kick"]
    k["active"] = True
    k["timer"] = 0
    k["fired"] = False
    k["dx"] = kick_dx
    k["dy"] = kick_dy
    k["dz"] = kick_dz
    k["power"] = kick_power

    if dz > AIRKICK_DZ_THRESHOLD:
        jump_frac = (dz - AIRKICK_DZ_THRESHOLD) * 2
        k["phase"] = "airkick"
        k["airZ"] = jump_frac * AIRKICK_MAX_Z
        p["stamina"] = max(0, p["stamina"] - STAMINA_AIRKICK_DRAIN)
    else:
        k["phase"] = "windup"
        k["airZ"] = 0


def _advance_kick(state: dict, p: dict) -> bool:
    k = p["kick"]
    if not k["active"]:
        return False
    k["timer"] += TICK_MS

    if k["phase"] == "airkick":
        anim_frac = min(k["timer"] / AIRKICK_MS, 1)
        p["airZ"] = math.sin(anim_frac * math.pi) * k["airZ"]
        if not k["fired"] and anim_frac >= AIRKICK_PEAK_FRAC:
            k["fired"] = True
            _execute_kick(state, p)
        if anim_frac >= 1:
            p["airZ"] = 0
            k["active"] = False
        return True

    if not k["fired"] and k["timer"] >= KICK_WINDUP_MS:
        k["fired"] = True
        _execute_kick(state, p)
    if k["timer"] >= KICK_DURATION_MS:
        k["active"] = False
    return True


def _execute_kick(state: dict, p: dict) -> None:
    f = state["field"]
    ball = state["ball"]
    k = p["kick"]
    which = "p1" if p is state["p1"] else "p2"
    is_airkick = k["phase"] == "airkick"

    if is_airkick and ball["z"] <= 1:
        if state["recordEvents"]:
            state["events"].append({"type": "kick_missed", "player": which, "reason": "airkick_ground_ball"})
        return
    if not is_airkick and ball["z"] > PLAYER_HEIGHT:
        if state["recordEvents"]:
            state["events"].append({"type": "kick_missed", "player": which, "reason": "ground_kick_high_ball"})
        return

    if is_airkick:
        center_x = p["x"] + f["playerWidth"] / 2
        center_y = p["y"] + PLAYER_HEIGHT / 2
        reach_x = f["playerWidth"] * AIRKICK_REACH_X_MULT
        if abs(ball["x"] - center_x) > reach_x or abs(ball["y"] - center_y) > AIRKICK_REACH_Y:
            if state["recordEvents"]:
                state["events"].append({"type": "kick_missed", "player": which, "reason": "airkick_out_of_range"})
            return

    raw_power = max(MIN_KICK_POWER, k["power"])
    force = raw_power * MAX_KICK_POWER * max(MIN_KICK_STAMINA, p["stamina"])

    dx = k["dx"]
    dy = k["dy"]
    dz = k["dz"]

    raw_len = math.sqrt(dx * dx + dy * dy + dz * dz)
    if raw_len < KICK_DIR_MIN_LEN:
        # NN didn't commit — pick a random direction from the seeded stream
        dx = state["rng"]() * 2 - 1
        dy = state["rng"]() * 2 - 1
        dz = state["rng"]() * 0.5
        rand_len = math.sqrt(dx * dx + dy * dy + dz * dz) or 1
        dx /= rand_len
        dy /= rand_len
        dz /= rand_len
    else:
        dx /= raw_len
        dy /= raw_len
        dz /= raw_len

    noise = raw_power * raw_power * KICK_NOISE_SCALE
    dx += gauss_random(state["rng"]) * noise
    dy += gauss_random(state["rng"]) * noise
    dz += gauss_random(state["rng"]) * noise * KICK_NOISE_VERT
    noisy_len = math.sqrt(dx * dx + dy * dy + dz * dz) or 1
    dx /= noisy_len
    dy /= noisy_len
    dz /= noisy_len

    ball["vx"] = dx * force
    ball["vy"] = dy * force
    ball["vz"] = max(0, dz * force)
    ball["frozen"] = False

    p["stamina"] = max(0, p["stamina"] - STAMINA_KICK_DRAIN * raw_power)
    state["lastKickTick"] = state["tick"]

    if state["recordEvents"]:
        ball_speed = math.sqrt(ball["vx"] * ball["vx"] + ball["vy"] * ball["vy"])
        state["events"].append({
            "type": "kick",
            "player": which,
            "power": raw_power,
            "speed": ball_speed,
            "wasted": ball_speed < WASTED_KICK_SPEED,
        })


# ── Push ──────────────────────────────────────────────────────

def _try_push(state: dict, pusher: dict, victim: dict, power_norm: float) -> None:
    f = state["field"]
    pusher_center_x = pusher["x"] + f["playerWidth"] / 2
    victim_center_x = victim["x"] + f["playerWidth"] / 2

    if pusher["kick"]["active"]:
        return
    if pusher["pushTimer"] > 0:
        return
    if abs(pusher_center_x - victim_center_x) > PUSH_RANGE_X:
        return
    if abs(pusher["y"] - victim["y"]) > PUSH_RANGE_Y:
        return

    victim_z = (victim["y"] + PLAYER_HEIGHT / 2) * Z_STRETCH
    want_angle = _angle_to_target(pusher, victim_center_x, victim_z)
    if abs(_wrap_angle(want_angle - pusher["heading"])) > PUSH_FACE_TOL:
        return

    power01 = (_clamp(power_norm, -1, 1) + 1) / 2
    force = power01 * MAX_PUSH_FORCE * max(MIN_PUSH_STAMINA, pusher["stamina"])

    # Push direction from heading, re-normalized in physics space.
    fx_world = math.cos(pusher["heading"])
    fz_world = math.sin(pusher["heading"])
    fy_phys = fz_world / Z_STRETCH
    p_mag = math.sqrt(fx_world * fx_world + fy_phys * fy_phys) or 1.0
    pusher["pushTimer"] = PUSH_ANIM_MS

    victim["pushVx"] = (fx_world / p_mag) * force
    victim["pushVy"] = (fy_phys / p_mag) * force

    pusher["stamina"] = max(0, pusher["stamina"] - PUSH_STAMINA_COST * power01)
    victim["stamina"] = max(
        0, victim["stamina"] - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT
    )

    if state["recordEvents"]:
        pusher_which = "p1" if pusher is state["p1"] else "p2"
        state["events"].append({"type": "push", "pusher": pusher_which, "force": force})


# ── Ball physics ──────────────────────────────────────────────

def _update_ball(state: dict) -> None:
    ball = state["ball"]
    if ball["frozen"]:
        return
    if ball["vx"] == 0 and ball["vy"] == 0 and ball["z"] == 0 and ball["vz"] == 0:
        return

    ball["x"] += ball["vx"]
    ball["y"] += ball["vy"]

    friction = AIR_FRICTION if ball["z"] > 0 else GROUND_FRICTION
    ball["vx"] *= friction
    ball["vy"] *= friction

    if ball["z"] > 0 or ball["vz"] > 0:
        ball["vz"] -= GRAVITY
        ball["z"] += ball["vz"]
        if ball["z"] <= 0:
            pre_vz = abs(ball["vz"])
            ball["z"] = 0
            if pre_vz > BOUNCE_VZ_MIN:
                ball["vz"] = pre_vz * AIR_BOUNCE
                _record_bounce(state, "z", pre_vz)
            else:
                ball["vz"] = 0

    if ball["y"] < BALL_RADIUS:
        pre_vy = abs(ball["vy"])
        ball["y"] = BALL_RADIUS
        ball["vy"] = pre_vy * WALL_BOUNCE_DAMP
        _record_bounce(state, "y", pre_vy)
    elif ball["y"] > FIELD_HEIGHT - BALL_RADIUS:
        pre_vy = abs(ball["vy"])
        ball["y"] = FIELD_HEIGHT - BALL_RADIUS
        ball["vy"] = -pre_vy * WALL_BOUNCE_DAMP
        _record_bounce(state, "y", pre_vy)

    if ball["z"] > CEILING:
        pre_vz = abs(ball["vz"])
        ball["z"] = CEILING
        ball["vz"] = -pre_vz * AIR_BOUNCE
        _record_bounce(state, "z", pre_vz)

    if ball["vx"] * ball["vx"] < BALL_VEL_CUTOFF_SQ:
        ball["vx"] = 0
    if ball["vy"] * ball["vy"] < BALL_VEL_CUTOFF_SQ:
        ball["vy"] = 0


def _check_ball_score_or_out(state: dict) -> None:
    f = state["field"]
    ball = state["ball"]
    if ball["frozen"]:
        return

    if ball["x"] + BALL_RADIUS < 0 or ball["x"] - BALL_RADIUS > f["width"]:
        _ball_out(state)
        return

    if state["graceFrames"] > 0:
        return

    crossed_l = ball["x"] < f["goalLineL"]
    crossed_r = ball["x"] > f["goalLineR"]
    if not crossed_l and not crossed_r:
        return

    fully_past_l = ball["x"] + BALL_RADIUS <= f["goalLineL"]
    fully_past_r = ball["x"] - BALL_RADIUS >= f["goalLineR"]
    # Mouth inset by GOAL_POST_RADIUS so ball must be fully clear
    # of the physical post / crossbar cylinders to count as in.
    within_mouth_y = (
        ball["y"] - BALL_RADIUS >= f["goalMouthYMin"] + GOAL_POST_RADIUS
        and ball["y"] + BALL_RADIUS <= f["goalMouthYMax"] - GOAL_POST_RADIUS
    )
    below_crossbar = (
        ball["z"] + BALL_RADIUS <= f["goalMouthZMax"] - GOAL_POST_RADIUS
    )

    goal_l = crossed_l and fully_past_l and within_mouth_y and below_crossbar
    goal_r = crossed_r and fully_past_r and within_mouth_y and below_crossbar
    if goal_l or goal_r:
        _score_goal(state, "left" if goal_l else "right")


BOUNCE_EVENT_MIN = 0.3


def _record_bounce(state: dict, axis: str, force: float) -> None:
    """Emit a ball-bounce event for the renderer's particle system. Only
    fires when recordEvents is on; gated at BOUNCE_EVENT_MIN so tiny
    settle-bounces don't spam the event stream."""
    if not state["recordEvents"]:
        return
    if force < BOUNCE_EVENT_MIN:
        return
    ball = state["ball"]
    state["events"].append({
        "type": "ball_bounce",
        "axis": axis,
        "force": force,
        "x": ball["x"],
        "y": ball["y"],
        "z": ball["z"],
    })


# ── Scoring, ball-out, reset, finalize ─────────────────────────

def _score_goal(state: dict, side: str) -> None:
    state["ball"]["frozen"] = True
    state["ball"]["vx"] = 0
    state["ball"]["vy"] = 0
    state["ball"]["vz"] = 0
    state["pauseState"] = "celebrate"
    state["pauseTimer"] = CELEBRATE_TICKS

    if side == "left":
        state["scoreR"] += 1
        state["goalScorer"] = state["p2"]
        if state["recordEvents"]:
            state["events"].append({"type": "goal", "scorer": "p2"})
    else:
        state["scoreL"] += 1
        state["goalScorer"] = state["p1"]
        if state["recordEvents"]:
            state["events"].append({"type": "goal", "scorer": "p1"})

    if state["scoreL"] >= WIN_SCORE or state["scoreR"] >= WIN_SCORE:
        state["pauseState"] = "matchend"
        state["pauseTimer"] = MATCHEND_PAUSE_TICKS
        state["winner"] = "left" if state["scoreL"] >= WIN_SCORE else "right"


def _ball_out(state: dict) -> None:
    state["ball"]["frozen"] = True
    state["ball"]["vx"] = 0
    state["ball"]["vy"] = 0
    state["ball"]["vz"] = 0
    state["pauseState"] = "reposition"
    state["pauseTimer"] = 0
    if state["recordEvents"]:
        state["events"].append({"type": "out"})


def _reset_ball(state: dict) -> None:
    b = state["ball"]
    b["x"] = state["field"]["midX"]
    b["y"] = FIELD_HEIGHT / 2
    b["vx"] = 0
    b["vy"] = 0
    b["z"] = RESPAWN_DROP_Z
    b["vz"] = 0
    b["frozen"] = False
    state["graceFrames"] = RESPAWN_GRACE
    state["lastKickTick"] = state["tick"]


def _finalize_match(state: dict) -> None:
    """Terminal state after the matchend pause. Callers poll matchOver and
    discard the state, so no reset work is needed."""
    state["matchOver"] = True
    state["pauseState"] = None
    state["pauseTimer"] = 0


# ── Pause state machine ───────────────────────────────────────

def _advance_pause(state: dict) -> None:
    if state["pauseState"] == "matchend":
        state["pauseTimer"] -= 1
        if state["pauseTimer"] <= 0:
            _finalize_match(state)
        return

    if state["pauseState"] == "celebrate":
        state["pauseTimer"] -= 1
        if state["pauseTimer"] <= 0:
            state["pauseState"] = "reposition"
            state["pauseTimer"] = 0
            state["goalScorer"] = None
        return

    if state["pauseState"] == "reposition":
        f = state["field"]
        tx1 = f["midX"] - STARTING_GAP - f["playerWidth"] / 2
        tx2 = f["midX"] + STARTING_GAP - f["playerWidth"] / 2
        cy = FIELD_HEIGHT / 2

        state["p1"]["stamina"] = min(1, state["p1"]["stamina"] + STAMINA_REGEN)
        state["p2"]["stamina"] = min(1, state["p2"]["stamina"] + STAMINA_REGEN)
        _step_reposition(state["p1"], tx1, cy)
        _step_reposition(state["p2"], tx2, cy)

        if (
            abs(state["p1"]["x"] - tx1) < REPOSITION_TOL
            and abs(state["p2"]["x"] - tx2) < REPOSITION_TOL
            and abs(state["p1"]["y"] - cy) < REPOSITION_TOL
            and abs(state["p2"]["y"] - cy) < REPOSITION_TOL
        ):
            state["pauseState"] = "waiting"
            state["pauseTimer"] = RESPAWN_DELAY_TICKS
        return

    if state["pauseState"] == "waiting":
        state["pauseTimer"] -= 1
        if state["pauseTimer"] <= 0:
            _reset_ball(state)
            state["pauseState"] = None


def _step_reposition(p: dict, tx: float, ty: float) -> None:
    dx = tx - p["x"]
    dy = ty - p["y"]
    abs_dx = abs(dx)
    abs_dy = abs(dy)
    if abs_dx > REPOSITION_TOL or abs_dy > REPOSITION_TOL:
        sign_x = 1 if dx > 0 else (-1 if dx < 0 else 0)
        sign_y = 1 if dy > 0 else (-1 if dy < 0 else 0)
        p["x"] += sign_x * min(abs_dx * 0.1, REPOSITION_SPEED)
        p["y"] += sign_y * min(abs_dy * 0.1, REPOSITION_SPEED * 0.5)
    else:
        p["x"] = tx
        p["y"] = ty


# ── NN input builder ──────────────────────────────────────────

NN_INPUT_SIZE = 20


def build_inputs(state: dict, which: str, out: Optional[list] = None) -> list:
    """NN input vector (length NN_INPUT_SIZE), bit-identical to physics.js buildInputs()."""
    if out is None:
        out = [0.0] * NN_INPUT_SIZE
    f = state["field"]
    p = state[which]
    opp = state["p2"] if which == "p1" else state["p1"]
    b = state["ball"]
    fw = f["width"]
    tgx = f["goalLineR"] if p["side"] == "left" else f["goalLineL"]
    ogx = f["goalLineL"] if p["side"] == "left" else f["goalLineR"]

    out[0] = (p["x"] / fw) * 2 - 1
    out[1] = (p["y"] / FIELD_HEIGHT) * 2 - 1
    out[2] = p["vx"] / MAX_PLAYER_SPEED
    out[3] = p["vy"] / MAX_PLAYER_SPEED
    out[4] = p["stamina"] * 2 - 1
    out[5] = (opp["x"] / fw) * 2 - 1
    out[6] = (opp["y"] / FIELD_HEIGHT) * 2 - 1
    out[7] = opp["vx"] / MAX_PLAYER_SPEED
    out[8] = opp["vy"] / MAX_PLAYER_SPEED
    out[9] = (b["x"] / fw) * 2 - 1
    out[10] = (b["y"] / FIELD_HEIGHT) * 2 - 1
    out[11] = b["z"] / CEILING
    out[12] = b["vx"] / MAX_KICK_POWER
    out[13] = b["vy"] / MAX_KICK_POWER
    out[14] = b["vz"] / MAX_KICK_POWER
    out[15] = (tgx / fw) * 2 - 1
    out[16] = (ogx / fw) * 2 - 1
    out[17] = (fw / FIELD_WIDTH_REF) * 2 - 1
    out[18] = math.cos(p["heading"])
    out[19] = math.sin(p["heading"])

    for i in range(NN_INPUT_SIZE):
        if out[i] > 1:
            out[i] = 1
        elif out[i] < -1:
            out[i] = -1
    return out


# ── Helpers ───────────────────────────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)
