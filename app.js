async function checkService(card) {
  const dot = card.querySelector('.dot');
  const label = card.querySelector('.status-label');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(card.dataset.check, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (res.status >= 500) throw new Error(res.status);
    dot.className = 'dot up';
    label.textContent = 'online';
  } catch {
    clearTimeout(timeout);
    dot.className = 'dot down';
    label.textContent = 'offline';
  }
}

async function run() {
  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((card, i) => card.style.setProperty('--i', i));
  await Promise.all(cards.filter(c => c.dataset.check).map(checkService));
  document.getElementById('last-checked').textContent = new Date().toLocaleTimeString();
}

run();
setInterval(run, 30000);

// Stickman
(function () {
  /* --- frames (5 chars wide × 4 lines, padded for jitter-free swap) --- */
  const F = {
    idle:  "  o  \n /|\\ \n  |  \n / \\ ",
    walk: [
      "  o  \n /|> \n  |  \n /   ",
      "  o  \n -|- \n  |  \n  |  ",
      "  o  \n <|\\ \n  |  \n   \\ ",
      "  o  \n -|- \n  |  \n  |  ",
    ],
    alert:   " \\o/ \n  |  \n  |  \n / \\ ",
    sit:     "  o  \n -|- \n _/  \n     ",
    sitting: [
      "  o  \n -|- \n _/  \n     ",
      "  o  \n -|- \n  \\_ \n     ",
    ],
    sleeping: [
      "  o z\n -|- \n _/  \n     ",
      "  o  \n -|-z\n  \\_ \n     ",
    ],
    kick: [
      "  o  \n /|\\ \n  |\\ \n /   ",
      "  o  \n /|\\ \n  |  \n  |\\_",
      "  o  \n  |/ \n  |  \n / \\ ",
    ],
  };

  /* --- config --- */
  const TICK = 100;
  const SPEED = 2.5;
  const GRAV = 0.3;
  const BOUNCE = 0.6;
  const FRIC = 0.99;

  /* --- DOM --- */
  const stage = document.createElement('div');
  stage.id = 'stickman-stage';
  document.body.appendChild(stage);

  const man = document.createElement('pre');
  man.setAttribute('aria-hidden', 'true');
  man.textContent = F.idle;
  stage.appendChild(man);

  const ballEl = document.createElement('pre');
  ballEl.setAttribute('aria-hidden', 'true');
  ballEl.textContent = 'o';
  ballEl.className = 'stickman-ball';
  stage.appendChild(ballEl);

  /* --- state --- */
  let x = 0, dir = 1;
  let state = 'idle', stateTime = 0;
  let fi = 0, ft = 0;
  let targetX = 0, lastInput = 0, noInputTime = 0;
  let ball = { x: 80, y: 0, vx: 0, vy: 0 };

  /* --- input --- */
  function onInput(clientX) {
    targetX = clientX - stage.getBoundingClientRect().left;
    lastInput = Date.now();
    noInputTime = 0;
    if (state === 'sitting' || state === 'sleeping' || state === 'sit' || state === 'idle') {
      setState('alert');
    }
  }
  document.addEventListener('mousemove', e => onInput(e.clientX));
  document.addEventListener('touchmove', e => onInput(e.touches[0].clientX), { passive: true });

  /* --- helpers --- */
  function setState(s) { state = s; stateTime = 0; fi = 0; ft = 0; }
  function isMouseActive() { return Date.now() - lastInput < 2000; }
  function ballAtRest() { return ball.y === 0 && ball.vy === 0 && Math.abs(ball.vx) < 0.5; }

  function kickBall() {
    ball.vx = dir * (3 + Math.random() * 3);
    ball.vy = 6 + Math.random() * 2;
  }

  /* --- frame selection --- */
  function frame() {
    switch (state) {
      case 'idle':     return F.idle;
      case 'alert':    return F.alert;
      case 'walk':     return F.walk[fi % F.walk.length];
      case 'kick':     return F.kick[Math.min(fi, F.kick.length - 1)];
      case 'sit':      return F.sit;
      case 'sitting':  return F.sitting[fi % F.sitting.length];
      case 'sleeping': return F.sleeping[fi % F.sleeping.length];
      default:         return F.idle;
    }
  }

  /* --- state machine --- */
  function update() {
    stateTime += TICK;
    ft++;
    if (!isMouseActive()) noInputTime += TICK;
    else noInputTime = 0;

    const sw = stage.offsetWidth;
    const w = man.offsetWidth;

    switch (state) {
      case 'alert':
        if (stateTime >= 400) setState('walk');
        break;

      case 'walk': {
        const tgt = isMouseActive() ? targetX : ball.x;
        const dx = tgt - (x + w / 2);

        if (Math.abs(dx) < 10) {
          if (isMouseActive()) setState('idle');
          else setState('kick');
        } else {
          x += Math.sign(dx) * SPEED;
          dir = dx > 0 ? 1 : -1;
          if (ft % 5 === 0) fi = (fi + 1) % F.walk.length;
        }
        x = Math.max(0, Math.min(sw - w, x));
        break;
      }

      case 'kick':
        if (ft % 3 === 0 && ft > 0) {
          fi++;
          if (fi === 1) kickBall();
          if (fi >= F.kick.length) setState('idle');
        }
        break;

      case 'idle':
        if (noInputTime > 30000) {
          setState('sit');
        } else if (!isMouseActive() && stateTime > 2500 && ballAtRest()) {
          setState('walk');
        }
        break;

      case 'sit':
        if (stateTime >= 600) setState('sitting');
        break;

      case 'sitting':
        if (ft % 20 === 0) fi = (fi + 1) % F.sitting.length;
        if (stateTime > 15000) setState('sleeping');
        break;

      case 'sleeping':
        if (ft % 20 === 0) fi = (fi + 1) % F.sleeping.length;
        break;
    }
  }

  /* --- ball physics --- */
  function updateBall() {
    if (ball.vy !== 0 || ball.y > 0) {
      ball.vy -= GRAV;
      ball.y += ball.vy;
      ball.x += ball.vx;
      ball.vx *= FRIC;

      if (ball.y <= 0) {
        ball.y = 0;
        if (Math.abs(ball.vy) < 1.5) {
          ball.vy = 0;
          ball.vx *= 0.8;
          if (Math.abs(ball.vx) < 0.3) ball.vx = 0;
        } else {
          ball.vy = Math.abs(ball.vy) * BOUNCE;
        }
      }

      const sw = stage.offsetWidth;
      if (ball.x < 5) { ball.x = 5; ball.vx = Math.abs(ball.vx) * 0.5; }
      if (ball.x > sw - 15) { ball.x = sw - 15; ball.vx = -Math.abs(ball.vx) * 0.5; }
    }
  }

  /* --- render --- */
  function render() {
    man.textContent = frame();
    const w = man.offsetWidth;
    man.style.transform = dir === 1
      ? `translateX(${x}px)`
      : `translateX(${x + w}px) scaleX(-1)`;
    ballEl.style.transform = `translate(${ball.x}px, ${-ball.y}px)`;
  }

  /* --- loop (requestAnimationFrame, throttled to 10 FPS) --- */
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
