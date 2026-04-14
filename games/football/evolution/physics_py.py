"""
Football v2 — Python port of games/football/physics.js.

Line-for-line translation with bit-identical PRNG and operation order.
Used by:
  - build_warm_start.py to run fallback-vs-fallback matches for imitation data
  - local_test.py to run CLI training smoke tests without a browser

Parity against physics.js is enforced by test_parity.py (spawns Node to run
the JS version on the same scenario and asserts tick-by-tick state match
to within float tolerance).

The only floating-point drift tolerated is in transcendentals (log, cos, sqrt)
at the last ULP; all integer arithmetic, LCG, and collision logic must match
exactly. If the parity test fails, this file is wrong — the JS version is
canonical.

Uses plain Python dicts as state containers (not dataclasses) so JSON
round-tripping and ad-hoc construction are trivial.
"""

import math
from typing import Optional

# ── Constants (must match physics.js) ──────────────────────────

FIELD_WIDTH_REF = 900
FIELD_HEIGHT = 42
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
BALL_RADIUS = 4
RESPAWN_DROP_Z = 60
OUT_OF_BOUNDS_MARGIN = 50

# Player
MAX_PLAYER_SPEED = 10
PLAYER_INERTIA = 0.7
MOVE_THRESHOLD = 0.1
STARTING_GAP = 40
PLAYER_WIDTH = 18
PLAYER_HEIGHT = 6
MIN_SPEED_STAMINA = 0.3

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
KICK_REACH_X_MULT = 1.0
KICK_REACH_Y = 16
AIRKICK_REACH_X_MULT = 1.5
AIRKICK_REACH_Y = 24
AIRKICK_MAX_Z = 20
AIRKICK_MS = 350
AIRKICK_PEAK_FRAC = 0.4
KICK_WINDUP_MS = 96
KICK_RECOVERY_MS = 288
KICK_DIR_MIN_LEN = 0.01
WASTED_KICK_SPEED = MIN_KICK_POWER * 0.1

# Push
PUSH_RANGE_X = 30
PUSH_RANGE_Y = 20
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
GOAL_DEPTH = 54
GOAL_MOUTH_Z = 20
GOAL_MOUTH_Y_MIN = (FIELD_HEIGHT - 20) / 2
GOAL_MOUTH_Y_MAX = (FIELD_HEIGHT + 20) / 2

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
    Py: state = ((state * 1664525) & 0xFFFFFFFF + 1013904223) & 0xFFFFFFFF

    Modular arithmetic is the same regardless of signed/unsigned interp, so
    (a * b) mod 2^32 is bit-identical between the two. Transcendentals are
    not involved in the LCG itself.
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
        "goalLineL": goal_l_right - 6,
        "goalLineR": goal_r_left + 6,
        "goalMouthYMin": GOAL_MOUTH_Y_MIN,
        "goalMouthYMax": GOAL_MOUTH_Y_MAX,
        "goalMouthZMax": GOAL_MOUTH_Z,
        "midX": width / 2,
        "aiLimitL": goal_l_left + 6,
        "aiLimitR": goal_r_right - 6,
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
        "kick": None,
        "pushTimer": 0,
        "dir": 1 if side == "left" else -1,
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
    }


# ── Main tick ──────────────────────────────────────────────────

def tick(state: dict, p1_act: Optional[list], p2_act: Optional[list]) -> dict:
    state["events"] = []
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


# ── Action application ────────────────────────────────────────

def _apply_action(state: dict, p: dict, out: list) -> None:
    if p["exhausted"]:
        p["vx"] = 0
        p["vy"] = 0
        return

    if _advance_kick(state, p):
        return

    if p["pushTimer"] > 0:
        p["pushTimer"] -= TICK_MS
        if p["pushTimer"] < 0:
            p["pushTimer"] = 0
        return

    move_x, move_y, kick, kick_dx, kick_dy, kick_dz, kick_power, push, push_power = out

    _apply_movement(state, p, move_x, move_y)

    if push > 0:
        opp = state["p2"] if p is state["p1"] else state["p1"]
        _try_push(state, p, opp, push_power)

    if kick > 0 and _can_kick(state, p):
        _start_kick(state, p, kick_dx, kick_dy, kick_dz, kick_power)


