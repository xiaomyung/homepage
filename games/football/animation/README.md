# animation/

Stickman animation state machine + pose composer. All code here is
pure (no DOM, no three.js) so it can be unit-tested under node.

## Files

| File          | Role                                                      |
| ------------- | --------------------------------------------------------- |
| `channels.js` | Channel catalogue: names, kinds, defaults                 |
| `curves.js`   | Polynomial body-english curves + tuning constants         |
| `keyframes.js`| Per-state keyframe data (verified against `curves.js` — see "Keyframes" below) |
| `sampler.js`  | `sample(kf, t)` — evaluate a keyframe array at phase t    |
| `state.js`    | `advanceAnimState(anim, player, tick, …)` — per-frame LPF + phase + state-label derivation |
| `poses.js`    | `composeStickmanPose(animSnap, player, pose, …)` — layered composer |

## Pipeline

```
physics.tick(state, action, rng)        ← single source of truth
           │
           ▼
renderer.renderState(state, tick)
           │
           ▼  per player
advanceAnimState(anim, player, tick, isCelebrating, out,
                 isGrieving, isReposition, isMatchendWin, isMatchendLose)
           │   (mutates `anim` in place; returns snapshot in `out`)
           ▼
composeStickmanPose(animSnap, player, pose, kickScratch, pushScratch)
           │   (fills `pose` — every world-space number the renderer needs)
           ▼
_placeTorso / _placeArm / _placeLeg / _placeHead / _placeRestStars / shadow
```

## Adding a new state

1. Pick a name (SCREAMING_SNAKE) and decide where it slots into the
   priority cascade in `state.js::advanceAnimState` (the `stateName`
   if/else chain near the bottom).
2. Add an LPF factor + phase to the `createAnimState` initializer and
   advance them in the `if (dt > 0)` block (target → 1 when active,
   → 0 otherwise; smoothed via `STICKMAN_SMOOTH`).
3. Read the factor from the snapshot in `poses.js` and add a layer.
   Layers are additive on tilt/hip/limb angles or full overrides via
   lerp; whichever is appropriate. Keep them ordered from base
   (walk/run) to specialized (kick / push / matchend / grieve / rest).
4. If the pose needs new tuning constants, put them in `curves.js`
   alongside the existing block of consts; consumed via named import.
5. Unit tests: add a case to `tests/animation-state.test.mjs` for the
   FSM transition, `tests/animation-poses.test.mjs` for the pose
   shape, and `tests/animation-keyframes.test.mjs` if you author a
   keyframe set.

## Keyframes — currently dead data

`keyframes.js` contains keyframe arrays for every kick/push/airkick
stage, verified by `tests/animation-keyframes.test.mjs` to match the
polynomial curves in `curves.js` within ±2% of the channel range over
200 samples. **They are NOT yet wired into `composeStickmanPose`** —
poses still evaluate `curves.js` directly. The keyframes exist so a
future visual editor can migrate one state at a time without
re-deriving data from scratch. Deleting `keyframes.js` today would
not change render output (only the boundary-continuity tests would
fail).

## What NOT to do here

- Do not import from `three.js` — `animation/` must stay browser-
  agnostic so the node test suite runs it.
- Do not reach into `renderer.js` — `animation/` produces a Pose, and
  the renderer consumes it. Never the reverse.
- Do not write back to physics state. The showcase-replay
  determinism contract requires the animation layer to be derived
  only; anything cosmetic lives on `player.anim`.
