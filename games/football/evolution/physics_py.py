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
BALL_RADIUS = 1.4175
RESPAWN_DROP_Z = 60
OUT_OF_BOUNDS_MARGIN = 50

# Player
MAX_PLAYER_SPEED = 10
PLAYER_INERTIA = 0.7
MOVE_THRESHOLD = 0.1
MOVE_THRESHOLD_SQ = MOVE_THRESHOLD * MOVE_THRESHOLD
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
AIRKICK_DZ_THRESHOLD = 0.5
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
GOAL_DEPTH = 78
GOAL_LINE_INSET = 6
GOAL_MOUTH_Z = 26  # 30% taller than the original 20
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

    if p["vx"] * target_vx < 0 or p["vy"] * target_vy < 0:
        p["stamina"] = max(0, p["stamina"] - DIRECTION_CHANGE_DRAIN)

    blend = 1 - PLAYER_INERTIA
    p["vx"] += (target_vx - p["vx"]) * blend
    p["vy"] += (target_vy - p["vy"]) * blend

    speed_sq = p["vx"] * p["vx"] + p["vy"] * p["vy"]
    if speed_sq > MOVE_THRESHOLD_SQ:
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
    _resolve_goal_collision(p, f["playerWidth"], f["goalLLeft"], f["goalLRight"], f)
    _resolve_goal_collision(p, f["playerWidth"], f["goalRLeft"], f["goalRRight"], f)
    # Goal resolution can push the player past a field edge; re-clamp.
    _clamp_player_to_field(p, f)


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


# ── Kick state machine ────────────────────────────────────────

def _can_kick(state: dict, p: dict) -> bool:
    if p["kick"]["active"]:
        return False
    f = state["field"]
    center = p["x"] + f["playerWidth"] / 2
    close_x = abs(state["ball"]["x"] - center) < f["playerWidth"] * KICK_REACH_X_MULT
    close_y = abs(state["ball"]["y"] - p["y"]) < KICK_REACH_Y
    return close_x and close_y


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
    if k["timer"] >= KICK_RECOVERY_MS:
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
        center = p["x"] + f["playerWidth"] / 2
        reach_x = f["playerWidth"] * AIRKICK_REACH_X_MULT
        if abs(ball["x"] - center) > reach_x or abs(ball["y"] - p["y"]) > AIRKICK_REACH_Y:
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

    power01 = (_clamp(power_norm, -1, 1) + 1) / 2
    force = power01 * MAX_PUSH_FORCE * max(MIN_PUSH_STAMINA, pusher["stamina"])

    pusher["dir"] = 1 if pusher_center_x < victim_center_x else -1
    pusher["pushTimer"] = PUSH_ANIM_MS

    victim["pushVx"] = pusher["dir"] * force
    victim["pushVy"] = (state["rng"]() - 0.5) * force * 0.5

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

    if ball["x"] < -OUT_OF_BOUNDS_MARGIN or ball["x"] > f["width"] + OUT_OF_BOUNDS_MARGIN:
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
    within_box_l_x = ball["x"] >= f["goalLLeft"]
    within_box_r_x = ball["x"] <= f["goalRRight"]
    within_mouth_y = (
        ball["y"] - BALL_RADIUS >= f["goalMouthYMin"]
        and ball["y"] + BALL_RADIUS <= f["goalMouthYMax"]
    )
    below_crossbar = ball["z"] + BALL_RADIUS <= f["goalMouthZMax"]

    goal_l = crossed_l and fully_past_l and within_box_l_x and within_mouth_y and below_crossbar
    goal_r = crossed_r and fully_past_r and within_box_r_x and within_mouth_y and below_crossbar

    if goal_l or goal_r:
        _score_goal(state, "left" if goal_l else "right")
        return

    # Past the line but not a goal. If still in the mouth (y/z) the ball is
    # mid-cross — let it continue. Otherwise it hit a post/crossbar; bounce.
    if within_mouth_y and below_crossbar:
        return

    line = f["goalLineL"] if crossed_l else f["goalLineR"]
    sign = 1 if crossed_l else -1
    ball["x"] = line + sign * (BALL_RADIUS + 1)
    if ball["vx"] * sign < 0:
        pre_vx = abs(ball["vx"])
        ball["vx"] = -ball["vx"] * BOUNCE_RETAIN
        _record_bounce(state, "x", pre_vx)
    if not below_crossbar and ball["vz"] > 0:
        pre_vz = abs(ball["vz"])
        ball["vz"] = -pre_vz * BOUNCE_RETAIN
        _record_bounce(state, "z", pre_vz)


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

def build_inputs(state: dict, which: str, out: Optional[list] = None) -> list:
    """18-dim normalized input vector, bit-identical to physics.js buildInputs()."""
    if out is None:
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