# ── Movement ───────────────────────────────────────────────────

def _apply_movement(state: dict, p: dict, move_x: float, move_y: float) -> None:
    eff_speed = MAX_PLAYER_SPEED * max(MIN_SPEED_STAMINA, p["stamina"])
    target_vx = _clamp(move_x, -1, 1) * eff_speed
    target_vy = _clamp(move_y, -1, 1) * eff_speed

    if (p["y"] <= 0 and target_vy < 0) or (p["y"] >= FIELD_HEIGHT and target_vy > 0):
        target_vy = 0
        p["vy"] = 0
    if (p["x"] <= 0 and target_vx < 0) or (
        p["x"] >= state["field"]["width"] - state["field"]["playerWidth"] and target_vx > 0
    ):
        target_vx = 0
        p["vx"] = 0

    if p["vx"] * target_vx < 0 or p["vy"] * target_vy < 0:
        p["stamina"] = max(0, p["stamina"] - DIRECTION_CHANGE_DRAIN)

    blend = 1 - PLAYER_INERTIA
    p["vx"] += (target_vx - p["vx"]) * blend
    p["vy"] += (target_vy - p["vy"]) * blend

    speed = math.sqrt(p["vx"] * p["vx"] + p["vy"] * p["vy"])
    if speed > MOVE_THRESHOLD:
        p["x"] += p["vx"]
        p["y"] += p["vy"]
        p["dir"] = 1 if p["vx"] > 0 else -1
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


# ── Stamina from displacement ─────────────────────────────────

def _charge_stamina_from_displacement(p: dict, pre_x: float, pre_y: float) -> None:
    dx = p["x"] - pre_x
    dy = p["y"] - pre_y
    dist = math.sqrt(dx * dx + dy * dy)
    if dist < STAMINA_MOVE_THRESHOLD:
        return
    p["stamina"] -= STAMINA_MOVE_BASE + STAMINA_MOVE_PER_UNIT * dist
    if p["stamina"] < 0:
        p["stamina"] = 0


# ── Clamp and collide ─────────────────────────────────────────

def _clamp_and_collide(state: dict, p: dict) -> None:
    f = state["field"]
    pw = f["playerWidth"]
    if p["x"] < 0:
        p["x"] = 0
    if p["x"] > f["width"] - pw:
        p["x"] = f["width"] - pw
    if p["y"] < 0:
        p["y"] = 0
    if p["y"] > FIELD_HEIGHT:
        p["y"] = FIELD_HEIGHT

    _resolve_goal_collision(p, pw, f["goalLLeft"], f["goalLRight"], f)
    _resolve_goal_collision(p, pw, f["goalRLeft"], f["goalRRight"], f)


def _resolve_goal_collision(p: dict, pw: float, gxL: float, gxR: float, f: dict) -> None:
    pxL = p["x"]
    pxR = p["x"] + pw
    if pxR <= gxL or pxL >= gxR:
        return
    if p["y"] + PLAYER_HEIGHT <= f["goalMouthYMin"] or p["y"] >= f["goalMouthYMax"]:
        return

    push_left = pxR - gxL
    push_right = gxR - pxL
    push_up = p["y"] + PLAYER_HEIGHT - f["goalMouthYMin"]
    push_down = f["goalMouthYMax"] - p["y"]

    x_push = min(push_left, push_right)
    y_push = min(push_up, push_down)

    if x_push <= y_push:
        p["x"] += -push_left if push_left <= push_right else push_right
        p["vx"] = 0
        p["pushVx"] = 0
    else:
        p["y"] += -push_up if push_up <= push_down else push_down
        p["vy"] = 0
        p["pushVy"] = 0


# ── Kick ──────────────────────────────────────────────────────

def _can_kick(state: dict, p: dict) -> bool:
    if p["kick"] is not None:
        return False
    f = state["field"]
    center = p["x"] + f["playerWidth"] / 2
    close_x = abs(state["ball"]["x"] - center) < f["playerWidth"] * KICK_REACH_X_MULT
    close_y = abs(state["ball"]["y"] - p["y"]) < KICK_REACH_Y
    return close_x and close_y


