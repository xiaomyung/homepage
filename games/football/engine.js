/**
 * Headless football game engine — DOM-free, pure physics.
 *
 * Used by both the visual renderer (football.js) and the Web Worker trainer.
 * All layout values are passed in via FieldConfig at construction; no
 * offsetWidth / offsetHeight calls.
 */

/* ── Constants ────────────────────────────────────────────── */

// Timing
export const TICK = 16; // ms per frame (~60 FPS)

// Ball physics
const GRAVITY        = 0.3;
const AIR_BOUNCE     = 0.6;
const AIR_FRICTION   = 0.99;
const GROUND_FRICTION = 0.944;
const BOUNCE_RETAIN  = 0.8;
const RESPAWN_DROP_Z = 60;

// Player movement
export const MAX_PLAYER_SPEED = 10;
const FIELD_HEIGHT   = 42;
const STARTING_GAP   = 40;

// Kick
const KICK_REACH_X   = 1.0;   // multiplier on player width
const KICK_REACH_Y   = 16;
const AIRKICK_REACH_X = 1.5;  // wider reach during air kicks
const AIRKICK_REACH_Y = 24;
const AIRKICK_MAX_H  = 2;     // max jump height in text rows
export const MAX_KICK_POWER = 22;
const KICK_NOISE_SCALE = 0.3; // accuracy penalty at full power
const AIRKICK_MS     = 350;
const AIRKICK_PEAK   = 0.4;

// Push
const PUSH_RANGE_X   = 30;
const PUSH_RANGE_Y   = 20;
export const MAX_PUSH_FORCE = 200;
const PUSH_DAMP      = 0.88;
const PUSH_APPLY     = 0.12;
const PUSH_ANIM_MS   = 300;
const PUSH_STAMINA_COST = 0.15;  // at full push_power
const PUSH_VICTIM_MULT = 2;     // pushed player loses 2x

// Stamina
const STAMINA_REGEN       = 0.005; // per tick (always recovers)
const STAMINA_MOVE_BASE   = 0.006; // base drain for any movement
const STAMINA_MOVE_SCALE  = 0.3;   // speed-proportional drain multiplier
const STAMINA_MOVE_DRAIN  = 0.012; // additional drain at max speed
const STAMINA_KICK_DRAIN  = 0.3;   // max cost at full power kick
const STAMINA_AIRKICK_DRAIN = 0.1; // flat cost for air kick
const STAMINA_EXHAUSTION_THRESHOLD = 0.5; // must recover to this before acting

// Display / animation
const BALL_RADIUS    = 4;
const JUMP_HEIGHT    = 18;
const JUMP_PHASE_MS  = 400;
const JUMP_CELEBRATE_MS = 1500; // total celebration jump duration
const WALK_ANIM_BASE = 6;
const MOVE_THRESHOLD = 0.1;
const MIN_SPEED_STAMINA = 0.3;   // floor for linear stamina→speed scaling
const MIN_KICK_POWER = 0.15;    // minimum kick power fraction
const MIN_KICK_STAMINA = 0.2;   // floor for stamina→kick power
const MIN_PUSH_STAMINA = 0.2;   // floor for stamina→push force
const KICK_NOISE_VERT = 0.5;    // vertical kick noise reduction
const KICK_DIR_MIN_LEN = 0.01;  // below this, kick uses default direction
const KICK_DEFAULT_DZ = 0.1;    // default kick lob when direction is zero
const PUSH_VEL_THRESHOLD = 0.5; // push velocity below this is zeroed
const BOUNCE_VZ_MIN  = 1.5;     // min vz for ball to bounce on ground
const BALL_VEL_CUTOFF = 0.1;    // velocities below this are zeroed
const BALL_MOVE_MIN  = 0.01;    // ball movement detection threshold
const WALL_BOUNCE_DAMP = 0.5;   // y-wall bounce velocity retention
const OUT_OF_BOUNDS  = 50;      // px past field before ball is out
const GOAL_LINE_OFFSET = 2;     // px adjustment for goal line position
const GOALLINE_ROW   = 5;       // bottom row index of goal hitbox
const CEILING_OFFSET = 20;      // px from stage bottom for ceiling
const REPOSITION_TOL_X = 5;     // px tolerance for player at start
const REPOSITION_TOL_Y = 3;
const REPOSITION_Y_MAX = 4;     // max Y movement speed during reposition
const FIELD_WIDTH_REF = 900;    // reference field width for NN normalization

// Pre-computed squared thresholds (avoid Math.abs/sqrt in hot loops)
const MOVE_THRESHOLD_SQ    = MOVE_THRESHOLD * MOVE_THRESHOLD;
const BALL_MOVE_MIN_SQ     = BALL_MOVE_MIN * BALL_MOVE_MIN;
const BALL_VEL_CUTOFF_SQ   = BALL_VEL_CUTOFF * BALL_VEL_CUTOFF;
const PUSH_VEL_THRESHOLD_SQ = PUSH_VEL_THRESHOLD * PUSH_VEL_THRESHOLD;

// Match
export const WIN_SCORE = 3;
const RESPAWN_GRACE  = 30;
const STALL_TICKS    = Math.ceil(10000 / TICK); // 10s in ticks
const GOAL_ROLL_FRAMES = 2;
const CELEBRATE_TICKS = Math.ceil(1500 / TICK);
const REPOSITION_SPEED = 6;
const RESPAWN_DELAY_TICKS = Math.ceil(300 / TICK);

