# Football v2 — reference snippets from v1

This file captures the handful of v1 artifacts worth carrying into v2, extracted
verbatim before v1 was deleted in phase 1. Everything else is in git history
(see `master~N -- games/football/`).

Temporary file. Delete at the end of phase 3 once all snippets below have
landed in their v2 homes.

## 1. Fallback AI (from `football.js:361-397`)

This is the hand-coded heuristic that beat 32k generations of evolved brains.
Phase 3 ports it verbatim into `games/football/fallback.js` and uses it both as
the in-game fallback opponent AND as the teacher for the warm-start seed.

Consumes **raw state**, not the 18-dim NN input. Note the `AI_PREDICT_FRAMES = 20`
constant it depends on.

```js
const AI_PREDICT_FRAMES = 20;

function fallbackAIOutputs(s, which) {
  const p = s[which];
  const opp = which === 'p1' ? s.p2 : s.p1;
  const ball = s.ball;

  // Predict ball position
  const tx = ball.x + ball.vx * AI_PREDICT_FRAMES;
  const ty = ball.y;

  // Move toward predicted ball
  const center = p.x + field.playerWidth / 2;
  const dx = tx - center;
  const dy = ty - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  const moveX = dx / dist;
  const moveY = dy / dist;

  // Kick toward opponent's goal
  const kickDir = p.side === 'left' ? 1 : -1;
  const canKickNow = Math.abs(dx) < field.playerWidth && Math.abs(dy) < 10 && ball.z < 10;

  // Push when close to opponent (random chance like original)
  const oppCenter = opp.x + field.playerWidth / 2;
  const oppDist = Math.abs(center - oppCenter);
  const closeToOpp = oppDist < 30 && Math.abs(p.y - opp.y) < 20;
  const wantPush = closeToOpp && Math.random() < 0.03;

  return [
    moveX, moveY,
    canKickNow ? 1 : -1,  // kick
    kickDir, 0, 0.2,       // kick direction (toward goal, slight lob)
    0.8,                    // kick power
    wantPush ? 1 : -1,     // push
    0.5,                    // push power
  ];
}
```

**Output vector layout** (9 floats, matches NN output): `[moveX, moveY, kick,
kickDirX, kickDirY, kickDirZ, kickPower, push, pushPower]`.

## 2. NN input builder (from `engine.js:1108-1147`)

Phase 3's `physics_py.py` must reproduce this exactly so the JS training path
and the Python warm-start path produce identical inputs for the same state.
All 18 outputs are clamped to `[-1, 1]`.

```js
buildInputs(s, which) {
  const out = new Array(18);
  this.buildInputsInto(s, which, out);
  return out;
}

/** Write 18 normalized inputs into an existing array (zero-alloc for hot loops). */
buildInputsInto(s, which, out) {
  const player = s[which];
  const opp = which === 'p1' ? s.p2 : s.p1;
  const ball = s.ball;
  const fw = this.field.fieldWidth;
  const cl = this.field.ceiling;
  const tgx = player.side === 'left' ? this.field.goalLineR : this.field.goalLineL;
  const ogx = player.side === 'left' ? this.field.goalLineL : this.field.goalLineR;

  out[0]  = (player.x / fw) * 2 - 1;
  out[1]  = (player.y / FIELD_HEIGHT) * 2 - 1;
  out[2]  = player.vx / MAX_PLAYER_SPEED;
  out[3]  = player.vy / MAX_PLAYER_SPEED;
  out[4]  = player.stamina * 2 - 1;
  out[5]  = (opp.x / fw) * 2 - 1;
  out[6]  = (opp.y / FIELD_HEIGHT) * 2 - 1;
  out[7]  = opp.vx / MAX_PLAYER_SPEED;
  out[8]  = opp.vy / MAX_PLAYER_SPEED;
  out[9]  = (ball.x / fw) * 2 - 1;
  out[10] = (ball.y / FIELD_HEIGHT) * 2 - 1;
  out[11] = ball.z / cl;
  out[12] = ball.vx / MAX_KICK_POWER;
  out[13] = ball.vy / MAX_KICK_POWER;
  out[14] = ball.vz / MAX_KICK_POWER;
  out[15] = (tgx / fw) * 2 - 1;
  out[16] = (ogx / fw) * 2 - 1;
  out[17] = (fw / FIELD_WIDTH_REF) * 2 - 1;
  // Clamp all to [-1, 1]
  for (let i = 0; i < 18; i++) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
}
```

**Input vector layout** (18 floats, all in `[-1, 1]`):

