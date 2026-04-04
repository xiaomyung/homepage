// ASCII Football — two stickmen compete on a miniature pitch
// Each game file is a self-contained IIFE that creates a #game-stage
(function () {

  /* ── Config ─────────────────────────────────────────────── */

  const TICK          = 16;   // ~60 FPS
  const GRAVITY       = 0.3;
  const BOUNCE        = 0.6;
  const AIR_FRICTION  = 0.99;
  const GROUND_FRICTION = 0.92;
  const CELEBRATE_MS  = 1500;
  const MATCHEND_MS   = 3000;
  const RESPAWN_DELAY_MS = 300;
  const STALL_MS      = 10000; // respawn ball if no kick for this long
  const PUSH_COOLDOWN = 3000;
  const PUSH_MIN      = 50;
  const PUSH_MAX      = 200;
  const PUSH_ANIM_MS  = 300;
  const KICK_REACH    = 0.9;  // multiplier on player width
  const RESPAWN_GRACE = 30;   // frames to skip goal detection after respawn

  // 15% chance ball bounces off goal post "|", otherwise passes through
  const POST_BOUNCE_CHANCE = 0.15;
  // 20% chance a kick goes toward own goal
  const OWN_GOAL_CHANCE = 0.2;

  /* ── Frames ─────────────────────────────────────────────── */

  const FRAMES = {
    idle:  " o \n(|)\n/\\ ",
    walk:  [" o \n/| \n/ \\", " o \n |)\n | ", " o \n |\\\n/ \\", " o \n(| \n | "],
    alert: "\\o/\n | \n/\\ ",
    kick:  [" o \n(|)\n |\\ ", " o \n(|)\n |/ ", " o \n(|)\n |_ "],
    push: " o \n/|\\_\n/\\ ",
  };

  /* ── Names ──────────────────────────────────────────────── */

  const SURNAMES = [
    'Messi','Ronaldo','Neymar','Mbappé','Haaland','Salah','De Bruyne',
    'Modric','Benzema','Lewandowski','Vinícius','Bellingham','Pedri',
    'Gavi','Saka','Foden','Kane','Son','Mané','Díaz','Griezmann',
    'Müller','Kimmich','Hakimi','Palmer','Yamal','Rodri','Doku',
  ];

  function pickName(exclude) {
    let name;
    do { name = SURNAMES[Math.floor(Math.random() * SURNAMES.length)]; } while (name === exclude);
    return name;
  }

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

  /* ── Stage ──────────────────────────────────────────────── */

  const stage = document.createElement('div');
  stage.id = 'game-stage';
  document.body.appendChild(stage);

  const ballEl = addPre(stage, 'o', 'fb-ball');

  const goalL = addPre(stage, '     _ _ \n    /  /|\n   /__/_|\n  /__/   \n /   |   \n/____|  ', 'fb-goal fb-goal-l');
  const goalR = addPre(stage, ' _ _    \n|\\  \\   \n|_\\__\\  \n   \\__\\ \n   |   \\\n   |____\\', 'fb-goal fb-goal-r');

  const goalLineL = addPre(stage, '         \n         \n         \n        /\n       / \n      /  ', 'fb-goalline fb-goalline-l');
  const goalLineR = addPre(stage, '         \n         \n         \n\\        \n \\       \n  \\      ', 'fb-goalline fb-goalline-r');

  const scoreboardEl = addPre(stage, '', 'fb-scoreboard');

  /* ── Player factory ─────────────────────────────────────── */

  function createPlayer(side, name) {
    const el = addPre(stage, FRAMES.idle, 'fb-player');
    const nameEl = addSpan(stage, name, 'fb-name');
    return {
      el, nameEl, name,
      x: 0,
      dir: side === 'right' ? -1 : 1,
      state: 'idle', stateTime: 0, fi: 0, ft: 0,
      jumpY: 0,
      lastPush: 0, pushVx: 0,
    };
  }

  const nameL = pickName();
  const nameR = pickName(nameL);
  const p1 = createPlayer('left', nameL);
  const p2 = createPlayer('right', nameR);

  /* ── Game state ─────────────────────────────────────────── */

  const ball = { x: 0, y: 0, vx: 0, vy: 0 };
  let targetX = 0, lastInput = 0;
  let scoreL = 0, scoreR = 0;
  let paused = false, pauseTimer = 0, pausePhase = '', respawnDelay = 0;
  let goalScorer = null;
  let lastKickTime = Date.now();
  let graceFrames = 0; // skip goal-line detection after respawn

  let leftBound = 0, rightBound = 0;
  let charW = 0, lineH = 0;

  function updateScoreboard() {
    scoreboardEl.textContent = p1.name + ' ' + scoreL + ' \u2502 ' + scoreR + ' ' + p2.name;
  }
  updateScoreboard();

  /* ── Bounds & measurement ───────────────────────────────── */

  function calcBounds() {
    leftBound = goalL.offsetLeft;
    rightBound = goalR.offsetLeft + goalR.offsetWidth;
  }

  function measure() {
    lineH = goalL.offsetHeight / 6;
    charW = goalL.offsetWidth / 9;
  }

  function clampPlayer(p) {
    const w = p.el.offsetWidth;
    p.x = Math.max(leftBound, Math.min(rightBound - w, p.x));
  }

  function fieldCenter() {
    return (goalL.offsetLeft + goalL.offsetWidth + goalR.offsetLeft) / 2;
  }

  /* ── Init ────────────────────────────────────────────────── */

  function init() {
    calcBounds();
    p1.x = startingX(p1);
    p2.x = startingX(p2);
    ball.x = stage.offsetWidth / 2;
    ball.y = stage.offsetHeight;
    ball.vx = 0;
    ball.vy = 0;
  }
  requestAnimationFrame(init);

  /* ── Input ──────────────────────────────────────────────── */

  function onInput(clientX) {
    targetX = clientX - stage.getBoundingClientRect().left;
    lastInput = Date.now();
  }
  document.addEventListener('mousemove', e => onInput(e.clientX));
  document.addEventListener('touchmove', e => onInput(e.touches[0].clientX), { passive: true });

  function mouseActive() { return Date.now() - lastInput < 2000; }
  function atRest() { return ball.y === 0 && ball.vy === 0 && Math.abs(ball.vx) < 0.5; }

  /* ── State helpers ──────────────────────────────────────── */

  function setState(p, s) { p.state = s; p.stateTime = 0; p.fi = 0; p.ft = 0; }

  function getFrame(p) {
    switch (p.state) {
      case 'walk':  return FRAMES.walk[p.fi % FRAMES.walk.length];
      case 'kick':  return FRAMES.kick[Math.min(p.fi, FRAMES.kick.length - 1)];
      case 'jump':  return FRAMES.alert;
      case 'push':  return FRAMES.push;
      case 'alert': return FRAMES.alert;
      default:      return FRAMES.idle;
    }
  }

  /* ── Kick ────────────────────────────────────────────────── */

  function kick(p) {
    const power = 0.3 + Math.random() * 0.7;
    const angle = 0.2 + Math.random() * 0.6;
    const force = 8 + power * 14;
    const mid = stage.offsetWidth / 2;
    const px = p.x + p.el.offsetWidth / 2;
    let dir = px < mid ? 1 : -1;
    if (Math.random() < OWN_GOAL_CHANCE) dir = -dir;
    ball.vx = dir * force * (1 - angle);
    ball.vy = force * angle;
    lastKickTime = Date.now();
  }

  function canKick(p) {
    if (p.state === 'kick') return false;
    const center = p.x + p.el.offsetWidth / 2;
    return atRest() && Math.abs(ball.x - center) < p.el.offsetWidth * KICK_REACH;
  }

  /* ── Shared state tick (kick, push, jump — identical for AI & player) ── */

  function tickShared(p) {
    switch (p.state) {
      case 'kick':
        if (p.ft % 6 === 0 && p.ft > 0) {
          p.fi++;
          if (p.fi === 1) kick(p);
          if (p.fi >= FRAMES.kick.length) setState(p, 'idle');
        }
        return true;
      case 'push':
        if (p.stateTime >= PUSH_ANIM_MS) setState(p, 'idle');
        return true;
      case 'jump': {
        const phase = (p.stateTime % 400) / 400;
        p.jumpY = Math.sin(phase * Math.PI) * 18;
        if (p.stateTime > CELEBRATE_MS) { p.jumpY = 0; setState(p, 'idle'); }
        return true;
      }
    }
    return false;
  }

  /* ── Walk helper ────────────────────────────────────────── */

  function walkToward(p, target) {
    const w = p.el.offsetWidth;
    const dx = target - (p.x + w / 2);
    p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 8);
    p.dir = dx > 0 ? 1 : -1;
    if (p.ft % 6 === 0) p.fi = (p.fi + 1) % FRAMES.walk.length;
    clampPlayer(p);
  }

  /* ── AI update ──────────────────────────────────────────── */

  function updateAI(p) {
    p.stateTime += TICK;
    p.ft++;
    if (tickShared(p)) return;

    if (p.state === 'alert') {
      if (p.stateTime >= 300) setState(p, 'walk');
      return;
    }

    // idle or walk: chase the ball
    if (canKick(p)) { setState(p, 'kick'); return; }

    if (p.state === 'idle' && p.stateTime > 400) setState(p, 'walk');

    if (p.state === 'walk') {
      const target = atRest() ? ball.x : ball.x + ball.vx * 10;
      const center = p.x + p.el.offsetWidth / 2;
      const dx = target - center;
      const w = p.el.offsetWidth;
      const atEdge = p.x <= leftBound || p.x >= rightBound - w;

      if (Math.abs(dx) < 8 || (atEdge && Math.abs(dx) < w)) {
        setState(p, 'idle');
      } else {
        walkToward(p, target);
      }
    }
  }

  /* ── Player (mouse) update ──────────────────────────────── */

  function updateHuman(p) {
    p.stateTime += TICK;
    p.ft++;
    if (tickShared(p)) return;
    if (canKick(p)) { setState(p, 'kick'); return; }

    const center = p.x + p.el.offsetWidth / 2;
    const dx = targetX - center;

    if (Math.abs(dx) > 5) {
      if (p.state !== 'walk') setState(p, 'walk');
      walkToward(p, targetX);
    } else {
      if (p.state !== 'idle') setState(p, 'idle');
    }
  }

  /* ── Push mechanic ──────────────────────────────────────── */

  function tryPush(a, b, now) {
    if (now - a.lastPush < PUSH_COOLDOWN) return;
    if (a.state === 'push' || a.state === 'kick' || a.state === 'jump') return;
    const ca = a.x + a.el.offsetWidth / 2;
    const cb = b.x + b.el.offsetWidth / 2;
    if (Math.abs(ca - cb) > 30) return;
    if (Math.random() > 0.03) return;

    a.lastPush = now;
    a.dir = ca < cb ? 1 : -1;
    setState(a, 'push');
    b.pushVx = a.dir * (PUSH_MIN + Math.random() * (PUSH_MAX - PUSH_MIN));
  }

  function applyPush(p) {
    if (Math.abs(p.pushVx) < 0.5) { p.pushVx = 0; return; }
    p.x += p.pushVx * 0.12;
    p.pushVx *= 0.88;
    clampPlayer(p);
  }

  /* ── Ball physics ───────────────────────────────────────── */

  function updateBall() {
    if (paused) return;
    if (ball.vy === 0 && ball.y <= 0 && Math.abs(ball.vx) < 0.01) return;

    ball.vy -= GRAVITY;
    ball.y += ball.vy;
    ball.x += ball.vx;
    ball.vx *= ball.y > 0 ? AIR_FRICTION : GROUND_FRICTION;

    // floor
    if (ball.y <= 0) {
      ball.y = 0;
      ball.vy = Math.abs(ball.vy) < 1.5 ? 0 : Math.abs(ball.vy) * BOUNCE;
    }
    // ceiling
    const ceiling = stage.offsetHeight - 10;
    if (ball.y > ceiling) { ball.y = ceiling; ball.vy = -Math.abs(ball.vy) * BOUNCE; }

    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;

    checkFrameCollision();
    if (!paused && graceFrames <= 0) checkGoalLine();

    // safety: ball far off screen
    const sw = stage.offsetWidth;
    if (!paused && (ball.x < -50 || ball.x > sw + 50)) {
      scoreGoal(ball.x < 0 ? 'left' : 'right');
    }
  }

  /* ── Goal frame collision (per-character hitboxes) ──────── */

  // [row, col, char] — row 0 = top of ASCII art, row 5 = bottom
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

  // Goal-line cells (scoring boundary — diagonal along the front opening)
  const SCORELINE_L = [[3, 8], [4, 7], [5, 6]];
  const SCORELINE_R = [[3, 0], [4, 1], [5, 2]];

  function cellRect(goalEl, row, col) {
    const x = goalEl.offsetLeft + col * charW;
    const y = (5 - row) * lineH;
    return { x, y, w: charW, h: lineH };
  }

  function ballHits(r) {
    const br = 4;
    return ball.x + br > r.x && ball.x - br < r.x + r.w &&
           ball.y + br > r.y && ball.y - br < r.y + r.h;
  }

  function checkFrameCollision() {
    if (!charW) measure();

    for (const [row, col, ch] of HITBOX_L) {
      const r = cellRect(goalL, row, col);
      if (!ballHits(r)) continue;
      if (ch === '|') {
        if (Math.random() < POST_BOUNCE_CHANCE) {
          ball.x = r.x + r.w + 2;
          ball.vx = Math.abs(ball.vx) * 0.7;
        }
      } else {
        ball.x = r.x + r.w + 2;
        ball.vx = Math.abs(ball.vx) * 0.8;
        if (ch === '/' || ch === '\\') ball.vy += (Math.random() - 0.5) * 3;
      }
      return;
    }

    for (const [row, col, ch] of HITBOX_R) {
      const r = cellRect(goalR, row, col);
      if (!ballHits(r)) continue;
      if (ch === '|') {
        if (Math.random() < POST_BOUNCE_CHANCE) {
          ball.x = r.x - 2;
          ball.vx = -Math.abs(ball.vx) * 0.7;
        }
      } else {
        ball.x = r.x - 2;
        ball.vx = -Math.abs(ball.vx) * 0.8;
        if (ch === '/' || ch === '\\') ball.vy += (Math.random() - 0.5) * 3;
      }
      return;
    }
  }

  function checkGoalLine() {
    if (!charW) measure();
    const offset = 3;

    const llx = goalLineL.offsetLeft;
    for (const [row, col] of SCORELINE_L) {
      const cx = llx + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x < cx - offset && ball.y >= cy && ball.y <= cy + lineH) {
        scoreGoal('left');
        return;
      }
    }

    const rlx = goalLineR.offsetLeft;
    for (const [row, col] of SCORELINE_R) {
      const cx = rlx + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x > cx + charW + offset && ball.y >= cy && ball.y <= cy + lineH) {
        scoreGoal('right');
        return;
      }
    }
  }

  /* ── Scoring ────────────────────────────────────────────── */

  const WIN_SCORE = 3;

  function scoreGoal(side) {
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
      const winner = scoreL >= WIN_SCORE ? p1.name : p2.name;
      scoreboardEl.textContent = 'Winner: ' + winner;
    }
  }

  function resetMatch() {
    const newL = pickName();
    const newR = pickName(newL);
    p1.name = newL; p1.nameEl.textContent = newL;
    p2.name = newR; p2.nameEl.textContent = newR;
    scoreL = 0; scoreR = 0;
    p1.x = startingX(p1);
    p2.x = startingX(p2);
    p1.dir = 1; p2.dir = -1;
    setState(p1, 'idle'); setState(p2, 'idle');
    p1.jumpY = 0; p2.jumpY = 0;
    ball.x = fieldCenter();
    ball.y = stage.offsetHeight / 2;
    ball.vx = 0; ball.vy = 0;
    paused = false;
    pausePhase = '';
    respawnDelay = 0;
    goalScorer = null;
    graceFrames = RESPAWN_GRACE;
    lastKickTime = Date.now();
    updateScoreboard();
  }

  function startingX(p) {
    const mid = fieldCenter();
    const w = p.el.offsetWidth;
    const offset = 40;
    return p === p1 ? mid - offset - w / 2 : mid + offset - w / 2;
  }

  function playersAtStart() {
    return Math.abs(p1.x - startingX(p1)) < 5 && Math.abs(p2.x - startingX(p2)) < 5;
  }

  function respawn() {
    ball.x = fieldCenter();
    ball.y = stage.offsetHeight / 2;
    ball.vx = 0;
    ball.vy = 0;
    paused = false;
    pausePhase = '';
    respawnDelay = 0;
    goalScorer = null;
    graceFrames = RESPAWN_GRACE;
    p1.jumpY = 0;
    p2.jumpY = 0;
    lastKickTime = Date.now();
  }

  /* ── Celebration particles ──────────────────────────────── */

  function celebrate(cx) {
    for (let i = 0, n = 6 + (Math.random() * 4 | 0); i < n; i++) {
      const el = document.createElement('span');
      el.textContent = Math.random() < 0.5 ? '*' : '\u2726';
      el.style.cssText = 'position:absolute;pointer-events:none;font-size:0.8rem;color:rgba(255,255,255,0.5)';
      el.style.left = cx + 'px';
      el.style.bottom = '30px';
      stage.appendChild(el);

      const pvx = (Math.random() - 0.5) * 6;
      const pvy = -(2 + Math.random() * 4);
      let sx = 0, sy = 0, op = 1, f = 0;
      (function tick() {
        f++; sx += pvx; sy += pvy + f * 0.15; op -= 0.02;
        el.style.transform = `translate(${sx}px,${sy}px)`;
        el.style.opacity = Math.max(0, op);
        if (op > 0 && f < 50) requestAnimationFrame(tick); else el.remove();
      })();
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  function render() {
    const c1 = p1.x + p1.el.offsetWidth / 2;
    const c2 = p2.x + p2.el.offsetWidth / 2;
    const hideNames = Math.abs(c1 - c2) < 35;

    [p1, p2].forEach(p => {
      p.el.textContent = getFrame(p);
      const w = p.el.offsetWidth;
      const yOff = p.jumpY || 0;
      p.el.style.transform = p.dir === 1
        ? `translate(${p.x}px,${-yOff}px)`
        : `translate(${p.x + w}px,${-yOff}px) scaleX(-1)`;

      const nw = p.nameEl.offsetWidth;
      p.nameEl.style.transform = `translate(${p.x + w / 2 - nw / 2}px,${-yOff}px)`;
      p.nameEl.style.opacity = hideNames ? '0' : '1';
    });

    ballEl.style.transform = `translate(${ball.x}px,${-ball.y}px)`;
  }

  /* ── Main loop ──────────────────────────────────────────── */

  function update() {
    calcBounds();

    if (paused) {
      if (pausePhase === 'matchend') {
        pauseTimer -= TICK;
        // winner celebrates continuously
        if (goalScorer) {
          goalScorer.stateTime += TICK;
          goalScorer.jumpY = Math.sin((goalScorer.stateTime % 400) / 400 * Math.PI) * 18;
          goalScorer.state = 'jump';
        }
        if (pauseTimer <= 0) resetMatch();
        return;
      }

      if (pausePhase === 'celebrate') {
        pauseTimer -= TICK;
        [p1, p2].forEach(p => {
          if (p.state === 'jump') {
            p.stateTime += TICK;
            p.jumpY = Math.sin((p.stateTime % 400) / 400 * Math.PI) * 18;
          }
        });
        if (pauseTimer <= 0) {
          pausePhase = 'reposition';
          p1.jumpY = 0;
          p2.jumpY = 0;
          setState(p1, 'walk');
          setState(p2, 'walk');
        }
      } else if (pausePhase === 'reposition') {
        // walk both players to starting positions
        [p1, p2].forEach(p => {
          p.stateTime += TICK;
          p.ft++;
          const target = startingX(p);
          const dx = target - p.x;
          if (Math.abs(dx) > 5) {
            p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.1, 6);
            p.dir = dx > 0 ? 1 : -1;
            if (p.ft % 6 === 0) p.fi = (p.fi + 1) % FRAMES.walk.length;
          } else {
            p.x = target;
            if (p.state !== 'idle') setState(p, 'idle');
          }
        });
        if (playersAtStart()) {
          if (respawnDelay <= 0) {
            respawnDelay = RESPAWN_DELAY_MS;
            pausePhase = 'waiting';
          }
        }
      } else if (pausePhase === 'waiting') {
        respawnDelay -= TICK;
        if (respawnDelay <= 0) respawn();
      }
      return;
    }

    if (graceFrames > 0) graceFrames--;

    if (mouseActive()) updateHuman(p1); else updateAI(p1);
    updateAI(p2);

    const now = Date.now();
    tryPush(p1, p2, now);
    tryPush(p2, p1, now);
    applyPush(p1);
    applyPush(p2);

    if (now - lastKickTime > STALL_MS) {
      lastKickTime = now;
      ball.x = stage.offsetWidth / 2;
      ball.y = stage.offsetHeight / 2;
      ball.vx = 0;
      ball.vy = 0;
      graceFrames = RESPAWN_GRACE;
    }
  }

  let last = 0;
  (function loop(now) {
    if (now - last >= TICK) { last = now; update(); updateBall(); render(); }
    requestAnimationFrame(loop);
  })(0);

})();