def _start_kick(state: dict, p: dict, dx: float, dy: float, dz: float, power: float) -> None:
    kick_dx = _clamp(dx, -1, 1)
    kick_dy = _clamp(dy, -1, 1)
    kick_dz = _clamp(dz, -1, 1)
    kick_power = (_clamp(power, -1, 1) + 1) / 2

    if dz > 0.5:
        jump_frac = (dz - 0.5) * 2
        p["kick"] = {
            "phase": "airkick",
            "timer": 0,
            "airZ": jump_frac * AIRKICK_MAX_Z,
            "fired": False,
            "dx": kick_dx,
            "dy": kick_dy,
            "dz": kick_dz,
            "power": kick_power,
        }
        p["stamina"] = max(0, p["stamina"] - STAMINA_AIRKICK_DRAIN)
    else:
        p["kick"] = {
            "phase": "windup",
            "timer": 0,
            "airZ": 0,
            "fired": False,
            "dx": kick_dx,
            "dy": kick_dy,
            "dz": kick_dz,
            "power": kick_power,
        }


def _advance_kick(state: dict, p: dict) -> bool:
    if p["kick"] is None:
        return False
    p["kick"]["timer"] += TICK_MS

    if p["kick"]["phase"] == "airkick":
        phase = min(p["kick"]["timer"] / AIRKICK_MS, 1)
        p["airZ"] = math.sin(phase * math.pi) * p["kick"]["airZ"]
        if not p["kick"]["fired"] and phase >= AIRKICK_PEAK_FRAC:
            p["kick"]["fired"] = True
            _execute_kick(state, p)
        if phase >= 1:
            p["airZ"] = 0
            p["kick"] = None
        return True

    if not p["kick"]["fired"] and p["kick"]["timer"] >= KICK_WINDUP_MS:
        p["kick"]["fired"] = True
        _execute_kick(state, p)
    if p["kick"]["timer"] >= KICK_RECOVERY_MS:
        p["kick"] = None
    return True


def _execute_kick(state: dict, p: dict) -> None:
    f = state["field"]
    ball = state["ball"]
    which = "p1" if p is state["p1"] else "p2"
    is_airkick = p["kick"]["phase"] == "airkick"

    if is_airkick and ball["z"] <= 1:
        state["events"].append({"type": "kick_missed", "player": which, "reason": "airkick_ground_ball"})
        return
    if not is_airkick and ball["z"] > PLAYER_HEIGHT:
        state["events"].append({"type": "kick_missed", "player": which, "reason": "ground_kick_high_ball"})
        return

    if is_airkick:
        center = p["x"] + f["playerWidth"] / 2
        reach_x = f["playerWidth"] * AIRKICK_REACH_X_MULT
        if abs(ball["x"] - center) > reach_x or abs(ball["y"] - p["y"]) > AIRKICK_REACH_Y:
            state["events"].append({"type": "kick_missed", "player": which, "reason": "airkick_out_of_range"})
            return

    raw_power = max(MIN_KICK_POWER, p["kick"]["power"])
    effective_max_power = MAX_KICK_POWER * max(MIN_KICK_STAMINA, p["stamina"])
    force = raw_power * effective_max_power

    dx = p["kick"]["dx"]
    dy = p["kick"]["dy"]
    dz = p["kick"]["dz"]

    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    if length < KICK_DIR_MIN_LEN:
        dx = state["rng"]() * 2 - 1
        dy = state["rng"]() * 2 - 1
        dz = state["rng"]() * 0.5
        rlen = math.sqrt(dx * dx + dy * dy + dz * dz) or 1
        dx /= rlen
        dy /= rlen
        dz /= rlen
    else:
        dx /= length
        dy /= length
        dz /= length

    noise = raw_power * raw_power * KICK_NOISE_SCALE
    dx += gauss_random(state["rng"]) * noise
    dy += gauss_random(state["rng"]) * noise
    dz += gauss_random(state["rng"]) * noise * KICK_NOISE_VERT
    len2 = math.sqrt(dx * dx + dy * dy + dz * dz) or 1
    dx /= len2
    dy /= len2
    dz /= len2

    ball["vx"] = dx * force
    ball["vy"] = dy * force
    ball["vz"] = max(0, dz * force)
    ball["frozen"] = False

    p["stamina"] = max(0, p["stamina"] - STAMINA_KICK_DRAIN * raw_power)
    state["lastKickTick"] = state["tick"]

    ball_speed = math.sqrt(ball["vx"] * ball["vx"] + ball["vy"] * ball["vy"])
    state["events"].append({
        "type": "kick",
        "player": which,
        "power": raw_power,
        "speed": ball_speed,
        "wasted": ball_speed < WASTED_KICK_SPEED,
    })