| idx | meaning                                              |
|-----|------------------------------------------------------|
| 0   | self x (normalized to field width)                   |
| 1   | self y (normalized to field height)                  |
| 2   | self vx (normalized to max player speed)             |
| 3   | self vy                                              |
| 4   | self stamina (mapped from [0,1] to [-1,1])           |
| 5   | opponent x                                           |
| 6   | opponent y                                           |
| 7   | opponent vx                                          |
| 8   | opponent vy                                          |
| 9   | ball x                                               |
| 10  | ball y                                               |
| 11  | ball z (air height, normalized to ceiling)           |
| 12  | ball vx (normalized to MAX_KICK_POWER)               |
| 13  | ball vy                                              |
| 14  | ball vz                                              |
| 15  | target goal x (opponent's goal)                      |
| 16  | own goal x                                           |
| 17  | field width vs reference (lets NN adapt to resizes)  |

## 3. Physics constants referenced by the two functions above

Pulled from `engine.js:10-95`. Phase 2 may revise these while closing bugs,
but the defaults below are what the v1 training data reflects.

```js
// Timing
const TICK = 16; // ms per frame (~60 FPS)

// Ball physics
const GRAVITY        = 0.3;
const AIR_BOUNCE     = 0.6;
const AIR_FRICTION   = 0.99;
const GROUND_FRICTION = 0.944;
const BOUNCE_RETAIN  = 0.8;
const RESPAWN_DROP_Z = 60;

// Player movement
const MAX_PLAYER_SPEED = 10;
const FIELD_HEIGHT   = 42;
const STARTING_GAP   = 40;
const PROX_RADIUS_FRAC = 0.25;
const PLAYER_INERTIA = 0.7;
const DIRECTION_CHANGE_DRAIN = 0.02;

// Kick
const KICK_REACH_X   = 1.0;
const KICK_REACH_Y   = 16;
const AIRKICK_REACH_X = 1.5;
const AIRKICK_REACH_Y = 24;
const AIRKICK_MAX_H  = 2;
const MAX_KICK_POWER = 22;
const KICK_NOISE_SCALE = 0.3;
const KICK_SHOT_FORCE = MAX_KICK_POWER * 0.4;
const AIRKICK_MS     = 350;
const AIRKICK_PEAK   = 0.4;

// Push
const PUSH_RANGE_X   = 30;
const PUSH_RANGE_Y   = 20;
const MAX_PUSH_FORCE = 200;
const PUSH_DAMP      = 0.88;
const PUSH_APPLY     = 0.12;
const PUSH_STAMINA_COST = 0.15;
const PUSH_VICTIM_MULT = 3;

// Stamina
const STAMINA_REGEN       = 0.005;
const STAMINA_MOVE_BASE   = 0.003;
const STAMINA_MOVE_SCALE  = 0.3;
const STAMINA_MOVE_DRAIN  = 0.012;
const STAMINA_KICK_DRAIN  = 0.3;
const STAMINA_AIRKICK_DRAIN = 0.1;
const STAMINA_EXHAUSTION_THRESHOLD = 0.5;

// NN normalization reference
const FIELD_WIDTH_REF = 900;
```

## 4. NN architecture

From v1's `nn.js`:

- **Layers**: 18 → 20 → 16 → 18 → 9
- **Hidden activation**: LeakyReLU
- **Output activation**: tanh
- **Init**: He (heuristic normal scaled by `sqrt(2/fan_in)`)
- **Weight count**: 1193 (verify in phase 3 when re-implementing)

The LeakyReLU + He init + tanh-output combo was landed to fix a saturation
issue in an earlier session (see memory `feedback_nn_saturation_fix`). Keep
this combo in v2; changing any of it requires re-verifying saturation.

## 5. v1 GA hyperparameters

From v1's `evolution/ga.py`:

- Population size: 50
- Tournament k: 5
- Elitism: 5 brains carried forward per gen
- Two-point crossover
- Gaussian mutation with σ=0.1 and decay factor 0.995/generation
- Random injection: ~6% per generation
- MIN_MATCHES_PER_BRAIN: 5 (v2 raises to 10 pop + 5 fallback)

## 6. v1 fitness history snapshot (for the record)

Pulled from `/api/football/stats` immediately before v1 was wiped:

```json
{
  "avg_fitness": 0.04,
  "avg_goals": 0.4,
  "generation": 32183,
  "hof_size": 643,
  "population": 50,
  "top_fitness": 0.28,
  "total_matches": 46538900,
  "trainers": { "browser": 2070, "other": 0, "server": 0 }
}
```

100-generation window (32084 → 32183):

```
avg: 0.04–0.09 (oscillating)
top: 0.28–0.48 (oscillating)
```

No trend. 32k generations × 46.5M matches of random walk. This is the baseline
v2 has to beat — and warm-started it should blow past this on day one.
