"""
Football v2 — Python port of games/football/fallback.js.

Deterministic handcoded policy used as (a) the in-game fallback
opponent (via fallback.js in the browser), and (b) the imitation
teacher for the warm-start seed in build_warm_start.py. Must be
bit-identical to fallback.js; parity is enforced by
test_parity.py::test_fallback_parity.

No randomness in this module — the v1 JS version had a 3% random
push roll and the imitation NN collapsed toward the mean. Both
versions are now fully deterministic.
"""
from __future__ import annotations

from physics_py import (
    PLAYER_HEIGHT,
    Z_STRETCH,
    PUSH_RANGE_X,
    PUSH_RANGE_Y,
    KICK_REACH_Y,
    KICK_FACE_TOL,
    PUSH_FACE_TOL,
    facing_toward,
)

AI_PREDICT_FRAMES = 20
KICK_BALL_Z_MAX = 10

KICK_POWER_NORM = 0.8
KICK_DZ = 0.2
PUSH_POWER_NORM = 0.5


def fallback_action(state: dict, which: str) -> list[float]:
    """Compute the fallback action vector for one player.

    Returns [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower].
    """
    p = state[which]
    opp = state["p2"] if which == "p1" else state["p1"]
    ball = state["ball"]
    pw = state["field"]["playerWidth"]

    center = p["x"] + pw / 2
    dx = (ball["x"] + ball["vx"] * AI_PREDICT_FRAMES) - center
    dy = ball["y"] - p["y"]
    dist = (dx * dx + dy * dy) ** 0.5 or 1.0
    move_x = dx / dist
    move_y = dy / dist

    p_mid_y = p["y"] + PLAYER_HEIGHT / 2
    in_kick_range = (
        abs(ball["x"] - center) < pw
        and abs(ball["y"] - p_mid_y) < KICK_REACH_Y
        and ball["z"] < KICK_BALL_Z_MAX
    )
    can_kick_now = in_kick_range and facing_toward(
        p, ball["x"], ball["y"] * Z_STRETCH, KICK_FACE_TOL
    )

    kick_dir_x = 1 if p["side"] == "left" else -1

    opp_center = opp["x"] + pw / 2
    opp_z = (opp["y"] + PLAYER_HEIGHT / 2) * Z_STRETCH
    in_push_range = (
        abs(center - opp_center) < PUSH_RANGE_X
        and abs(p["y"] - opp["y"]) < PUSH_RANGE_Y
    )
    adjacent = in_push_range and facing_toward(p, opp_center, opp_z, PUSH_FACE_TOL)

    return [
        move_x,
        move_y,
        1.0 if can_kick_now else -1.0,
        float(kick_dir_x),
        0.0,
        KICK_DZ,
        KICK_POWER_NORM,
        1.0 if adjacent else -1.0,
        PUSH_POWER_NORM,
    ]