# ── Push ──────────────────────────────────────────────────────

def _try_push(state: dict, pusher: dict, victim: dict, power_norm: float) -> dict:
    f = state["field"]
    ca = pusher["x"] + f["playerWidth"] / 2
    cb = victim["x"] + f["playerWidth"] / 2

    if pusher["kick"] is not None:
        return {"landed": False, "reason": "pusher_kicking"}
    if pusher["pushTimer"] > 0:
        return {"landed": False, "reason": "pusher_cooldown"}
    if abs(ca - cb) > PUSH_RANGE_X:
        return {"landed": False, "reason": "out_of_range_x"}
    if abs(pusher["y"] - victim["y"]) > PUSH_RANGE_Y:
        return {"landed": False, "reason": "out_of_range_y"}

    power01 = (_clamp(power_norm, -1, 1) + 1) / 2
    effective_max_push = MAX_PUSH_FORCE * max(MIN_PUSH_STAMINA, pusher["stamina"])
    force = power01 * effective_max_push

    pusher["dir"] = 1 if ca < cb else -1
    pusher["pushTimer"] = PUSH_ANIM_MS

    victim["pushVx"] = pusher["dir"] * force
    victim["pushVy"] = (state["rng"]() - 0.5) * force * 0.5

    pusher["stamina"] = max(0, pusher["stamina"] - PUSH_STAMINA_COST * power01)
    victim["stamina"] = max(
        0, victim["stamina"] - PUSH_STAMINA_COST * power01 * PUSH_VICTIM_STAMINA_MULT
    )

    pusher_which = "p1" if pusher is state["p1"] else "p2"
    state["events"].append({"type": "push", "pusher": pusher_which, "force": force})
    return {"landed": True, "force": force}


# ── Ball physics ──────────────────────────────────────────────

def _update_ball(state: dict) -> None:
    ball = state["ball"]
    if ball["frozen"]:
        return

    moving = (
        ball["vx"] * ball["vx"] > 0
        or ball["vy"] * ball["vy"] > 0
        or ball["z"] > 0
        or ball["vz"] > 0
    )
    if not moving:
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
            ball["z"] = 0
            if abs(ball["vz"]) > BOUNCE_VZ_MIN:
                ball["vz"] = abs(ball["vz"]) * AIR_BOUNCE
            else:
                ball["vz"] = 0

    if ball["y"] < 0:
        ball["y"] = 0
        ball["vy"] = abs(ball["vy"]) * WALL_BOUNCE_DAMP
    if ball["y"] > FIELD_HEIGHT:
        ball["y"] = FIELD_HEIGHT
        ball["vy"] = -abs(ball["vy"]) * WALL_BOUNCE_DAMP

    if ball["z"] > CEILING:
        ball["z"] = CEILING
        ball["vz"] = -abs(ball["vz"]) * AIR_BOUNCE

    if ball["vx"] * ball["vx"] < BALL_VEL_CUTOFF_SQ:
        ball["vx"] = 0
    if ball["vy"] * ball["vy"] < BALL_VEL_CUTOFF_SQ:
        ball["vy"] = 0