// Player hitbox (for goal collision)
const PLAYER_HB_H    = 1.9; // height in rows

// Per-character goal hitboxes: [row, col, char]
const HITBOX_L = [
  [0,5,'_'],[0,7,'_'],
  [1,4,'/'],[1,7,'/'],[1,8,'|'],
  [2,3,'/'],[2,4,'_'],[2,5,'_'],[2,6,'/'],[2,7,'_'],[2,8,'|'],
  [3,2,'/'],[3,3,'_'],[3,4,'_'],[3,5,'/'],
  [4,1,'/'],[4,5,'|'],
  [5,0,'/'],[5,1,'_'],[5,2,'_'],[5,3,'_'],[5,4,'_'],[5,5,'|'],
];
const HITBOX_R = [
  [0,1,'_'],[0,3,'_'],
  [1,0,'|'],[1,1,'\\'],[1,4,'\\'],
  [2,0,'|'],[2,1,'_'],[2,2,'\\'],[2,3,'_'],[2,4,'_'],[2,5,'\\'],
  [3,3,'\\'],[3,4,'_'],[3,5,'_'],[3,6,'\\'],
  [4,3,'|'],[4,7,'\\'],
  [5,3,'|'],[5,4,'_'],[5,5,'_'],[5,6,'_'],[5,7,'_'],[5,8,'\\'],
];

/* ── Field config ─────────────────────────────────────────── */

/**
 * Describes the physical layout of the field.
 * In visual mode, derived from DOM measurements.
 * In headless mode, constructed from field width.
 */
export class FieldConfig {
  /**
   * @param {number} fieldWidth — total stage width in px
   */
  constructor(fieldWidth, goalMult = 1) {
    this.fieldWidth = fieldWidth;
    this.fieldWidthSq = fieldWidth * fieldWidth;
    this.goalMult = goalMult; // 1=normal, 2=double-size goals (easier)
    this.fieldHeight = FIELD_HEIGHT;
    // Approximate character metrics based on typical monospace rendering.
    // In visual mode these come from the DOM; here we estimate.
    this.charW = 6;
    this.lineH = 3.3;
    // Goal positions: left goal at ~30px, right goal at ~(width - 30px - goalWidth)
    this.goalLLeft = 30;
    this.goalLWidth = 9 * this.charW; // 9 chars wide
    this.goalRLeft = fieldWidth - 30 - 9 * this.charW;
    this.goalRWidth = 9 * this.charW;
    // Goal line positions — must match the DOM formula:
    // goalLineL element is positioned at goalLLeft + goalLWidth - 3*charW
    // Then: goalLineL.offsetLeft + 2*charW - charW/2 = goalLLeft + goalLWidth - 1.5*charW
    // goalLineR element is positioned at goalRLeft
    // Then: goalLineR.offsetLeft + charW + charW/2 = goalRLeft + 1.5*charW
    this.goalLineL = this.goalLLeft + this.goalLWidth - 1.5 * this.charW - GOAL_LINE_OFFSET;
    this.goalLineR = this.goalRLeft + 1.5 * this.charW;
    // AI movement limits
    this.aiLimitL = this.goalLLeft + 6 * this.charW;
    this.aiLimitR = this.goalRLeft + 3 * this.charW;
    // Center of field
    this.midX = (this.goalLLeft + this.goalLWidth + this.goalRLeft) / 2;
    // Player width approximation (3 chars)
    this.playerWidth = 3 * this.charW;
    // Ceiling
    this.ceiling = 100; // headless approx; visual overrides this
  }

  /**
   * Create from DOM measurements (used by visual renderer).
   */
  static fromDOM(goalL, goalR, goalLineL, goalLineR, stage) {
    const charW = goalL.offsetWidth / 9;
    const lineH = goalL.offsetHeight / 6;
    const fc = new FieldConfig(stage.offsetWidth);
    fc.charW = charW;
    fc.lineH = lineH;
    fc.goalLLeft = goalL.offsetLeft;
    fc.goalLWidth = goalL.offsetWidth;
    fc.goalRLeft = goalR.offsetLeft;
    fc.goalRWidth = goalR.offsetWidth;
    fc.goalLineL = goalLineL.offsetLeft + 2 * charW - charW / 2 - GOAL_LINE_OFFSET;
    fc.goalLineR = goalLineR.offsetLeft + charW + charW / 2;
    fc.aiLimitL = goalL.offsetLeft + 6 * charW;
    fc.aiLimitR = goalR.offsetLeft + 3 * charW;
    fc.midX = (goalL.offsetLeft + goalL.offsetWidth + goalR.offsetLeft) / 2;
    fc.playerWidth = 3 * charW;
    fc.ceiling = stage.offsetHeight - CEILING_OFFSET;
    return fc;
  }
}

/* ── Game state ───────────────────────────────────────────── */

function createPlayerState(side, midX, playerWidth) {
  const x = side === 'left'
    ? midX - STARTING_GAP - playerWidth / 2
    : midX + STARTING_GAP - playerWidth / 2;
  return {
    x, y: FIELD_HEIGHT / 2,
    vx: 0, vy: 0,
    prevX: x, prevY: FIELD_HEIGHT / 2,
    stamina: 1,
    exhausted: false, // true when stamina hits 0, clears at 50%
    state: 'idle', stateTime: 0, fi: 0, ft: 0,
    dir: side === 'left' ? 1 : -1,
    jumpY: 0,
    pushVx: 0, pushVy: 0,
    airKickZ: 0, airKickFired: false,
    _kickDx: 0, _kickDy: 0, _kickDz: 0, _kickPower: 0,
    side,
  };
}

