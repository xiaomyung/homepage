/**
 * ASCII Football — two stickmen compete on a miniature pitch.
 *
 * Self-contained IIFE that creates a #game-stage element.
 * When the mouse is idle both players are AI-controlled.
 * Moving the mouse gives control of player 1's horizontal position.
 * Kicking is always automatic on proximity for both players.
 *
 * Ball physics: 2D ground sliding (x/y) with optional lob (z axis, gravity).
 * Goals: per-character hitbox collision on ASCII art, diagonal goal-line scoring.
 * Match: first to WIN_SCORE wins, then new random players are assigned.
 */
(function () {

  /* ── Config ─────────────────────────────────────────────── */

  const TICK            = 16;     // ms per frame (~60 FPS)
  const GRAVITY         = 0.3;    // air-height gravity per tick
  const AIR_BOUNCE      = 0.6;    // energy kept on air bounce (ball.z)
  const AIR_FRICTION    = 0.99;   // velocity damping while airborne
  const GROUND_FRICTION = 0.944;  // velocity damping on the ground
  const EASING          = 0.08;   // movement interpolation factor
  const WALK_FRAME_INT  = 6;      // ticks between walk frame advances
  const MAX_SPEED       = 10;     // max player movement speed per tick
  const FIELD_HEIGHT    = 42;     // vertical play area in px (~3 character rows)
  const KICK_REACH_X    = 0.5;    // multiplier on player width for kick proximity
  const KICK_REACH_Y    = 10;     // vertical px proximity to kick
  const WIN_SCORE       = 3;

  const CELEBRATE_MS    = 1500;
  const MATCHEND_MS     = 3000;
  const RESPAWN_DELAY   = 300;    // ms after players reach positions before ball drops
  const STALL_MS        = 10000;  // respawn ball if no kick for this long
  const RESPAWN_GRACE   = 30;     // frames to skip goal detection after respawn

  const PUSH_COOLDOWN   = 2000;
  const PUSH_MIN        = 50;
  const PUSH_MAX        = 200;
  const PUSH_ANIM_MS    = 300;
  const PUSH_PROXIMITY  = 30;     // max px apart horizontally to trigger push
  const PUSH_PROXIMITY_Y = 20;    // max px apart vertically to trigger push
  const PUSH_CHANCE     = 0.03;   // chance per tick when close enough
  const PUSH_DAMP       = 0.88;   // push velocity decay per tick
  const PUSH_APPLY      = 0.12;   // fraction of push velocity applied per tick

  const BOUNCE_DAMP     = 0.8;    // velocity retained on goal frame bounce
  const OWN_GOAL_CHANCE = 0.07;   // chance a kick goes toward own goal

  const PLAYER_HB_W     = 3;      // player hitbox width in chars
  const PLAYER_HB_H     = 1.9;   // player hitbox height in rows (< 2-row goal opening)
  const JUMP_HEIGHT     = 18;     // px amplitude of celebration jump
  const JUMP_PERIOD     = 400;    // ms for one full jump cycle
  const NAME_HIDE_DIST  = 35;     // px between players to hide name labels

  /* ── Frames ─────────────────────────────────────────────── */

  const FRAMES = {
    idle:  " o \n(|)\n/\\ ",
    walk:  ["  o\n//\\_\n/ \\", "  o\n(/)\n | ", "  o\n//\\_\n/ \\", "  o\n(/)\n | "],
    alert: "\\o/\n | \n/\\ ",
    kick:  [" o \n(|)\n |( ", " o \n(|)\n |\\_", " o \n(|)\n |) "],
    push:  " o \n(|\\_@\n/\\ ",
  };

  /* ── Player surnames ────────────────────────────────────── */

  const SURNAMES = [
    'Messi', 'Ronaldo', 'Neymar', 'Mbappé', 'Haaland', 'Salah', 'De Bruyne',
    'Modric', 'Benzema', 'Lewandowski', 'Vinícius', 'Bellingham', 'Pedri',
    'Gavi', 'Saka', 'Foden', 'Kane', 'Son', 'Mané', 'Díaz', 'Griezmann',
    'Müller', 'Kimmich', 'Hakimi', 'Palmer', 'Yamal', 'Rodri', 'Doku',
  ];

  /* ── DOM helpers ────────────────────────────────────────── */

  function addPre(parent, text, className) {
    const el = document.createElement('pre');
    el.setAttribute('aria-hidden', 'true');
    if (text) el.textContent = text;
    if (className) el.className = className;
    parent.appendChild(el);
    return el;
  }

  function addSpan(parent, text, className) {
    const el = document.createElement('span');
    if (text) el.textContent = text;
    if (className) el.className = className;
    parent.appendChild(el);
    return el;
  }

  /* ── DOM setup ──────────────────────────────────────────── */

  const stage = document.createElement('div');
  stage.id = 'game-stage';
  document.body.appendChild(stage);

  // Layer 1: field border (background, scales with screen width)
  const fieldBorderEl = addPre(stage, '', 'fb-field-border');

  // Layer 2: goal lines (scoring boundary hitboxes)
  const goalLineL = addPre(stage, '  /\n / \n/  ', 'fb-goalline fb-goalline-l');
  const goalLineR = addPre(stage, '\\  \n \\ \n  \\', 'fb-goalline fb-goalline-r');

  // Layer 3: goals (collision hitboxes, foreground)
  const goalL = addPre(stage, '     ___ \n    /  /|\n   /__/_|\n  /__/   \n /   |   \n/____|  ', 'fb-goal fb-goal-l');
  const goalR = addPre(stage, ' ___    \n|\\  \\   \n|_\\__\\  \n   \\__\\ \n   |   \\\n   |____\\', 'fb-goal fb-goal-r');

  const ballEl = addPre(stage, 'o', 'fb-ball');
  const scoreboardEl = addPre(stage, '', 'fb-scoreboard');

  /* ── Player factory ─────────────────────────────────────── */

  function createPlayer(side, name) {
    const el = addPre(stage, FRAMES.idle, 'fb-player');
    const nameEl = addSpan(stage, name, 'fb-name');
    return {
      el, nameEl, name,
      x: 0, y: 0,
      dir: side === 'right' ? -1 : 1,
      state: 'idle', stateTime: 0, fi: 0, ft: 0,
      jumpY: 0,
      moveSpeed: 6,
      lastPush: 0, pushVx: 0, pushVy: 0,
    };
  }

  const p1 = createPlayer('left', pickName());
  const p2 = createPlayer('right', pickName(p1.name));

  /* ── Game state ─────────────────────────────────────────── */

  const ball = { x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0 };
  let targetX = 0;
  let lastInput = 0;
  let scoreL = 0;
  let scoreR = 0;
  let paused = false;
  let pauseTimer = 0;
  let pausePhase = '';
  let respawnTimer = 0;
  let goalScorer = null;
  let lastKickTime = Date.now();
  let graceFrames = 0;
  let leftBound = 0;
  let rightBound = 0;
  let charW = 0;
  let lineH = 0;

  /* ── Measurement & bounds ───────────────────────────────── */

  function measure() {
    if (!goalL.offsetHeight || !goalL.offsetWidth) return;
    lineH = goalL.offsetHeight / 6;
    charW = goalL.offsetWidth / 9;
  }

  function calcBounds() {
    if (!charW) measure();
    if (!charW) return;
    // AI walk limits: just past front posts so AI doesn't oscillate against them
    leftBound = goalL.offsetLeft + 6 * charW;
    rightBound = goalR.offsetLeft + 3 * charW;
  }

  function fieldCenter() {
    return (goalL.offsetLeft + goalL.offsetWidth + goalR.offsetLeft) / 2;
  }

  function startingX(p) {
    const mid = fieldCenter();
    const w = p.el.offsetWidth;
    const gap = 40;
    return p === p1 ? mid - gap - w / 2 : mid + gap - w / 2;
  }

  function playersAtStart() {
    return Math.abs(p1.x - startingX(p1)) < 5 && Math.abs(p1.y - FIELD_HEIGHT / 2) < 5 &&
           Math.abs(p2.x - startingX(p2)) < 5 && Math.abs(p2.y - FIELD_HEIGHT / 2) < 5;
  }

  /* ── Utility functions ──────────────────────────────────── */

  function pickName(exclude) {
    let name;
    do { name = SURNAMES[Math.floor(Math.random() * SURNAMES.length)]; } while (name === exclude);
    return name;
  }

  function pickSpeed(distance) {
    const base = Math.min(distance * 0.1, MAX_SPEED);
    const jitter = (Math.random() - 0.5) * MAX_SPEED;
    return Math.max(1, Math.min(MAX_SPEED, base + jitter));
  }

  function setState(p, s) {
    p.state = s;
    p.stateTime = 0;
    p.fi = 0;
    p.ft = 0;
  }

  function getFrame(p) {
    switch (p.state) {
      case 'walk':  return FRAMES.walk[p.fi % FRAMES.walk.length];
      case 'kick':
      case 'airkick': return FRAMES.kick[Math.min(p.fi, FRAMES.kick.length - 1)];
      case 'jump':  return FRAMES.alert;
      case 'push':  return FRAMES.push;
      case 'alert': return FRAMES.alert;
      default:      return FRAMES.idle;
    }
  }

  function mouseActive() { return Date.now() - lastInput < 2000; }

  function atRest() {
    return Math.abs(ball.vx) < 0.5 && Math.abs(ball.vy) < 0.5 && ball.z < 1;
  }

  function clampPlayer(p) {
    p.y = Math.max(0, Math.min(FIELD_HEIGHT, p.y));
    if (!charW || !lineH) return;
    collidePlayerGoal(p, HITBOX_L, goalL);
    collidePlayerGoal(p, HITBOX_R, goalR);
  }

  function collidePlayerGoal(p, hitbox, goalEl) {
    const pw = PLAYER_HB_W * charW;
    const ph = PLAYER_HB_H * lineH;
    const mid = fieldCenter();
    for (const [row, col, ch] of hitbox) {
      if (ch === '_' && row === 5) continue; // floor surface
      if (ch === '|') continue; // posts are the doorframe — walk through
      const cx = goalEl.offsetLeft + col * charW;
      const cy = (5 - row) * lineH;
      if (p.x + pw <= cx || p.x >= cx + charW) continue;
      // player height is fixed (ground-bound) — p.y is field depth, not added height
      if (ph <= cy) continue;
      // always push toward field center
      if (p.x + pw / 2 < mid) {
        p.x = cx + charW;
      } else {
        p.x = cx - pw;
      }
      return;
    }
  }

  function updateScoreboard() {
    scoreboardEl.textContent = p1.name + ' ' + scoreL + ' \u2502 ' + scoreR + ' ' + p2.name;
  }

  /* ── Field border (scales with screen width) ────────────── */

  function buildFieldBorder() {
    if (!charW) measure();
    if (!charW || !stage.offsetWidth) return;
    const total = Math.floor(stage.offsetWidth / charW) - 1;
    if (total < 12) return;
    const w = Math.max(0, total - 2);
    const lines = [
      '     ' + '_'.repeat(Math.max(0, total - 10)) + '     ',
      '    /' + ' '.repeat(Math.max(0, total - 10)) + '\\    ',
      '   /' + ' '.repeat(Math.max(0, total - 8)) + '\\   ',
      '  /' + ' '.repeat(Math.max(0, total - 6)) + '\\  ',
      ' /' + ' '.repeat(Math.max(0, total - 4)) + '\\ ',
      '/' + '_'.repeat(w) + '\\',
    ];
    fieldBorderEl.textContent = lines.join('\n');
  }

  requestAnimationFrame(buildFieldBorder);
  window.addEventListener('resize', buildFieldBorder);

  /* ── Ball ────────────────────────────────────────────────── */

  function resetBall() {
    ball.x = fieldCenter();
    ball.y = FIELD_HEIGHT / 2;
    ball.vx = 0;
    ball.vy = 0;
    ball.z = 60;
    ball.vz = 0;
    graceFrames = RESPAWN_GRACE;
    lastKickTime = Date.now();
  }

  function kick(p) {
    const power = 0.3 + Math.random() * 0.7;
    const angle = 0.2 + Math.random() * 0.6;
    const force = 8 + power * 14;
    const mid = stage.offsetWidth / 2;
    const px = p.x + p.el.offsetWidth / 2;

    // always kick toward opponent's goal; p1 attacks right, p2 attacks left
    let dir = p === p1 ? 1 : -1;
    if (Math.random() < OWN_GOAL_CHANCE) dir = -dir;

    ball.vx = dir * force * (1 - angle);

    // aim at center of target goal opening with weighted random drift
    const targetGL = dir > 0 ? goalLineR : goalLineL;
    const glh = targetGL.offsetHeight / 3;
    const drift = (Math.random() - Math.random()) * 2;
    const targetY = glh * 1.5 + drift * glh;
    const dx = targetGL.offsetLeft + targetGL.offsetWidth / 2 - ball.x;
    ball.vy = dx !== 0 ? ball.vx * (targetY - ball.y) / dx : 0;

    ball.vz = angle > 0.5 ? force * angle * 0.6 : 0;
    lastKickTime = Date.now();
  }

  function canKick(p) {
    if (p.state === 'kick' || p.state === 'airkick') return false;
    if (ball.z > PLAYER_HB_H * lineH) return false; // ball too high to reach
    const center = p.x + p.el.offsetWidth / 2;
    const closeX = Math.abs(ball.x - center) < p.el.offsetWidth * KICK_REACH_X;
    const closeY = Math.abs(ball.y - p.y) < KICK_REACH_Y;
    return closeX && closeY;
  }

  function startKick(p) {
    if (ball.z > 1) {
      p.airKickZ = ball.z;
      p.airKickFired = false;
      setState(p, 'airkick');
    } else {
      setState(p, 'kick');
    }
  }

  function updateBall() {
    if (paused) {
      // let ball travel one extra frame after goal before stopping
      if (ball.goalFrame > 0) { ball.goalFrame--; }
      else return;
    }
    const moving = Math.abs(ball.vx) > 0.01 || Math.abs(ball.vy) > 0.01 ||
                   ball.z > 0 || ball.vz > 0;
    if (!moving) return;

    // ground movement
    ball.x += ball.vx;
    ball.y += ball.vy;
    const friction = ball.z > 0 ? AIR_FRICTION : GROUND_FRICTION;
    ball.vx *= friction;
    ball.vy *= friction;

    // air physics
    if (ball.z > 0 || ball.vz > 0) {
      ball.vz -= GRAVITY;
      ball.z += ball.vz;
      if (ball.z <= 0) {
        ball.z = 0;
        ball.vz = Math.abs(ball.vz) > 1.5 ? Math.abs(ball.vz) * AIR_BOUNCE : 0;
      }
    }

    // field-Y bounds
    if (ball.y < 0) { ball.y = 0; ball.vy = Math.abs(ball.vy) * 0.5; }
    if (ball.y > FIELD_HEIGHT) { ball.y = FIELD_HEIGHT; ball.vy = -Math.abs(ball.vy) * 0.5; }

    // ceiling (keep ball below scoreboard)
    const ceiling = stage.offsetHeight - 20;
    if (ball.y + ball.z > ceiling) {
      ball.z = ceiling - ball.y;
      ball.vz = -Math.abs(ball.vz) * AIR_BOUNCE;
    }

    // velocity cutoff
    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;
    if (Math.abs(ball.vy) < 0.1) ball.vy = 0;

    checkFrameCollision();
    if (!paused && graceFrames <= 0) checkGoalLine();

    // out of bounds — no goal, just reposition and respawn
    const sw = stage.offsetWidth;
    if (!paused && (ball.x < -50 || ball.x > sw + 50)) {
      ballOut();
    }
  }

  /* ── Goal frame collision ───────────────────────────────── */

  // Per-character hitboxes: [row, col, char] — row 0 = top of 6-line ASCII art
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

  // Goal-line scoring boundary: 3-line diagonal at goal opening
  const SCORELINE_L = [[0, 2], [1, 1], [2, 0]];
  const SCORELINE_R = [[0, 0], [1, 1], [2, 2]];

  function bounceBallGoal(hitbox, goalEl) {
    const br = 4;
    const bh = ball.y + ball.z;
    for (const [row, col, ch] of hitbox) {
      const cx = goalEl.offsetLeft + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x + br <= cx || ball.x - br >= cx + charW) continue;
      if (bh + br <= cy || bh - br >= cy + lineH) continue;

      // push to nearest horizontal edge
      const dir = ball.x < cx + charW / 2 ? -1 : 1;
      ball.x = dir < 0 ? cx - br - 1 : cx + charW + br + 1;
      ball.vx = dir * Math.abs(ball.vx) * BOUNCE_DAMP;

      if (ch === '/' || ch === '\\') ball.vy += (Math.random() - 0.5) * 3;
      return;
    }
  }

  function checkFrameCollision() {
    if (!charW) measure();
    if (!charW) return;
    bounceBallGoal(HITBOX_L, goalL);
    bounceBallGoal(HITBOX_R, goalR);
  }

  function checkGoalLine() {
    if (!charW) measure();
    if (!charW) return;
    // ball must be below crossbar height to score
    if (ball.z > 2 * lineH) return;
    // score when ball fully passes the visible stroke of the outermost diagonal char
    // left `/`: ball must pass its left edge; right `\`: ball must pass its right edge
    const scoreL = goalLineL.offsetLeft + 2 * charW - charW / 2;
    const scoreR = goalLineR.offsetLeft + charW + charW / 2;
    if (ball.x < scoreL) { scoreGoal('left'); return; }
    if (ball.x > scoreR) { scoreGoal('right'); return; }
  }

  /* ── Player logic ───────────────────────────────────────── */

  function walkToward(p, tx, ty) {
    const w = p.el.offsetWidth;
    const dx = tx - (p.x + w / 2);
    p.x += Math.sign(dx) * Math.min(Math.abs(dx) * EASING, p.moveSpeed);
    p.dir = dx > 0 ? 1 : -1;
    if (ty !== undefined) {
      const dy = ty - p.y;
      p.y += Math.sign(dy) * Math.min(Math.abs(dy) * EASING, p.moveSpeed);
    }
    // animation speed scales with movement speed
    const walkInt = Math.max(2, Math.round(WALK_FRAME_INT * (MAX_SPEED / 2) / p.moveSpeed));
    if (p.ft % walkInt === 0) p.fi = (p.fi + 1) % FRAMES.walk.length;
    clampPlayer(p);
  }

  // Handles kick, push, jump states — shared between AI and human
  function tickShared(p) {
    switch (p.state) {
      case 'kick':
        if (p.ft % WALK_FRAME_INT === 0 && p.ft > 0) {
          p.fi++;
          if (p.fi === 1) kick(p);
          if (p.fi >= FRAMES.kick.length) setState(p, 'idle');
        }
        return true;
      case 'airkick': {
        // jump up to ball height, kick at peak, fall back
        const jumpTarget = p.airKickZ || 0;
        const totalMs = 350;
        const phase = Math.min(p.stateTime / totalMs, 1);
        p.jumpY = Math.sin(phase * Math.PI) * jumpTarget;
        // kick at the peak (~halfway)
        if (!p.airKickFired && phase >= 0.4) {
          p.airKickFired = true;
          kick(p);
        }
        // advance kick frame visuals
        if (p.ft % WALK_FRAME_INT === 0 && p.ft > 0) {
          p.fi = Math.min(p.fi + 1, FRAMES.kick.length - 1);
        }
        if (phase >= 1) {
          p.jumpY = 0;
          p.airKickZ = 0;
          p.airKickFired = false;
          setState(p, 'idle');
        }
        return true;
      }
      case 'push':
        if (p.stateTime >= PUSH_ANIM_MS) setState(p, 'idle');
        return true;
      case 'jump': {
        const phase = (p.stateTime % JUMP_PERIOD) / JUMP_PERIOD;
        p.jumpY = Math.sin(phase * Math.PI) * JUMP_HEIGHT;
        if (p.stateTime > CELEBRATE_MS) {
          p.jumpY = 0;
          setState(p, 'idle');
        }
        return true;
      }
    }
    return false;
  }

  function updateAI(p) {
    p.stateTime += TICK;
    p.ft++;
    if (tickShared(p)) return;

    if (p.state === 'alert') {
      if (p.stateTime >= 300) setState(p, 'walk');
      return;
    }

    if (canKick(p)) { startKick(p); return; }

    // shorter idle when ball is airborne — stay ready to move
    const idleWait = ball.z > 1 ? 30 : 200;
    if (p.state === 'idle' && p.stateTime > idleWait) {
      p.moveSpeed = pickSpeed(Math.abs(ball.x - (p.x + p.el.offsetWidth / 2)));
      setState(p, 'walk');
    }

    if (p.state === 'walk') {
      // chase the ball's ground shadow (x,y ignoring z height)
      const tx = ball.x + ball.vx * 10;
      const ty = ball.y;
      const center = p.x + p.el.offsetWidth / 2;
      const dx = tx - center;
      const w = p.el.offsetWidth;
      const atEdge = p.x <= leftBound || p.x >= rightBound - w;
      const closeEnough = ball.z > 1 ? 3 : 8;

      if (Math.abs(dx) < closeEnough || (atEdge && Math.abs(dx) < w)) {
        setState(p, 'idle');
      } else {
        walkToward(p, tx, ty);
      }
    }
  }

  const HUMAN_SPEED = 8;
  let kickRequested = false;

  function updateHuman(p) {
    p.stateTime += TICK;
    p.ft++;
    if (tickShared(p)) return;

    if (kickRequested && canKick(p)) {
      kickRequested = false;
      startKick(p);
      return;
    }

    const dx = targetX - (p.x + p.el.offsetWidth / 2);
    if (Math.abs(dx) > 5) {
      if (p.state !== 'walk') {
        p.moveSpeed = HUMAN_SPEED;
        setState(p, 'walk');
      }
      walkToward(p, targetX, ball.y);
    } else {
      if (p.state !== 'idle') setState(p, 'idle');
    }
  }

  /* ── Push mechanic ──────────────────────────────────────── */

  function tryPush(a, b, now) {
    if (now - a.lastPush < PUSH_COOLDOWN) return;
    if (a.state === 'push' || a.state === 'kick' || a.state === 'airkick' || a.state === 'jump') return;

    const ca = a.x + a.el.offsetWidth / 2;
    const cb = b.x + b.el.offsetWidth / 2;
    if (Math.abs(ca - cb) > PUSH_PROXIMITY) return;
    if (Math.abs(a.y - b.y) > PUSH_PROXIMITY_Y) return;
    if (Math.random() > PUSH_CHANCE) return;

    a.lastPush = now;
    a.dir = ca < cb ? 1 : -1;
    setState(a, 'push');

    const force = PUSH_MIN + Math.random() * (PUSH_MAX - PUSH_MIN);
    b.pushVx = a.dir * force;
    b.pushVy = (Math.random() - 0.5) * force * 0.5;
    damageParticles(b, a.dir);
  }

  function applyPush(p) {
    if (Math.abs(p.pushVx) > 0.5) {
      p.x += p.pushVx * PUSH_APPLY;
      p.pushVx *= PUSH_DAMP;
    } else {
      p.pushVx = 0;
    }
    if (Math.abs(p.pushVy) > 0.5) {
      p.y += p.pushVy * PUSH_APPLY;
      p.pushVy *= PUSH_DAMP;
    } else {
      p.pushVy = 0;
    }
    clampPlayer(p);
  }

  /* ── Scoring ────────────────────────────────────────────── */

  function scoreGoal(side) {
    ball.goalFrame = 2;
    paused = true;
    pauseTimer = CELEBRATE_MS;
    pausePhase = 'celebrate';

    if (side === 'left') {
      scoreR++;
      goalScorer = p2;
      setState(p2, 'jump');
      setState(p1, 'idle');
      celebrate(goalL.offsetLeft + goalL.offsetWidth / 2);
    } else {
      scoreL++;
      goalScorer = p1;
      setState(p1, 'jump');
      setState(p2, 'idle');
      celebrate(goalR.offsetLeft + goalR.offsetWidth / 2);
    }
    updateScoreboard();

    if (scoreL >= WIN_SCORE || scoreR >= WIN_SCORE) {
      pausePhase = 'matchend';
      pauseTimer = MATCHEND_MS;
      scoreboardEl.textContent = 'Winner: ' + (scoreL >= WIN_SCORE ? p1.name : p2.name);
    }
  }

  function respawn() {
    resetBall();
    paused = false;
    pausePhase = '';
    respawnTimer = 0;
    goalScorer = null;
    p1.jumpY = 0;
    p2.jumpY = 0;
  }

  function ballOut() {
    paused = true;
    pausePhase = 'reposition';
    goalScorer = null;
    p1.jumpY = 0;
    p2.jumpY = 0;
    setState(p1, 'walk');
    setState(p2, 'walk');
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
  }

  function resetMatch() {
    p1.name = pickName();
    p2.name = pickName(p1.name);
    p1.nameEl.textContent = p1.name;
    p2.nameEl.textContent = p2.name;
    scoreL = 0;
    scoreR = 0;
    p1.x = startingX(p1);
    p2.x = startingX(p2);
    p1.y = FIELD_HEIGHT / 2;
    p2.y = FIELD_HEIGHT / 2;
    p1.dir = 1;
    p2.dir = -1;
    setState(p1, 'idle');
    setState(p2, 'idle');
    p1.jumpY = 0;
    p2.jumpY = 0;
    resetBall();
    paused = false;
    pausePhase = '';
    respawnTimer = 0;
    goalScorer = null;
    updateScoreboard();
  }

  /* ── Celebration particles ──────────────────────────────── */

  function celebrate(cx) {
    const count = 6 + (Math.random() * 4 | 0);
    for (let i = 0; i < count; i++) {
      const spark = document.createElement('span');
      spark.textContent = Math.random() < 0.5 ? '*' : '\u2726';
      spark.style.cssText = 'position:absolute;pointer-events:none;font-size:0.8rem;color:rgba(255,255,255,0.5)';
      spark.style.left = cx + 'px';
      spark.style.bottom = '30px';
      stage.appendChild(spark);

      const pvx = (Math.random() - 0.5) * 6;
      const pvy = -(2 + Math.random() * 4);
      let sx = 0, sy = 0, op = 1, f = 0;

      (function animate() {
        f++;
        sx += pvx;
        sy += pvy + f * 0.15;
        op -= 0.02;
        spark.style.transform = `translate(${sx}px,${sy}px)`;
        spark.style.opacity = Math.max(0, op);
        if (op > 0 && f < 50) requestAnimationFrame(animate);
        else spark.remove();
      })();
    }
  }

  function damageParticles(p, pushDir) {
    const cx = p.x + p.el.offsetWidth / 2;
    const by = 10 + p.y + 10;
    const chars = ['!', '×', '·', '#'];
    const count = 3 + (Math.random() * 3 | 0);
    for (let i = 0; i < count; i++) {
      const spark = document.createElement('span');
      spark.textContent = chars[Math.random() * chars.length | 0];
      spark.style.cssText = 'position:absolute;pointer-events:none;font-family:monospace;font-size:0.6rem;color:rgba(247,118,142,0.7)';
      spark.style.left = cx + 'px';
      spark.style.bottom = by + 'px';
      stage.appendChild(spark);

      // burst away from the push direction
      const pvx = pushDir * (1 + Math.random() * 3) + (Math.random() - 0.5) * 2;
      const pvy = -(1 + Math.random() * 3);
      let sx = 0, sy = 0, op = 1, f = 0;

      (function animate() {
        f++;
        sx += pvx;
        sy += pvy + f * 0.2;
        op -= 0.04;
        spark.style.transform = `translate(${sx}px,${sy}px)`;
        spark.style.opacity = Math.max(0, op);
        if (op > 0 && f < 30) requestAnimationFrame(animate);
        else spark.remove();
      })();
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  function render() {
    const c1 = p1.x + p1.el.offsetWidth / 2;
    const c2 = p2.x + p2.el.offsetWidth / 2;
    const hideNames = Math.abs(c1 - c2) < NAME_HIDE_DIST;

    [p1, p2].forEach(p => {
      p.el.textContent = getFrame(p);
      const w = p.el.offsetWidth;
      const yOff = (p.jumpY || 0) + p.y;
      p.el.style.transform = p.dir === 1
        ? `translate(${p.x}px,${-yOff}px)`
        : `translate(${p.x + w}px,${-yOff}px) scaleX(-1)`;

      const nw = p.nameEl.offsetWidth;
      p.nameEl.style.transform = `translate(${p.x + w / 2 - nw / 2}px,${-yOff}px)`;
      p.nameEl.style.opacity = hideNames ? '0' : '1';
    });

    ballEl.style.transform = `translate(${ball.x}px,${-(ball.y + ball.z)}px)`;
  }

  /* ── Main loop ──────────────────────────────────────────── */

  function init() {
    calcBounds();
    p1.x = startingX(p1);
    p2.x = startingX(p2);
    p1.y = FIELD_HEIGHT / 2;
    p2.y = FIELD_HEIGHT / 2;
    resetBall();
    // position goal lines relative to goal edges
    if (charW) {
      goalLineL.style.left = (goalL.offsetLeft + goalL.offsetWidth - charW * 3) + 'px';
      goalLineR.style.left = goalR.offsetLeft + 'px';
    }
    updateScoreboard();
  }

  function update() {
    calcBounds();

    if (paused) {
      // match end: winner celebrates until timer expires
      if (pausePhase === 'matchend') {
        pauseTimer -= TICK;
        if (goalScorer) {
          goalScorer.stateTime += TICK;
          goalScorer.jumpY = Math.sin((goalScorer.stateTime % JUMP_PERIOD) / JUMP_PERIOD * Math.PI) * JUMP_HEIGHT;
          goalScorer.state = 'jump';
        }
        if (pauseTimer <= 0) resetMatch();
        return;
      }

      // post-goal celebration
      if (pausePhase === 'celebrate') {
        pauseTimer -= TICK;
        [p1, p2].forEach(p => {
          if (p.state === 'jump') {
            p.stateTime += TICK;
            p.jumpY = Math.sin((p.stateTime % JUMP_PERIOD) / JUMP_PERIOD * Math.PI) * JUMP_HEIGHT;
          }
        });
        if (pauseTimer <= 0) {
          pausePhase = 'reposition';
          p1.jumpY = 0;
          p2.jumpY = 0;
          setState(p1, 'walk');
          setState(p2, 'walk');
        }
        return;
      }

      // walk to starting positions
      if (pausePhase === 'reposition') {
        [p1, p2].forEach(p => {
          p.stateTime += TICK;
          p.ft++;
          const tx = startingX(p);
          const dx = tx - p.x;
          const dy = FIELD_HEIGHT / 2 - p.y;
          if (Math.abs(dx) > 5 || Math.abs(dy) > 3) {
            p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.1, 6);
            p.y += Math.sign(dy) * Math.min(Math.abs(dy) * 0.1, 4);
            p.dir = dx > 0 ? 1 : -1;
            if (p.ft % WALK_FRAME_INT === 0) p.fi = (p.fi + 1) % FRAMES.walk.length;
          } else {
            p.x = tx;
            p.y = FIELD_HEIGHT / 2;
            if (p.state !== 'idle') setState(p, 'idle');
          }
        });
        if (playersAtStart()) {
          if (respawnTimer <= 0) {
            respawnTimer = RESPAWN_DELAY;
            pausePhase = 'waiting';
          }
        }
        return;
      }

      // wait before ball drop
      if (pausePhase === 'waiting') {
        respawnTimer -= TICK;
        if (respawnTimer <= 0) respawn();
        return;
      }
      return;
    }

    // active play
    if (graceFrames > 0) graceFrames--;

    if (mouseActive()) updateHuman(p1);
    else updateAI(p1);
    updateAI(p2);

    const now = Date.now();
    tryPush(p1, p2, now);
    tryPush(p2, p1, now);
    applyPush(p1);
    applyPush(p2);

    // stall detection
    if (now - lastKickTime > STALL_MS) {
      lastKickTime = now;
      resetBall();
    }
  }

  /* ── Input ──────────────────────────────────────────────── */

  function onInput(clientX) {
    targetX = clientX - stage.getBoundingClientRect().left;
    lastInput = Date.now();
  }

  document.addEventListener('mousemove', e => onInput(e.clientX));
  document.addEventListener('touchmove', e => onInput(e.touches[0].clientX), { passive: true });
  stage.addEventListener('click', () => { kickRequested = true; lastInput = Date.now(); });
  stage.addEventListener('touchstart', () => { kickRequested = true; lastInput = Date.now(); }, { passive: true });

  /* ── Start ──────────────────────────────────────────────── */

  requestAnimationFrame(init);

  let last = 0;
  (function loop(now) {
    if (now - last >= TICK) {
      last = now;
      update();
      updateBall();
      render();
    }
    requestAnimationFrame(loop);
  })(0);

})();
