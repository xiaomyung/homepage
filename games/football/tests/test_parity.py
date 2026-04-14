"""
JS vs Python physics parity test.

Runs identical scenarios through both physics implementations and asserts
tick-by-tick state match within float tolerance. The JS version is canonical;
if this test fails, physics_py.py is wrong.

Tolerance is tight (1e-9) because:
  - LCG PRNG is bit-identical (32-bit modular arithmetic)
  - IEEE 754 floats are the same on both sides for +-*/
  - sqrt is IEEE 754 on both sides
  - The only source of drift is transcendentals (log, cos) used in gauss_random

Tolerance is loosened when gauss_random is involved (kick accuracy noise).
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Optional

import pytest

from fallback_py import fallback_action
from physics_py import (
    build_inputs,
    create_field,
    create_seeded_rng,
    create_state,
    tick,
)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RUNNER = os.path.abspath(os.path.join(HERE, "..", "evolution", "physics_runner.mjs"))

# Float tolerance for bit-sensitive comparisons. Pure integer/float math
# on IEEE 754 is identical; transcendentals may drift one ULP.
STRICT_TOL = 1e-9
LOOSE_TOL = 1e-6  # when gauss_random is in play


# ── JS subprocess runner ───────────────────────────────────────

def run_js(scenario: dict) -> list:
    """Send scenario JSON to physics_runner.mjs, return the trajectory list."""
    result = subprocess.run(
        ["node", RUNNER],
        input=json.dumps(scenario),
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    )
    return json.loads(result.stdout)["trajectory"]


# ── Python runner (mirror of physics_runner.mjs) ──────────────

def run_py(scenario: dict) -> list:
    field = create_field(scenario.get("fieldWidth", 900))
    state = create_state(field, create_seeded_rng(scenario["seed"]))
    overrides = scenario.get("initialOverrides", {})
    if "p1" in overrides:
        state["p1"].update(overrides["p1"])
    if "p2" in overrides:
        state["p2"].update(overrides["p2"])
    if "ball" in overrides:
        state["ball"].update(overrides["ball"])
    state["graceFrames"] = 0

    num_ticks = scenario.get("numTicks", len(scenario.get("actions", [])))
    actions = scenario.get("actions", [])
    trajectory = []
    for i in range(num_ticks):
        if i < len(actions):
            p1_act, p2_act = actions[i]
        else:
            p1_act, p2_act = None, None
        tick(state, p1_act, p2_act)
        trajectory.append(_snapshot(state))
    return trajectory


def _snapshot(state: dict) -> dict:
    return {
        "tick": state["tick"],
        "p1": {
            "x": state["p1"]["x"],
            "y": state["p1"]["y"],
            "vx": state["p1"]["vx"],
            "vy": state["p1"]["vy"],
            "stamina": state["p1"]["stamina"],
        },
        "p2": {
            "x": state["p2"]["x"],
            "y": state["p2"]["y"],
            "vx": state["p2"]["vx"],
            "vy": state["p2"]["vy"],
            "stamina": state["p2"]["stamina"],
        },
        "ball": {
            "x": state["ball"]["x"],
            "y": state["ball"]["y"],
            "z": state["ball"]["z"],
            "vx": state["ball"]["vx"],
            "vy": state["ball"]["vy"],
            "vz": state["ball"]["vz"],
            "frozen": state["ball"]["frozen"],
        },
        "scoreL": state["scoreL"],
        "scoreR": state["scoreR"],
        "events": state["events"],
    }


# ── Comparison helper ──────────────────────────────────────────

def assert_trajectory_match(js_traj: list, py_traj: list, tol: float = STRICT_TOL) -> None:
    assert len(js_traj) == len(py_traj), (
        f"trajectory length differs: js={len(js_traj)}, py={len(py_traj)}"
    )
    for i, (js, py) in enumerate(zip(js_traj, py_traj)):
        assert js["tick"] == py["tick"], f"tick counter diverged at step {i}"
        for side in ("p1", "p2"):
            for k in ("x", "y", "vx", "vy", "stamina"):
                diff = abs(js[side][k] - py[side][k])
                assert diff <= tol, (
                    f"tick {i} {side}.{k}: js={js[side][k]} py={py[side][k]} diff={diff}"
                )
        for k in ("x", "y", "z", "vx", "vy", "vz"):
            diff = abs(js["ball"][k] - py["ball"][k])
            assert diff <= tol, (
                f"tick {i} ball.{k}: js={js['ball'][k]} py={py['ball'][k]} diff={diff}"
            )
        assert js["ball"]["frozen"] == py["ball"]["frozen"], f"ball.frozen diverged at tick {i}"
        assert js["scoreL"] == py["scoreL"], f"scoreL diverged at tick {i}"
        assert js["scoreR"] == py["scoreR"], f"scoreR diverged at tick {i}"


# ── Test cases ─────────────────────────────────────────────────

def test_parity_100_ticks_noop():
    """Ball drops from RESPAWN_DROP_Z under gravity, no actions. Fully deterministic."""
    scenario = {
        "seed": 42,
        "numTicks": 100,
        "actions": [],
    }
    js = run_js(scenario)
    py = run_py(scenario)
    assert_trajectory_match(js, py, STRICT_TOL)


def test_parity_movement_only():
    """Both players move at full speed; no kicks, no gauss noise, pure inertia/clamp."""
    move_right = [1, 0, -1, 0, 0, 0, 0, -1, 0]
    move_left = [-1, 0, -1, 0, 0, 0, 0, -1, 0]
    scenario = {
        "seed": 42,
        "numTicks": 80,
        "actions": [[move_right, move_left]] * 80,
    }
    js = run_js(scenario)
    py = run_py(scenario)
    assert_trajectory_match(js, py, STRICT_TOL)


def test_parity_with_kicks():
    """Kicks involve gauss_random (cos, log) — allow loose tolerance."""
    # Put players right next to the ball so kicks actually fire
    kick_action = [1, 0, 1, 1, 0, 0, 0.8, -1, 0]
    scenario = {
        "seed": 123,
        "numTicks": 60,
        "actions": [[kick_action, kick_action]] * 60,
        "initialOverrides": {
            "ball": {"x": 450, "y": 21, "z": 0, "vz": 0},
            "p1": {"x": 441, "y": 21},
            "p2": {"x": 459, "y": 21},
        },
    }
    js = run_js(scenario)
    py = run_py(scenario)
    assert_trajectory_match(js, py, LOOSE_TOL)


def test_parity_goal_scoring():
    """Ball placed just outside right goal line, moving toward goal. Must score same way."""
    scenario = {
        "seed": 7,
        "numTicks": 20,
        "actions": [],
        "initialOverrides": {
            "ball": {
                "x": 815,  # just inside field, outside goal line
                "y": 21,
                "z": 0,
                "vx": 3,
                "vy": 0,
                "vz": 0,
            },
        },
    }
    js = run_js(scenario)
    py = run_py(scenario)
    assert_trajectory_match(js, py, STRICT_TOL)
    assert js[-1]["scoreL"] == 1, "ball should have scored a goal (js)"
    assert py[-1]["scoreL"] == 1, "ball should have scored a goal (py)"


def test_parity_build_inputs_matches():
    """build_inputs (Python) produces the same 18-dim vector as v1 on the same state."""
    field = create_field()
    state = create_state(field, create_seeded_rng(1))
    # Seed a non-trivial state
    state["p1"]["x"] = 123.456
    state["p1"]["vy"] = -3.14
    state["ball"]["vx"] = 7.89
    py_inputs = build_inputs(state, "p1")

    # Compare against a fresh JS run via a one-off inline script
    js_code = """
    import('./games/football/physics.js').then(({ createField, createState, createSeededRng, buildInputs }) => {
      const state = createState(createField(), createSeededRng(1));
      state.p1.x = 123.456;
      state.p1.vy = -3.14;
      state.ball.vx = 7.89;
      process.stdout.write(JSON.stringify(buildInputs(state, 'p1')));
    });
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js_code],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    )
    js_inputs = json.loads(result.stdout)

    assert len(js_inputs) == len(py_inputs) == 18
    for i, (j, p) in enumerate(zip(js_inputs, py_inputs)):
        assert abs(j - p) < STRICT_TOL, f"input[{i}]: js={j} py={p}"