function emptyFitness() {
  return {
    ticks: 0,
    ballProximity: 0,     // reward: staying close to ball
    kicks: 0,             // count: each kick (not used in fitness, kept for stats)
    ballAdvance: 0,       // reward: moving ball toward opponent goal
    ballInAttackZone: 0,  // reward: ball near opponent's goal
    possession: 0,        // reward: ticks closer to ball than opponent
    exhaustedTicks: 0,    // penalty: ticks spent frozen from exhaustion
    staminaSum: 0,        // for computing average stamina (reward managing it)
    pushesLanded: 0,      // count: successful pushes (not used in fitness, kept for stats)
    pushedReceived: 0,    // penalty: getting pushed
    goalKicks: 0,         // reward: kicks that advance ball toward goal
    nearMisses: 0,        // reward: ball crossed goal line but missed opening
    frameHits: 0,         // reward: ball bounced off goal frame
    saves: 0,             // reward: kicked ball away when heading toward own goal
    airKicks: 0,          // reward: kicked ball while airborne (spectacular play)
  };
}

export class GameState {
  constructor(field) {
    this.field = field;
    this.ball = {
      x: field.midX, y: FIELD_HEIGHT / 2,
      vx: 0, vy: 0, z: RESPAWN_DROP_Z, vz: 0,
      goalFrame: 0,
    };
    this.p1 = createPlayerState('left', field.midX, field.playerWidth);
    this.p2 = createPlayerState('right', field.midX, field.playerWidth);
    this.scoreL = 0;
    this.scoreR = 0;
    this.graceFrames = RESPAWN_GRACE;
    this.lastKickTick = 0;
    this.tickCount = 0;
    this.paused = false;
    this.pausePhase = '';
    this.pauseTimer = 0;
    this.respawnTimer = 0;
    this.goalScorer = null;
    this.matchOver = false;
    this.winner = null; // 'left' or 'right'
    this.events = []; // events this tick: ['goal_left', 'goal_right', 'out', 'kick', etc.]

    // Fitness shaping accumulators (per player)
    this.fitness = {
      p1: emptyFitness(),
      p2: emptyFitness(),
    };
  }
}

/* ── Gaussian noise helper ────────────────────────────────── */