def _check_ball_score_or_out(state: dict) -> None:
    f = state["field"]
    ball = state["ball"]
    if ball["frozen"]:
        return

    if ball["x"] < -OUT_OF_BOUNDS_MARGIN or ball["x"] > f["width"] + OUT_OF_BOUNDS_MARGIN:
        _ball_out(state)
        return

    if state["graceFrames"] > 0:
        return

    crossed_l = ball["x"] < f["goalLineL"]
    crossed_r = ball["x"] > f["goalLineR"]
    if not crossed_l and not crossed_r:
        return

    within_y = f["goalMouthYMin"] <= ball["y"] <= f["goalMouthYMax"]
    below_crossbar = ball["z"] <= f["goalMouthZMax"]

    if within_y and below_crossbar:
        _score_goal(state, "left" if crossed_l else "right")
        return

    # Past the goal line but not a valid goal — bounce off post/crossbar
    line = f["goalLineL"] if crossed_l else f["goalLineR"]
    sign = 1 if crossed_l else -1
    ball["x"] = line + sign * (BALL_RADIUS + 1)
    if ball["vx"] * sign < 0:
        ball["vx"] = -ball["vx"] * BOUNCE_RETAIN
    if not below_crossbar and ball["vz"] > 0:
        ball["vz"] = -ball["vz"] * BOUNCE_RETAIN


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
        state["events"].append({"type": "goal", "scorer": "p2"})
    else:
        state["scoreL"] += 1
        state["goalScorer"] = state["p1"]
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


def _reset_player(state: dict, p: dict) -> None:
    f = state["field"]
    p["x"] = (
        f["midX"] - STARTING_GAP - f["playerWidth"] / 2
        if p["side"] == "left"
        else f["midX"] + STARTING_GAP - f["playerWidth"] / 2
    )
    p["y"] = FIELD_HEIGHT / 2
    p["vx"] = 0
    p["vy"] = 0
    p["pushVx"] = 0
    p["pushVy"] = 0
    p["stamina"] = 1
    p["exhausted"] = False
    p["kick"] = None
    p["pushTimer"] = 0
    p["airZ"] = 0
    p["dir"] = 1 if p["side"] == "left" else -1


def _reset_match(state: dict) -> None:
    state["scoreL"] = 0
    state["scoreR"] = 0
    _reset_player(state, state["p1"])
    _reset_player(state, state["p2"])
    _reset_ball(state)
    state["pauseState"] = None
    state["pauseTimer"] = 0
    state["goalScorer"] = None
    state["matchOver"] = True


# ── Pause state machine ───────────────────────────────────────

def _advance_pause(state: dict) -> None:
    if state["pauseState"] == "matchend":
        state["pauseTimer"] -= 1
        if state["pauseTimer"] <= 0:
            _reset_match(state)
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
        state["p1"]["stamina"] = min(1, state["p1"]["stamina"] + STAMINA_REGEN)
        state["p2"]["stamina"] = min(1, state["p2"]["stamina"] + STAMINA_REGEN)
        for p in (state["p1"], state["p2"]):
            tx = (
                f["midX"] - STARTING_GAP - f["playerWidth"] / 2
                if p["side"] == "left"
                else f["midX"] + STARTING_GAP - f["playerWidth"] / 2
            )
            ty = FIELD_HEIGHT / 2
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
        if (
            abs(state["p1"]["x"] - (f["midX"] - STARTING_GAP - f["playerWidth"] / 2)) < REPOSITION_TOL
            and abs(state["p2"]["x"] - (f["midX"] + STARTING_GAP - f["playerWidth"] / 2)) < REPOSITION_TOL
        ):
            state["pauseState"] = "waiting"
            state["pauseTimer"] = RESPAWN_DELAY_TICKS
        return

    if state["pauseState"] == "waiting":
        state["pauseTimer"] -= 1
        if state["pauseTimer"] <= 0:
            _reset_ball(state)
            state["pauseState"] = None


# ── NN input builder ──────────────────────────────────────────

def build_inputs(state: dict, which: str) -> list:
    """18-dim normalized input vector, bit-identical to physics.js buildInputs()."""
    out = [0.0] * 18
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

    for i in range(18):
        if out[i] > 1:
            out[i] = 1
        elif out[i] < -1:
            out[i] = -1
    return out


# ── Helpers ───────────────────────────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)
