"""
Football v2 — Python port of games/football/fallback.js.

Deterministic handcoded policy used as (a) the in-game fallback opponent
via fallback.js in the browser, and (b) the imitation teacher for the
warm-start seed in build_warm_start.py.

Must be bit-identical to fallback.js. Parity is enforced by
test_parity.py::test_fallback_parity.

The whole point of this module is that the policy is a pure function of
state with zero randomness — the JS version had a 3% random push roll
that corrupts imitation training (see memory:
project_football_warm_start_fallback). Both versions are now fully
deterministic and will produce identical outputs on identical states.
"""
from __future__ import annotations

import math

# Must match fallback.js
AI_PREDICT_FRAMES = 20
PUSH_RANGE_X = 30
PUSH_RANGE_Y = 20
KICK_REACH_Y_NEAR = 10
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

    target_x = ball["x"] + ball["vx"] * AI_PREDICT_FRAMES
    target_y = ball["y"]

    center = p["x"] + pw / 2
    dx = target_x - center
    dy = target_y - p["y"]
    dist = math.sqrt(dx * dx + dy * dy) or 1.0
    move_x = dx / dist
    move_y = dy / dist

    ball_dx = ball["x"] - center
    ball_dy = ball["y"] - p["y"]
    can_kick_now = (
        abs(ball_dx) < pw
        and abs(ball_dy) < KICK_REACH_Y_NEAR
        and ball["z"] < KICK_BALL_Z_MAX
    )

    kick_dir_x = 1 if p["side"] == "left" else -1

    opp_center = opp["x"] + pw / 2
    adjacent = (
        abs(center - opp_center) < PUSH_RANGE_X
        and abs(p["y"] - opp["y"]) < PUSH_RANGE_Y
    )

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