function gaussRandom() {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── Engine ───────────────────────────────────────────────── */

export class FootballEngine {
  /**
   * @param {FieldConfig} field
   * @param {boolean} [headless=false] — skip animations/pauses for faster training
   */
  constructor(field, headless = false) {
    this.field = field;
    this.headless = headless;
  }

  /** Create a fresh game state. */
  createState() {
    return new GameState(this.field);
  }

  /**
   * Advance the game by one tick.
   *
   * @param {GameState} s — mutated in place
   * @param {number[]} p1Out — 9 NN outputs for player 1 (or null for no input)
   * @param {number[]} p2Out — 9 NN outputs for player 2 (or null for no input)
   */
  tick(s, p1Out, p2Out) {
    s.events = [];
    s.tickCount++;

    if (s.matchOver) return;

    if (s.paused) {
      if (this.headless) {
        // Skip animations — instant respawn or match end
        if (s.pausePhase === 'matchend') {
          this._resetMatch(s);
        } else {
          this._resetPlayerPos(s.p1);
          this._resetPlayerPos(s.p2);
          this._respawn(s);
        }
      } else {
        this._tickPaused(s);
      }
      return;
    }

    if (s.graceFrames > 0) s.graceFrames--;

    // Apply NN outputs to players
    if (p1Out) this._applyOutputs(s, s.p1, p1Out);
    if (p2Out) this._applyOutputs(s, s.p2, p2Out);

    // Push physics
    this._applyPushPhysics(s.p1, s);
    this._applyPushPhysics(s.p2, s);

    // Clamp players
    this._clampPlayer(s.p1);
    this._clampPlayer(s.p2);

    // Track velocity from position delta
    for (const p of [s.p1, s.p2]) {
      p.vx = p.x - p.prevX;
      p.vy = p.y - p.prevY;
      p.prevX = p.x;
      p.prevY = p.y;
    }

    // Ball physics
    const ballXBefore = s.ball.x;
    this._updateBall(s);

    // Stall detection
    if (s.tickCount - s.lastKickTick > STALL_TICKS) {
      this._resetBall(s);
    }

    // Fitness shaping — headless samples every 3rd tick for speed
    if (!this.headless || s.tickCount % 3 === 0) {
      this._trackFitness(s, s.p1, 'p1', ballXBefore);
      this._trackFitness(s, s.p2, 'p2', ballXBefore);
    }
  }

  /* ── NN output application ─────────────────────────────── */

  _applyOutputs(s, p, out) {
    if (this.headless) {
      this._applyOutputsHeadless(s, p, out);
    } else {
      this._applyOutputsVisual(s, p, out);
    }
  }

  /** Update exhaustion state and apply regen. Returns true if exhausted. */
  _updateStamina(p) {
    if (p.stamina <= 0) p.exhausted = true;
    if (p.exhausted && p.stamina >= STAMINA_EXHAUSTION_THRESHOLD) p.exhausted = false;
    p.stamina = Math.min(1, p.stamina + STAMINA_REGEN);
    return p.exhausted;
  }

  /** Fast path for headless training — no animations, instant kicks/pushes. */
  _applyOutputsHeadless(s, p, out) {
    if (this._updateStamina(p)) return;

    const [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower] = out;

    // Movement
    const effSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);
    const mx = Math.max(-1, Math.min(1, moveX)) * effSpeed;
    const my = Math.max(-1, Math.min(1, moveY)) * effSpeed;
    const speedSq = mx * mx + my * my;
    if (speedSq > MOVE_THRESHOLD_SQ) {
      p.x += mx;
      p.y += my;
      p.dir = mx > 0 ? 1 : -1;
      const speed = Math.sqrt(speedSq); // only when needed for stamina drain
      p.stamina -= STAMINA_MOVE_BASE + STAMINA_MOVE_DRAIN * STAMINA_MOVE_SCALE * (speed / MAX_PLAYER_SPEED);
    }
    p.stamina = Math.max(0, p.stamina);

    // Push — instant (same state check as visual path)
    if (push > 0 && p.state !== 'push') {
      const opp = p === s.p1 ? s.p2 : s.p1;
      this._tryPush(s, p, opp, pushPower);
    }

    // Kick — instant execution, no animation frames
    if (kick > 0 && this._canKick(s, p)) {
      p._kickDx = Math.max(-1, Math.min(1, kickDx));
      p._kickDy = Math.max(-1, Math.min(1, kickDy));
      p._kickDz = Math.max(-1, Math.min(1, kickDz));
      p._kickPower = (Math.max(-1, Math.min(1, kickPower)) + 1) / 2;
      this._executeKick(s, p);
    }
  }

  /** Visual path — full animations and state machine. */
  _applyOutputsVisual(s, p, out) {
    p.stateTime += TICK;
    p.ft++;

    if (this._updateStamina(p)) {
      if (p.state !== 'idle') this._setState(p, 'idle');
      p.jumpY = 0;
      return;
    }

    // Handle ongoing animations
    if (this._tickShared(s, p)) return;

    const [moveX, moveY, kick, kickDx, kickDy, kickDz, kickPower, push, pushPower] = out;

    // Stamina-adjusted caps
    const effectiveMaxSpeed = MAX_PLAYER_SPEED * Math.max(MIN_SPEED_STAMINA, p.stamina);

    // Movement
    const mx = Math.max(-1, Math.min(1, moveX)) * effectiveMaxSpeed;
    const my = Math.max(-1, Math.min(1, moveY)) * effectiveMaxSpeed;
    const speed = Math.sqrt(mx * mx + my * my);

    if (speed > MOVE_THRESHOLD) {
      p.x += mx;
      p.y += my;
      p.dir = mx > 0 ? 1 : -1;
      p.stamina -= STAMINA_MOVE_BASE + STAMINA_MOVE_DRAIN * STAMINA_MOVE_SCALE * (speed / MAX_PLAYER_SPEED);
      if (p.state !== 'walk') this._setState(p, 'walk');
      const walkInt = Math.max(2, Math.round(WALK_ANIM_BASE * (MAX_PLAYER_SPEED / 2) / speed));
      if (p.ft % walkInt === 0) p.fi = (p.fi + 1) % 2;
    } else {
      if (p.state !== 'idle') this._setState(p, 'idle');
    }
    p.stamina = Math.max(0, p.stamina);

    // Push attempt
    if (push > 0 && p.state !== 'push') {
      const opp = p === s.p1 ? s.p2 : s.p1;
      this._tryPush(s, p, opp, pushPower);
    }

    // Kick attempt
    if (kick > 0 && this._canKick(s, p)) {
      this._startKick(s, p, kickDx, kickDy, kickDz, kickPower);
    }
  }

  /* ── Shared state transitions ──────────────────────────── */

  _setState(p, state) {
    p.state = state;
    p.stateTime = 0;
    p.fi = 0;
    p.ft = 0;
  }

  _tickShared(s, p) {
    switch (p.state) {
      case 'kick':
        if (p.ft % WALK_ANIM_BASE === 0 && p.ft > 0) {
          p.fi++;
          if (p.fi === 1) this._executeKick(s, p);
          if (p.fi >= 3) this._setState(p, 'idle');
        }
        return true;
      case 'airkick': {
        const phase = Math.min(p.stateTime / AIRKICK_MS, 1);
        p.jumpY = Math.sin(phase * Math.PI) * (p.airKickZ || 0);
        if (!p.airKickFired && phase >= AIRKICK_PEAK) {
          p.airKickFired = true;
          this._executeKick(s, p);
        }
        if (phase >= 1) {
          p.jumpY = 0;
          p.airKickZ = 0;
          p.airKickFired = false;
          this._setState(p, 'idle');
        }
        return true;
      }
      case 'push':
        if (p.stateTime >= PUSH_ANIM_MS) this._setState(p, 'idle');
        return true;
      case 'jump': {
        const phase = (p.stateTime % JUMP_PHASE_MS) / JUMP_PHASE_MS;
        p.jumpY = Math.sin(phase * Math.PI) * JUMP_HEIGHT;
        if (p.stateTime > JUMP_CELEBRATE_MS) {
          p.jumpY = 0;
          this._setState(p, 'idle');
        }
        return true;
      }
    }
    return false;
  }

  /* ── Kick ──────────────────────────────────────────────── */

  _canKick(s, p) {
    if (p.state === 'kick' || p.state === 'airkick') return false;
    const center = p.x + this.field.playerWidth / 2;
    const closeX = Math.abs(s.ball.x - center) < this.field.playerWidth * KICK_REACH_X;
    const closeY = Math.abs(s.ball.y - p.y) < KICK_REACH_Y;
    return closeX && closeY;
  }

  _startKick(s, p, dx, dy, dz, power) {
    // Store kick params — outputs already in [-1, 1]
    p._kickDx = Math.max(-1, Math.min(1, dx));
    p._kickDy = Math.max(-1, Math.min(1, dy));
    p._kickDz = Math.max(-1, Math.min(1, dz));
    p._kickPower = (Math.max(-1, Math.min(1, power)) + 1) / 2; // map [-1,1] to [0,1]

    if (dz > 0) {
      // Player chooses to jump — height controlled by kickDz
      const { lineH } = this.field;
      p.airKickZ = dz * AIRKICK_MAX_H * lineH; // max 2 text rows high
      p.airKickFired = false;
      p.stamina = Math.max(0, p.stamina - STAMINA_AIRKICK_DRAIN);
      this._setState(p, 'airkick');
    } else {
      this._setState(p, 'kick');
    }
  }

  _executeKick(s, p) {
    // Air kick miss: player jumped but ball is on the ground — whiff
    if (p.state === 'airkick' && s.ball.z <= 1) {
      s.events.push('kick');
      return; // stamina already drained in _startKick, no ball contact
    }
    // Ground kick miss: ball is too high for a ground kick
    if (p.state === 'kick' && s.ball.z > PLAYER_HB_H * this.field.lineH) {
      s.events.push('kick');
      return;
    }

    // Air kick gets wider reach
    if (p.state === 'airkick') {
      const center = p.x + this.field.playerWidth / 2;
      const closeX = Math.abs(s.ball.x - center) < this.field.playerWidth * AIRKICK_REACH_X;
      const closeY = Math.abs(s.ball.y - p.y) < AIRKICK_REACH_Y;
      if (!closeX || !closeY) {
        s.events.push('kick');
        return; // jumped but out of range
      }
    }

    const rawPower = Math.max(MIN_KICK_POWER, p._kickPower ?? 0.5); // minimum 15% power
    const effectiveMaxPower = MAX_KICK_POWER * Math.max(MIN_KICK_STAMINA, p.stamina);
    const force = rawPower * effectiveMaxPower;

    let dx = p._kickDx || 0;
    let dy = p._kickDy || 0;
    let dz = p._kickDz || 0;

    // Ensure valid direction — if near zero, use random direction
    // (not facing direction — NN must learn to output meaningful directions)
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < KICK_DIR_MIN_LEN) {
      dx = Math.random() * 2 - 1;
      dy = Math.random() * 2 - 1;
      dz = Math.random() * 0.5;
      const rlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= rlen; dy /= rlen; dz /= rlen;
    } else {
      dx /= len;
      dy /= len;
      dz /= len;
    }

    // Accuracy penalty: add noise proportional to power, then re-normalize
    const noise = rawPower * rawPower * KICK_NOISE_SCALE; // quadratic — low power is accurate
    dx += gaussRandom() * noise;
    dy += gaussRandom() * noise;
    dz += gaussRandom() * noise * KICK_NOISE_VERT;
    const len2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len2;
    dy /= len2;
    dz /= len2;

    s.ball.vx = dx * force;
    s.ball.vy = dy * force;
    s.ball.vz = Math.max(0, dz * force); // can't kick downward into ground

    // Stamina drain
    p.stamina = Math.max(0, p.stamina - STAMINA_KICK_DRAIN * rawPower);

    s.lastKickTick = s.tickCount;
    s.events.push('kick');

    // Track kick for fitness
    const which = p === s.p1 ? 'p1' : 'p2';
    s.fitness[which].kicks++;
    // Did the kick advance ball toward opponent's goal?
    const goalDir = p.side === 'left' ? 1 : -1;
    if (s.ball.vx * goalDir > 0) s.fitness[which].goalKicks++;
    // Defensive save: kicked ball that was heading toward own goal
    const ownGoalX = p.side === 'left' ? 0 : this.field.fieldWidth;
    if (s.ball.vx * -goalDir > 0 && Math.abs(s.ball.x - ownGoalX) < this.field.fieldWidth * 0.3) {
      s.fitness[which].saves++;
    }
    // Air kick (spectacular play)
    if (s.ball.z > 1) s.fitness[which].airKicks++;
  }

  /* ── Fitness shaping ────────────────────────────────────── */

  _trackFitness(s, p, which, ballXBefore) {
    const f = s.fitness[which];
    const opp = which === 'p1' ? s.p2 : s.p1;
    const ball = s.ball;
    f.ticks++;

    const halfPW = this.field.playerWidth * 0.5;
    const center = p.x + halfPW;
    const oppCenter = opp.x + halfPW;

    // 1. Ball proximity (squared distance — quadratic falloff, stronger gradient near ball)
    const dx = ball.x - center;
    const dy = ball.y - p.y;
    const distSq = dx * dx + dy * dy;
    const maxDistSq = this.field.fieldWidthSq;
    f.ballProximity += 1 - Math.min(distSq / maxDistSq, 1);

    // 2. Ball advance
    const ballDx = ball.x - ballXBefore;
    if (p.side === 'left') {
      f.ballAdvance += ballDx;
    } else {
      f.ballAdvance -= ballDx;
    }

    // 3. Possession (squared comparison — no sqrt needed)
    const oppDx = ball.x - oppCenter;
    const oppDy = ball.y - opp.y;
    if (distSq < oppDx * oppDx + oppDy * oppDy) f.possession++;

    // 4. Ball in attacking zone
    const targetGoalX = p.side === 'left' ? this.field.goalLineR : this.field.goalLineL;
    const bgd = ball.x - targetGoalX;
    f.ballInAttackZone += 1 - Math.min(bgd * bgd / maxDistSq, 1);

    // 5. Exhaustion penalty
    if (p.exhausted) f.exhaustedTicks++;

    // 6. Stamina tracking
    f.staminaSum += p.stamina;
  }

  /* ── Push ──────────────────────────────────────────────── */

  _tryPush(s, pusher, victim, powerNorm) {
    if (pusher.state === 'kick' || pusher.state === 'airkick' || pusher.state === 'jump') return;

    const ca = pusher.x + this.field.playerWidth / 2;
    const cb = victim.x + this.field.playerWidth / 2;
    if (Math.abs(ca - cb) > PUSH_RANGE_X) return;
    if (Math.abs(pusher.y - victim.y) > PUSH_RANGE_Y) return;

    const power01 = (powerNorm + 1) / 2; // map tanh output to 0–1
    const effectiveMaxPush = MAX_PUSH_FORCE * Math.max(MIN_PUSH_STAMINA, pusher.stamina);
    const force = power01 * effectiveMaxPush;

    pusher.dir = ca < cb ? 1 : -1;
    this._setState(pusher, 'push');

    victim.pushVx = pusher.dir * force;
    victim.pushVy = (Math.random() - 0.5) * force * 0.5;

    // Stamina costs
    pusher.stamina -= PUSH_STAMINA_COST * power01;
    victim.stamina -= PUSH_STAMINA_COST * power01 * PUSH_VICTIM_MULT;
    pusher.stamina = Math.max(0, pusher.stamina);
    victim.stamina = Math.max(0, victim.stamina);

    s.events.push('push');

    // Track push for fitness
    const pusherKey = pusher === s.p1 ? 'p1' : 'p2';
    const victimKey = pusherKey === 'p1' ? 'p2' : 'p1';
    s.fitness[pusherKey].pushesLanded++;
    s.fitness[victimKey].pushedReceived++;
  }

  _applyPushPhysics(p, s) {
    if (p.pushVx * p.pushVx > PUSH_VEL_THRESHOLD_SQ) {
      p.x += p.pushVx * PUSH_APPLY;
      p.pushVx *= PUSH_DAMP;
    } else {
      p.pushVx = 0;
    }
    if (p.pushVy * p.pushVy > PUSH_VEL_THRESHOLD_SQ) {
      p.y += p.pushVy * PUSH_APPLY;
      p.pushVy *= PUSH_DAMP;
    } else {
      p.pushVy = 0;
    }
  }

  /* ── Ball physics ──────────────────────────────────────── */

  _updateBall(s) {
    const ball = s.ball;
    const moving = ball.vx * ball.vx > BALL_MOVE_MIN_SQ || ball.vy * ball.vy > BALL_MOVE_MIN_SQ ||
                   ball.z > 0 || ball.vz > 0;
    if (!moving) return;

    ball.x += ball.vx;
    ball.y += ball.vy;
    const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
    ball.vx *= friction;
    ball.vy *= friction;

    // Air physics
    if (ball.z > 0 || ball.vz > 0) {
      ball.vz -= GRAVITY;
      ball.z += ball.vz;
      if (ball.z <= 0) {
        ball.z = 0;
        ball.vz = Math.abs(ball.vz) > BOUNCE_VZ_MIN ? Math.abs(ball.vz) * AIR_BOUNCE : 0;
      }
    }

    // Field-Y bounds
    if (ball.y < 0) { ball.y = 0; ball.vy = Math.abs(ball.vy) * WALL_BOUNCE_DAMP; }
    if (ball.y > FIELD_HEIGHT) { ball.y = FIELD_HEIGHT; ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE_DAMP; }

    // Ceiling
    if (ball.y + ball.z > this.field.ceiling) {
      ball.z = Math.max(0, this.field.ceiling - ball.y);
      ball.vz = -Math.abs(ball.vz) * AIR_BOUNCE;
    }

    // Velocity cutoff
    if (ball.vx * ball.vx < BALL_VEL_CUTOFF_SQ) ball.vx = 0;
    if (ball.vy * ball.vy < BALL_VEL_CUTOFF_SQ) ball.vy = 0;

    // Collision with goal frames
    // Quick bounds check before hitbox iteration
    if (ball.x - BALL_RADIUS < this.field.goalLLeft + this.field.goalLWidth) {
      this._bounceBallGoal(s, HITBOX_L, this.field.goalLLeft);
    }
    if (ball.x + BALL_RADIUS > this.field.goalRLeft) {
      this._bounceBallGoal(s, HITBOX_R, this.field.goalRLeft);
    }

    // Out of bounds
    if (ball.x < -OUT_OF_BOUNDS || ball.x > this.field.fieldWidth + OUT_OF_BOUNDS) {
      this._ballOut(s);
    } else if (s.graceFrames <= 0) {
      this._checkGoalLine(s);
    }
  }

  _bounceBallGoal(s, hitbox, goalLeft) {
    const ball = s.ball;
    const { charW, lineH } = this.field;
    const br = BALL_RADIUS;
    const bh = ball.y + ball.z;
    for (const [row, col] of hitbox) {
      const cx = goalLeft + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x + br <= cx || ball.x - br >= cx + charW) continue;
      if (bh + br <= cy || bh - br >= cy + lineH) continue;

      const dir = ball.x < cx + charW / 2 ? -1 : 1;
      ball.x = dir < 0 ? cx - br - 1 : cx + charW + br + 1;
      ball.vx = dir * Math.abs(ball.vx) * BOUNCE_RETAIN;
      // Track frame hit for fitness — ball reached the goal area
      const attacker = goalLeft === this.field.goalLLeft ? 'p2' : 'p1';
      s.fitness[attacker].frameHits++;
      return;
    }
  }

  _checkGoalLine(s) {
    const ball = s.ball;
    const { lineH, goalLineL, goalLineR } = this.field;
    const crossedL = ball.x < goalLineL;
    const crossedR = ball.x > goalLineR;
    if (!crossedL && !crossedR) return;

    // Ball must be: under crossbar (z), within goal frame depth (y)
    // goalMult widens the opening for easier scoring during training
    const gm = this.field.goalMult;
    const underCrossbar = ball.z <= 2 * lineH * gm;
    const withinFrame = ball.y <= 6 * lineH * gm;

    if (underCrossbar && withinFrame) {
      if (crossedL) this._scoreGoal(s, 'left');
      else this._scoreGoal(s, 'right');
    } else {
      // Near miss tracking — how close was it to scoring?
      const yMiss = Math.max(0, ball.y - 6 * lineH * gm);
      const zMiss = Math.max(0, ball.z - 2 * lineH * gm);
      const which = crossedL ? 'p2' : 'p1'; // attacker
      s.fitness[which].nearMisses += 1 / (1 + yMiss + zMiss);
      this._ballOut(s);
    }
  }

  /* ── Player collision with goals ───────────────────────── */

  _clampPlayer(p) {
    p.y = Math.max(0, Math.min(FIELD_HEIGHT, p.y));
    const { charW, lineH, goalLLeft, goalLWidth, goalRLeft, goalRWidth, midX, playerWidth } = this.field;
    // Quick bounding box pre-check — skip goal collision if player far from goal
    if (p.x < goalLLeft + goalLWidth) {
      this._collidePlayerGoal(p, HITBOX_L, goalLLeft, charW, lineH, playerWidth, midX);
    }
    if (p.x + playerWidth > goalRLeft) {
      this._collidePlayerGoal(p, HITBOX_R, goalRLeft, charW, lineH, playerWidth, midX);
    }
  }

  _collidePlayerGoal(p, hitbox, goalLeft, charW, lineH, pw, midX) {
    const ph = PLAYER_HB_H * lineH;
    for (const [row, col, ch] of hitbox) {
      if (ch === '_' && row === GOALLINE_ROW) continue;
      if (ch === '|') continue;
      const cx = goalLeft + col * charW;
      const cy = (5 - row) * lineH;
      if (p.x + pw <= cx || p.x >= cx + charW) continue;
      if (ph <= cy) continue;
      if (p.x + pw / 2 < midX) {
        p.x = cx + charW;
      } else {
        p.x = cx - pw;
      }
      return;
    }
  }

  /* ── Scoring & state transitions ───────────────────────── */

  _scoreGoal(s, side) {
    s.ball.goalFrame = GOAL_ROLL_FRAMES;
    s.paused = true;
    s.pauseTimer = CELEBRATE_TICKS;
    s.pausePhase = 'celebrate';

    if (side === 'left') {
      s.scoreR++;
      s.goalScorer = s.p2;
      this._setState(s.p2, 'jump');
      this._setState(s.p1, 'idle');
      s.events.push('goal_left');
    } else {
      s.scoreL++;
      s.goalScorer = s.p1;
      this._setState(s.p1, 'jump');
      this._setState(s.p2, 'idle');
      s.events.push('goal_right');
    }

    if (s.scoreL >= WIN_SCORE || s.scoreR >= WIN_SCORE) {
      s.pausePhase = 'matchend';
      s.pauseTimer = Math.ceil(3000 / TICK);
      s.winner = s.scoreL >= WIN_SCORE ? 'left' : 'right';
    }
  }

  _ballOut(s) {
    s.paused = true;
    s.pausePhase = 'reposition';
    s.goalScorer = null;
    s.p1.jumpY = 0;
    s.p2.jumpY = 0;
    this._setState(s.p1, 'walk');
    this._setState(s.p2, 'walk');
    s.ball.vx = 0;
    s.ball.vy = 0;
    s.ball.vz = 0;
    s.ball.z = 0;
    s.events.push('out');
  }

  _resetBall(s) {
    const ball = s.ball;
    ball.x = this.field.midX;
    ball.y = FIELD_HEIGHT / 2;
    ball.vx = 0;
    ball.vy = 0;
    ball.z = RESPAWN_DROP_Z;
    ball.vz = 0;
    ball.goalFrame = 0;
    s.graceFrames = RESPAWN_GRACE;
    s.lastKickTick = s.tickCount;
  }

  _respawn(s) {
    this._resetBall(s);
    s.paused = false;
    s.pausePhase = '';
    s.respawnTimer = 0;
    s.goalScorer = null;
    s.p1.jumpY = 0;
    s.p2.jumpY = 0;
    s.p1.stamina = 1;
    s.p1.exhausted = false;
    s.p2.stamina = 1;
    s.p2.exhausted = false;
  }

  _resetMatch(s) {
    s.scoreL = 0;
    s.scoreR = 0;
    this._resetPlayerPos(s.p1);
    this._resetPlayerPos(s.p2);
    this._resetBall(s);
    s.paused = false;
    s.pausePhase = '';
    s.respawnTimer = 0;
    s.goalScorer = null;
    s.matchOver = true;
  }

  _resetPlayerPos(p) {
    const x = this._startingX(p);
    p.x = x;
    p.y = FIELD_HEIGHT / 2;
    p.dir = p.side === 'left' ? 1 : -1;
    this._setState(p, 'idle');
    p.jumpY = 0;
    p.pushVx = 0;
    p.pushVy = 0;
    p.stamina = 1;
    p.exhausted = false;
    p.prevX = x;
    p.prevY = FIELD_HEIGHT / 2;
  }

  _startingX(p) {
    return p.side === 'left'
      ? this.field.midX - STARTING_GAP - this.field.playerWidth / 2
      : this.field.midX + STARTING_GAP - this.field.playerWidth / 2;
  }

  _playersAtStart(s) {
    const t1 = this._startingX(s.p1);
    const t2 = this._startingX(s.p2);
    return Math.abs(s.p1.x - t1) < REPOSITION_TOL_X && Math.abs(s.p1.y - FIELD_HEIGHT / 2) < REPOSITION_TOL_Y &&
           Math.abs(s.p2.x - t2) < REPOSITION_TOL_X && Math.abs(s.p2.y - FIELD_HEIGHT / 2) < REPOSITION_TOL_Y;
  }

  /* ── Paused state handling ─────────────────────────────── */

  _tickPaused(s) {
    if (s.pausePhase === 'matchend') {
      s.pauseTimer--;
      if (s.goalScorer) {
        s.goalScorer.stateTime += TICK;
        const phase = (s.goalScorer.stateTime % JUMP_PHASE_MS) / JUMP_PHASE_MS;
        s.goalScorer.jumpY = Math.sin(phase * Math.PI) * JUMP_HEIGHT;
        s.goalScorer.state = 'jump'; // direct set — keeps stateTime running for continuous jump
      }
      if (s.pauseTimer <= 0) this._resetMatch(s);
      return;
    }

    if (s.pausePhase === 'celebrate') {
      s.pauseTimer--;
      [s.p1, s.p2].forEach(p => {
        if (p.state === 'jump') {
          p.stateTime += TICK;
          const phase = (p.stateTime % JUMP_PHASE_MS) / JUMP_PHASE_MS;
          p.jumpY = Math.sin(phase * Math.PI) * JUMP_HEIGHT;
        }
      });
      // Update ball during goal roll
      if (s.ball.goalFrame > 0) {
        s.ball.goalFrame--;
        s.ball.x += s.ball.vx;
        s.ball.y += s.ball.vy;
      }
      if (s.pauseTimer <= 0) {
        s.pausePhase = 'reposition';
        s.p1.jumpY = 0;
        s.p2.jumpY = 0;
        this._setState(s.p1, 'walk');
        this._setState(s.p2, 'walk');
      }
      return;
    }

    if (s.pausePhase === 'reposition') {
      [s.p1, s.p2].forEach(p => {
        p.stateTime += TICK;
        p.ft++;
        const tx = this._startingX(p);
        const ty = FIELD_HEIGHT / 2;
        const dx = tx - p.x;
        const dy = ty - p.y;
        if (Math.abs(dx) > REPOSITION_TOL_X || Math.abs(dy) > REPOSITION_TOL_Y) {
          p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.1, REPOSITION_SPEED);
          p.y += Math.sign(dy) * Math.min(Math.abs(dy) * 0.1, REPOSITION_Y_MAX);
          p.dir = dx > 0 ? 1 : -1;
          if (p.ft % WALK_ANIM_BASE === 0) p.fi = (p.fi + 1) % 2;
        } else {
          p.x = tx;
          p.y = ty;
          if (p.state !== 'idle') this._setState(p, 'idle');
        }
      });
      if (this._playersAtStart(s)) {
        s.respawnTimer = RESPAWN_DELAY_TICKS;
        s.pausePhase = 'waiting';
      }
      return;
    }

    if (s.pausePhase === 'waiting') {
      s.respawnTimer--;
      if (s.respawnTimer <= 0) this._respawn(s);
    }
  }

  /* ── Input normalization helper ────────────────────────── */

  /**
   * Build the 18-float normalized input vector for a player.
   * Mirrors coordinates so both sides see the game from their own perspective.
   *
   * @param {GameState} s
   * @param {'p1'|'p2'} which
   * @returns {number[]}
   */
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
}

export { FIELD_HEIGHT, STARTING_GAP };