def test_fallback_parity():
    """fallback_py.fallback_action must match fallback.js.fallbackAction on identical states."""
    field = create_field()
    py_state = create_state(field, create_seeded_rng(1))
    py_state["p1"]["x"] = 200
    py_state["p1"]["y"] = 15
    py_state["p2"]["x"] = 500
    py_state["p2"]["y"] = 20
    py_state["ball"]["x"] = 300
    py_state["ball"]["y"] = 18
    py_state["ball"]["vx"] = 2.5
    py_state["ball"]["vy"] = -0.5
    py_state["ball"]["z"] = 3

    py_out_p1 = fallback_action(py_state, "p1")
    py_out_p2 = fallback_action(py_state, "p2")

    js_code = """
    import('./games/football/physics.js').then(({ createField, createState, createSeededRng }) => {
      import('./games/football/fallback.js').then(({ fallbackAction }) => {
        const state = createState(createField(), createSeededRng(1));
        state.p1.x = 200; state.p1.y = 15;
        state.p2.x = 500; state.p2.y = 20;
        state.ball.x = 300; state.ball.y = 18;
        state.ball.vx = 2.5; state.ball.vy = -0.5; state.ball.z = 3;
        const p1 = fallbackAction(state, 'p1');
        const p2 = fallbackAction(state, 'p2');
        process.stdout.write(JSON.stringify({ p1, p2 }));
      });
    });
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js_code],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    )
    js_data = json.loads(result.stdout)

    for i, (j, p) in enumerate(zip(js_data["p1"], py_out_p1)):
        assert abs(j - p) < STRICT_TOL, f"p1 action[{i}]: js={j} py={p}"
    for i, (j, p) in enumerate(zip(js_data["p2"], py_out_p2)):
        assert abs(j - p) < STRICT_TOL, f"p2 action[{i}]: js={j} py={p}"
