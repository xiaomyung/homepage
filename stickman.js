// Stickman Football — two stickmen compete for the ball
(function () {
  /* --- frames (original 3-line ASCII) --- */
  const F = {
    idle:  " o \n(|)\n/\\ ",
    walk: [
      " o \n/| \n/ \\",
      " o \n |)\n | ",
      " o \n |\\\n/ \\",
      " o \n(| \n | ",
    ],
    alert: "\\o/\n | \n/\\ ",
    kick: [
      " o \n(|)\n |\\ ",
      " o \n(|)\n |/ ",
      " o \n(|)\n |_ ",
    ],
    push: " o \n/|--\n/\\ ",
  };

  /* --- config --- */
  const TICK = 16;
  const GRAV = 0.3;
  const BOUNCE_DAMP = 0.6;
  const FRIC = 0.99;
  const PAUSE_MS = 2000;
  const MIN_DIST = 25; // minimum px between player centers

  /* --- names --- */
  const NAMES = [
    'Messi','Ronaldo','Neymar','Mbappé','Haaland','Salah','De Bruyne',
    'Modric','Benzema','Lewandowski','Vinícius','Bellingham','Pedri',
    'Gavi','Saka','Foden','Kane','Son','Mané','Díaz','Griezmann',
    'Müller','Kimmich','Hakimi','Palmer','Yamal','Rodri','Doku',
  ];
  function pickName(exclude) {
    let n;
    do { n = NAMES[Math.floor(Math.random() * NAMES.length)]; } while (n === exclude);
    return n;
  }

  /* --- DOM --- */
  const stage = document.createElement('div');
  stage.id = 'stickman-stage';
  document.body.appendChild(stage);

  /* ball */
  const ballEl = document.createElement('pre');
  ballEl.setAttribute('aria-hidden', 'true');
  ballEl.textContent = 'o';
  ballEl.className = 'stickman-ball';
  stage.appendChild(ballEl);

  /* goals */
  const goalL = document.createElement('pre');
  goalL.setAttribute('aria-hidden', 'true');
  goalL.textContent = '     _ _ \n    /  /|\n   /__/_|\n  /__/   \n /   |   \n/____|  ';
  goalL.className = 'stickman-goal stickman-goal-l';
  stage.appendChild(goalL);

  const goalR = document.createElement('pre');
  goalR.setAttribute('aria-hidden', 'true');
  goalR.textContent = ' _ _    \n|\\  \\   \n|_\\__\\  \n   \\__\\ \n   |   \\\n   |____\\';
  goalR.className = 'stickman-goal stickman-goal-r';
  stage.appendChild(goalR);

  /* goal lines (diagonal scoring boundary) */
  const goalLineL = document.createElement('pre');
  goalLineL.setAttribute('aria-hidden', 'true');
  goalLineL.textContent = '         \n         \n         \n        /\n       / \n      /  ';
  goalLineL.className = 'stickman-goalline stickman-goalline-l';
  stage.appendChild(goalLineL);

  const goalLineR = document.createElement('pre');
  goalLineR.setAttribute('aria-hidden', 'true');
  goalLineR.textContent = '         \n         \n         \n\\        \n \\       \n  \\      ';
  goalLineR.className = 'stickman-goalline stickman-goalline-r';
  stage.appendChild(goalLineR);

  /* scoreboard */
  const scoreboard = document.createElement('pre');
  scoreboard.className = 'stickman-scoreboard';
  stage.appendChild(scoreboard);

  function updateScoreboard() {
    const n1 = p1 ? p1.name : '';
    const n2 = p2 ? p2.name : '';
    scoreboard.textContent = n1 + ' ' + scoreL + ' \u2502 ' + scoreR + ' ' + n2;
  }

  /* --- player factory --- */
  function createPlayer(startRight, name) {
    const el = document.createElement('pre');
    el.setAttribute('aria-hidden', 'true');
    el.className = 'stickman-player';
    el.textContent = F.idle;
    stage.appendChild(el);
    const nameEl = document.createElement('span');
    nameEl.className = 'stickman-name';
    nameEl.textContent = name;
    stage.appendChild(nameEl);
    return {
      el,
      nameEl,
      name,
      x: 0,
      dir: startRight ? -1 : 1,
      state: 'idle',
      stateTime: 0,
      fi: 0,
      ft: 0,
      jumpY: 0,
      jumpCount: 0,
      goalDir: startRight ? -1 : 1,
      lastPush: 0,
      pushVx: 0,
    };
  }

  const name1 = pickName();
  const name2 = pickName(name1);
  const p1 = createPlayer(false, name1);
  const p2 = createPlayer(true, name2);

  /* --- game state --- */
  let ball = { x: 0, y: 0, vx: 0, vy: 0 };
  let targetX = 0, lastInput = 0;
  let scoreL = 0, scoreR = 0;
  let lastKicker = null; // p1 or p2
  let paused = false, pauseTimer = 0, pauseReason = ''; // 'goal' or 'out'
  let goalScorer = null; // who scored (for celebration)
  let lastKickTime = Date.now();
  updateScoreboard();

  /* --- bounds (calculated after DOM ready) --- */
  let leftBound = 0, rightBound = 0;
  function calcBounds() {
    leftBound = goalL.offsetLeft;
    rightBound = goalR.offsetLeft + goalR.offsetWidth;
  }

  /* --- init positions --- */
  function initPositions() {
    calcBounds();
    const mid = (leftBound + rightBound) / 2;
    const w = p1.el.offsetWidth;
    p1.x = mid - w - 20;
    p2.x = mid + 20;
    ball.x = stage.offsetWidth / 2;
    ball.y = stage.offsetHeight;
    ball.vx = 0;
    ball.vy = 0;
  }
  // defer to next frame so DOM has laid out
  requestAnimationFrame(() => { initPositions(); });

  /* --- input --- */
  function onInput(clientX) {
    targetX = clientX - stage.getBoundingClientRect().left;
    lastInput = Date.now();
  }
  document.addEventListener('mousemove', e => onInput(e.clientX));
  document.addEventListener('touchmove', e => onInput(e.touches[0].clientX), { passive: true });

  function isMouseActive() { return Date.now() - lastInput < 2000; }
  function ballAtRest() { return ball.y === 0 && ball.vy === 0 && Math.abs(ball.vx) < 0.5; }

  /* --- frame selection --- */
  function getFrame(p) {
    switch (p.state) {
      case 'idle':     return F.idle;
      case 'alert':    return F.alert;
      case 'walk':     return F.walk[p.fi % F.walk.length];
      case 'kick':     return F.kick[Math.min(p.fi, F.kick.length - 1)];
      case 'jump':     return F.alert;
      case 'push':     return F.push;
      default:         return F.idle;
    }
  }

  /* --- kick ball --- */
  function kickBall(p) {
    const power = 0.3 + Math.random() * 0.7;
    const angle = 0.2 + Math.random() * 0.6;
    const force = 8 + power * 14;
    const sw = stage.offsetWidth;
    const mid = sw / 2;
    const playerMid = p.x + p.el.offsetWidth / 2;
    // kick away from own goal, 20% chance to kick toward own goal
    let kickDir = playerMid < mid ? 1 : -1;
    if (Math.random() < 0.2) kickDir = -kickDir;
    ball.vx = kickDir * force * (1 - angle);
    ball.vy = force * angle;
    lastKicker = p;
    lastKickTime = Date.now();
  }

  /* --- set state helper --- */
  function setState(p, s) { p.state = s; p.stateTime = 0; p.fi = 0; p.ft = 0; }

  /* --- AI update for a player --- */
  function updateAI(p) {
    p.stateTime += TICK;
    p.ft++;
    const w = p.el.offsetWidth;
    const center = p.x + w / 2;

    switch (p.state) {
      case 'alert':
        if (p.stateTime >= 300) setState(p, 'walk');
        break;

      case 'walk': {
        const tgt = ballAtRest() ? ball.x : ball.x + ball.vx * 10;
        const dx = tgt - center;
        const atEdge = p.x <= leftBound || p.x >= rightBound - w;
        const closeEnough = Math.abs(dx) < 8 || (atEdge && Math.abs(dx) < w);

        if (closeEnough) {
          if (ballAtRest() && Math.abs(ball.x - center) < w * 1.8) {
            setState(p, 'kick');
          } else {
            setState(p, 'idle');
          }
        } else {
          p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 8);
          p.dir = dx > 0 ? 1 : -1;
          if (p.ft % 6 === 0) p.fi = (p.fi + 1) % F.walk.length;
        }
        p.x = Math.max(leftBound, Math.min(rightBound - w, p.x));
        break;
      }

      case 'kick':
        if (p.ft % 6 === 0 && p.ft > 0) {
          p.fi++;
          if (p.fi === 1) kickBall(p);
          if (p.fi >= F.kick.length) setState(p, 'idle');
        }
        break;

      case 'idle':
        if (p.stateTime > 400) {
          if (ballAtRest()) {
            setState(p, 'walk');
          } else {
            setState(p, 'walk');
          }
        }
        break;

      case 'push':
        if (p.stateTime >= PUSH_ANIM_MS) setState(p, 'idle');
        break;

      case 'jump':
        p.stateTime += 0; // already incremented
        const jumpPhase = (p.stateTime % 400) / 400;
        p.jumpY = Math.sin(jumpPhase * Math.PI) * 18;
        if (p.stateTime > PAUSE_MS) {
          p.jumpY = 0;
          setState(p, 'idle');
        }
        break;
    }
  }

  /* --- player-controlled update --- */
  function updatePlayer(p) {
    p.stateTime += TICK;
    p.ft++;
    const w = p.el.offsetWidth;
    const center = p.x + w / 2;
    const dx = targetX - center;

    // always check for kick proximity
    if (p.state !== 'kick' && ballAtRest() && Math.abs(ball.x - center) < w * 1.8) {
      setState(p, 'kick');
    }

    switch (p.state) {
      case 'alert':
        if (p.stateTime >= 300) setState(p, 'walk');
        break;

      case 'walk':
      case 'idle': {
        if (Math.abs(dx) > 5) {
          p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 8);
          p.dir = dx > 0 ? 1 : -1;
          if (p.state !== 'walk') setState(p, 'walk');
          if (p.ft % 6 === 0) p.fi = (p.fi + 1) % F.walk.length;
        } else {
          if (p.state !== 'idle') setState(p, 'idle');
        }
        p.x = Math.max(leftBound, Math.min(rightBound - w, p.x));
        break;
      }

      case 'kick':
        if (p.ft % 6 === 0 && p.ft > 0) {
          p.fi++;
          if (p.fi === 1) kickBall(p);
          if (p.fi >= F.kick.length) setState(p, 'idle');
        }
        break;

      case 'push':
        if (p.stateTime >= PUSH_ANIM_MS) setState(p, 'idle');
        break;

      case 'jump':
        const jumpPhase = (p.stateTime % 400) / 400;
        p.jumpY = Math.sin(jumpPhase * Math.PI) * 18;
        if (p.stateTime > PAUSE_MS) {
          p.jumpY = 0;
          setState(p, 'idle');
        }
        break;
    }
  }

  /* --- defend: walk back to own goal --- */
  function updateDefend(p) {
    p.stateTime += TICK;
    p.ft++;
    const w = p.el.offsetWidth;
    const homeX = p.goalDir === 1 ? leftBound + 20 : rightBound - w - 20;
    const dx = homeX - p.x;

    if (Math.abs(dx) > 5) {
      p.x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.06, 6);
      p.dir = dx > 0 ? 1 : -1;
      if (p.state !== 'walk') setState(p, 'walk');
      if (p.ft % 6 === 0) p.fi = (p.fi + 1) % F.walk.length;
    } else {
      if (p.state !== 'idle') setState(p, 'idle');
    }
    p.x = Math.max(leftBound, Math.min(rightBound - w, p.x));
  }

  /* --- ball physics --- */
  function updateBall() {
    if (paused) return;

    const moving = ball.vy !== 0 || ball.y > 0 || Math.abs(ball.vx) > 0.01;
    if (!moving) return;

    ball.vy -= GRAV;
    ball.y += ball.vy;
    ball.x += ball.vx;

    if (ball.y > 0) {
      ball.vx *= FRIC;
    } else {
      ball.vx *= 0.92;
    }

    // floor
    if (ball.y <= 0) {
      ball.y = 0;
      if (Math.abs(ball.vy) < 1.5) {
        ball.vy = 0;
      } else {
        ball.vy = Math.abs(ball.vy) * BOUNCE_DAMP;
      }
    }

    // ceiling
    const sh = stage.offsetHeight - 10;
    if (ball.y > sh) {
      ball.y = sh;
      ball.vy = -Math.abs(ball.vy) * BOUNCE_DAMP;
    }

    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;

    // goal frame collisions (bounce off structure)
    checkGoalCollision();

    // goal line detection (ball crossed the scoring line)
    if (!paused) checkGoalLine();

    // out of bounds safety (ball went way off screen)
    const sw = stage.offsetWidth;
    if (ball.x < -50 || ball.x > sw + 50) {
      if (!paused) handleGoal(ball.x < 0 ? 'left' : 'right');
    }
  }

  /* --- goal hitboxes: per-character collision rects --- */
  // Each entry: [row, col, char] from the ASCII art
  // row 0 = top of pre element (visually highest), row 5 = bottom (ground)
  // In stage coords: y measured from bottom, so row 5 → y≈0, row 0 → y≈5*lineH
  const goalLChars = [
    [0,5,'_'],[0,7,'_'],
    [1,4,'/'],[1,7,'/'],[1,8,'|'],
    [2,3,'/'],[2,4,'_'],[2,5,'_'],[2,6,'/'],[2,7,'_'],[2,8,'|'],
    [3,2,'/'],[3,3,'_'],[3,4,'_'],[3,5,'/'],
    [4,1,'/'],[4,5,'|'],
    [5,0,'/'],[5,1,'_'],[5,2,'_'],[5,3,'_'],[5,4,'_'],[5,5,'|'],
  ];
  const goalRChars = [
    [0,1,'_'],[0,3,'_'],
    [1,0,'|'],[1,1,'\\'],[1,4,'\\'],
    [2,0,'|'],[2,1,'_'],[2,2,'\\'],[2,3,'_'],[2,4,'_'],[2,5,'\\'],
    [3,3,'\\'],[3,4,'_'],[3,5,'_'],[3,6,'\\'],
    [4,3,'|'],[4,7,'\\'],
    [5,3,'|'],[5,4,'_'],[5,5,'_'],[5,6,'_'],[5,7,'_'],[5,8,'\\'],
  ];

  let charW = 0, lineH = 0;
  function measureCharSize() {
    // measure from goalL which is already in the DOM
    const totalLines = 6;
    lineH = goalL.offsetHeight / totalLines;
    // approximate char width from element width / max line length
    charW = goalL.offsetWidth / 9; // longest line is 9 chars
  }

  function checkGoalCollision() {
    if (charW === 0) measureCharSize();

    const ballR = 4; // ball radius in px

    // check left goal
    const glx = goalL.offsetLeft;
    const gly = goalL.offsetHeight; // total height of goal element
    let hitL = false;
    for (const [row, col, ch] of goalLChars) {
      // pixel rect of this character cell
      const cx = glx + col * charW;
      const cy = (5 - row) * lineH; // y from bottom (stage coords)
      // ball.y is height from ground (bottom of stage)
      // check AABB overlap
      if (ball.x + ballR > cx && ball.x - ballR < cx + charW &&
          ball.y + ballR > cy && ball.y - ballR < cy + lineH) {
        hitL = true;
        if (ch === '|') {
          // front post: 15% bounce
          if (Math.random() < 0.15) {
            ball.x = cx + charW + 2;
            ball.vx = Math.abs(ball.vx) * 0.7;
          }
          // else passes through
        } else {
          // /, \, _ : always bounce
          ball.vx = Math.abs(ball.vx) * 0.8;
          ball.x = cx + charW + 2;
          if (ch === '/' || ch === '\\') ball.vy += (Math.random() - 0.5) * 3;
        }
        break; // one collision per frame
      }
    }

    // check right goal
    const grx = goalR.offsetLeft;
    for (const [row, col, ch] of goalRChars) {
      const cx = grx + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x + ballR > cx && ball.x - ballR < cx + charW &&
          ball.y + ballR > cy && ball.y - ballR < cy + lineH) {
        if (ch === '|') {
          if (Math.random() < 0.15) {
            ball.x = cx - 2;
            ball.vx = -Math.abs(ball.vx) * 0.7;
          }
        } else {
          ball.vx = -Math.abs(ball.vx) * 0.8;
          ball.x = cx - 2;
          if (ch === '/' || ch === '\\') ball.vy += (Math.random() - 0.5) * 3;
        }
        break;
      }
    }
  }

  /* --- goal line scoring detection --- */
  // Left goal line: / at rows 3-5, cols 6,5,4 (diagonal from goal opening)
  // Right goal line: \ at rows 3-5, cols 0,1,2
  const goalLineLCells = [[3, 8], [4, 7], [5, 6]];
  const goalLineRCells = [[3, 0], [4, 1], [5, 2]];

  function checkGoalLine() {
    if (charW === 0) measureCharSize();
    const offset = 3; // ball must be just past the line

    // Left goal line — ball must be to the LEFT of the line
    const llx = goalLineL.offsetLeft;
    for (const [row, col] of goalLineLCells) {
      const cx = llx + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x < cx - offset &&
          ball.y >= cy && ball.y <= cy + lineH) {
        handleGoal('left');
        return;
      }
    }

    // Right goal line — ball must be to the RIGHT of the line
    const rlx = goalLineR.offsetLeft;
    for (const [row, col] of goalLineRCells) {
      const cx = rlx + col * charW;
      const cy = (5 - row) * lineH;
      if (ball.x > cx + charW + offset &&
          ball.y >= cy && ball.y <= cy + lineH) {
        handleGoal('right');
        return;
      }
    }
  }

  /* --- goal scored --- */
  function handleGoal(side) {
    paused = true;
    pauseTimer = PAUSE_MS;
    pauseReason = 'goal';

    if (side === 'left') {
      // ball went in left goal — player 2 scored
      scoreR++;
      updateScoreboard();
      goalScorer = p2;
      setState(p2, 'jump');
      setState(p1, 'idle');
      celebrateGoal(goalL.offsetLeft + goalL.offsetWidth / 2);
    } else {
      // ball went in right goal — player 1 scored
      scoreL++;
      updateScoreboard();
      goalScorer = p1;
      setState(p1, 'jump');
      setState(p2, 'idle');
      celebrateGoal(goalR.offsetLeft + goalR.offsetWidth / 2);
    }
  }

  /* --- respawn ball --- */
  function respawnBall() {
    const sh = stage.offsetHeight;
    if (pauseReason === 'goal') {
      // respawn on opposite side of where ball went in
      // if scored on left goal, respawn near right goal (for team that conceded)
      // if scored on right goal, respawn near left goal
      if (goalScorer === p2) {
        // scored on left goal, respawn near left goal for p1
        ball.x = leftBound + 20;
      } else {
        ball.x = rightBound - 20;
      }
    }
    ball.y = sh / 2;
    ball.vx = 0;
    ball.vy = 0;
    paused = false;
    pauseReason = '';
    goalScorer = null;
    p1.jumpY = 0;
    p2.jumpY = 0;
  }

  /* --- star celebration --- */
  function celebrateGoal(centerX) {
    const count = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      const spark = document.createElement('span');
      spark.textContent = Math.random() < 0.5 ? '*' : '\u2726';
      spark.style.cssText = 'position:absolute;pointer-events:none;font-size:0.8rem;color:rgba(255,255,255,0.5);';
      spark.style.left = centerX + 'px';
      spark.style.bottom = '30px';
      stage.appendChild(spark);

      const vx = (Math.random() - 0.5) * 6;
      const vy = -(2 + Math.random() * 4);
      let sx = 0, sy = 0, opacity = 1, frame = 0;

      function animSpark() {
        frame++;
        sx += vx;
        sy += vy + frame * 0.15;
        opacity -= 0.02;
        spark.style.transform = `translate(${sx}px, ${sy}px)`;
        spark.style.opacity = String(Math.max(0, opacity));
        if (opacity > 0 && frame < 50) {
          requestAnimationFrame(animSpark);
        } else {
          spark.remove();
        }
      }
      requestAnimationFrame(animSpark);
    }
  }

  /* --- push mechanic --- */
  const PUSH_COOLDOWN = 3000;
  const PUSH_FORCE_MIN = 50;
  const PUSH_FORCE_MAX = 200;
  const PUSH_ANIM_MS = 300;

  function tryPush(attacker, victim, now) {
    if (now - attacker.lastPush < PUSH_COOLDOWN) return;
    if (attacker.state === 'push' || attacker.state === 'kick' || attacker.state === 'jump') return;
    const w = attacker.el.offsetWidth;
    const ca = attacker.x + w / 2;
    const cv = victim.x + victim.el.offsetWidth / 2;
    if (Math.abs(ca - cv) > MIN_DIST + 5) return;
    if (Math.random() > 0.03) return;

    attacker.lastPush = now;
    // attacker: enter push animation, face the victim
    attacker.dir = ca < cv ? 1 : -1;
    setState(attacker, 'push');
    // victim: gets shoved
    const pushDir = ca < cv ? 1 : -1;
    const force = PUSH_FORCE_MIN + Math.random() * (PUSH_FORCE_MAX - PUSH_FORCE_MIN);
    victim.pushVx = pushDir * force;
  }

  function applyPush(p) {
    if (Math.abs(p.pushVx) < 0.5) { p.pushVx = 0; return; }
    p.x += p.pushVx * 0.12;
    p.pushVx *= 0.88;
    const w = p.el.offsetWidth;
    p.x = Math.max(leftBound, Math.min(rightBound - w, p.x));
  }

  /* --- render --- */
  function render() {

    const w1 = p1.el.offsetWidth;
    const w2 = p2.el.offsetWidth;
    const c1 = p1.x + w1 / 2;
    const c2 = p2.x + w2 / 2;
    const tooClose = Math.abs(c1 - c2) < MIN_DIST + 10;

    [p1, p2].forEach(p => {
      p.el.textContent = getFrame(p);
      const w = p.el.offsetWidth;
      const yOff = p.jumpY || 0;
      if (p.dir === 1) {
        p.el.style.transform = `translate(${p.x}px, ${-yOff}px)`;
      } else {
        p.el.style.transform = `translate(${p.x + w}px, ${-yOff}px) scaleX(-1)`;
      }

      // name label: positioned above the stickman
      const nameW = p.nameEl.offsetWidth;
      const nameX = p.x + w / 2 - nameW / 2;
      p.nameEl.style.transform = `translate(${nameX}px, ${-yOff}px)`;
      p.nameEl.style.opacity = tooClose ? '0' : '1';
    });

    ballEl.style.transform = `translate(${ball.x}px, ${-ball.y}px)`;
  }

  /* --- main update --- */
  function update() {
    calcBounds();

    if (paused) {
      pauseTimer -= TICK;
      // still update jump animation during pause
      [p1, p2].forEach(p => {
        if (p.state === 'jump') {
          p.stateTime += TICK;
          const jumpPhase = (p.stateTime % 400) / 400;
          p.jumpY = Math.sin(jumpPhase * Math.PI) * 18;
        }
      });
      if (pauseTimer <= 0) respawnBall();
      return;
    }

    // player 1: mouse-controlled or AI
    if (isMouseActive()) {
      updatePlayer(p1);
    } else {
      updateAI(p1);
    }

    // player 2: always AI
    updateAI(p2);

    // push mechanic + apply push momentum
    const now = Date.now();
    tryPush(p1, p2, now);
    tryPush(p2, p1, now);
    applyPush(p1);
    applyPush(p2);

    // stall detection: no kick for 10s → respawn ball in center
    if (now - lastKickTime > 10000) {
      lastKickTime = now;
      ball.x = stage.offsetWidth / 2;
      ball.y = stage.offsetHeight / 2;
      ball.vx = 0;
      ball.vy = 0;
    }
  }

  /* --- loop --- */
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
