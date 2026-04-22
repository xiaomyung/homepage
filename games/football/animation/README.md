# animation/

Stickman animation state machine + keyframe data. All code here is
pure (no DOM, no three.js dependency) so it can be unit-tested under
node.

## Files

| File          | Role                                                      |
| ------------- | --------------------------------------------------------- |
| `channels.js` | Channel catalogue: names, kinds, defaults                 |
| `sampler.js`  | `sample(kf, t)` — evaluate a keyframe array at phase t    |
| `keyframes.js`| Pose data per state (the thing you edit to tune a pose)   |
| `state.js`    | Pure FSM: `derivePlayerAnimState(player, state, prev)`    |
| `poses.js`    | `computePose(animState, dt, player, state)` — composer    |
| `scalars.js`  | Named scalar providers for `scaled` channels              |

## How the pieces fit

```
          physics state                   player.anim (prev frame)
               │                                   │
               └─────────┬─────────────────────────┘
                         ▼
                 state.js :: derivePlayerAnimState
                         │
                         ▼
            { state: 'KICK_STRIKE', t: 0.4, phase, blendFrom, blendT }
                         │
                         ▼
         poses.js :: computePose(animState, dt, player, state)
                         │
                         ├── ikGroups →  kickLegPose / pushArmPose
                         ├── channels →  sampler.js :: sample(kf, t)
                         │               × resolveScalar(name, player)  (for `scaled`)
                         ├── blend    →  crossfade against blendFrom pose
                         ▼
                      Pose object  (per-channel numbers)
                         │
                         ▼
                 renderer.js :: _addStickman → applyPose
```

## Adding a new state

1. Pick a name (SCREAMING_SNAKE) and add it to the FSM transitions in
   `state.js`. Define when it's entered (which physics flags/velocities)
   and how `t` is normalized over the state's duration.
2. Add a keyframe entry to `keyframes.js`:
   ```js
   MY_NEW_STATE: {
     // Optional IK group — skip if pose is fully keyframed
     ikGroups: [{ solver: 'kickLeg', target: 'kick.footTarget',
                  channels: ['legR_upper'] }],
     // Per-channel keyframe arrays
     torsoTilt: [{t:0, v:0}, {t:1, v:-0.2}],
     // ...
   },
   ```
3. Expose any new channel in `channels.js` if the pose needs one that
   doesn't exist yet.
4. Unit tests: add a case to `tests/animation-state.test.mjs` for the
   new transition, and to `tests/animation-keyframes.test.mjs` for the
   keyframe values.
5. Iterate visually via `debug/test-renderer.html` — its keyframe
   editor lets you drag sliders and "Copy as code" the result.

## What NOT to do here

- Do not import from `three.js` — `animation/` must stay browser-
  agnostic so the node test suite runs it.
- Do not reach into `renderer.js` — `animation/` produces a Pose, and
  the renderer consumes it. Never the reverse.
- Do not duplicate physics state. Animation derives pose from physics;
  it does not write back.
