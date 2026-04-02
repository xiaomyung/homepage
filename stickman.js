// Stickman — cursor-chasing character with ball physics and idle behaviors
(function () {
  /* --- frames (7 chars wide × 4 lines) --- */
  /* ◤█◥ = solid inverted triangle torso, █ = waist */
  const F = {
    idle:  "   \u25CB   \n \u256D\u25E4\u2588\u25E5\u256E \n   \u2588   \n  \u2571 \u2572  ",
    walk: [
      "   \u25CB   \n\u256D \u25E4\u2588\u25E5\u2500 \n   \u2588   \n  \u2571 \u2572  ",
      "   \u25CB   \n \u2500\u25E4\u2588\u25E5 \u256E\n   \u2588   \n   \u2502   ",
      "   \u25CB   \n \u256D\u25E4\u2588\u25E5 \u2500\n   \u2588   \n  \u2571 \u2572  ",
      "   \u25CB   \n\u2500 \u25E4\u2588\u25E5\u256E \n   \u2588   \n   \u2502   ",
    ],
    alert:   "   \u25CB   \n \u2572\u25E4\u2588\u25E5\u2571 \n   \u2588   \n  \u2571 \u2572  ",
    kick: [
      "   \u25CB   \n \u256D\u25E4\u2588\u25E5\u256E \n   \u2588   \n   \u2502\u2572  ",
      "   \u25CB   \n \u256D\u25E4\u2588\u25E5\u256E \n   \u2588   \n   \u2502\u2571  ",
      "   \u25CB   \n \u256D\u25E4\u2588\u25E5\u256E \n   \u2588   \n   \u2502\u2500  ",
    ],
  };

  /* --- config --- */
  const TICK = 16;
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
    if (state === 'idle') {
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
    const power = 0.3 + Math.random() * 0.7;
    const angle = 0.3 + Math.random() * 0.7;
    const force = 5 + power * 8;
    const kickDir = Math.random() < 0.8 ? dir : -dir;
    ball.vx = kickDir * force * (1 - angle);
    ball.vy = force * angle;
  }

  /* --- frame selection --- */
  function frame() {
    switch (state) {
      case 'idle':     return F.idle;
      case 'alert':    return F.alert;
      case 'walk':     return F.walk[fi % F.walk.length];
      case 'kick':     return F.kick[Math.min(fi, F.kick.length - 1)];
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
        const tgt = isMouseActive() ? targetX : (ballAtRest() ? ball.x : targetX);
        const dx = tgt - (x + w / 2);

        if (Math.abs(dx) < 8) {
          if (isMouseActive()) {
            setState('idle');
          } else if (ballAtRest() && Math.abs(ball.x - (x + w / 2)) < 15) {
            setState('kick');
          } else {
            setState('idle');
          }
        } else {
          x += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 8);
          dir = dx > 0 ? 1 : -1;
          if (ft % 6 === 0) fi = (fi + 1) % F.walk.length;
        }
        x = Math.max(0, Math.min(sw - w, x));
        break;
      }

      case 'kick':
        if (ft % 6 === 0 && ft > 0) {
          fi++;
          if (fi === 1) kickBall();
          if (fi >= F.kick.length) setState('idle');
        }
        break;

      case 'idle':
        if (!isMouseActive() && stateTime > 400) {
          if (ballAtRest()) {
            setState('walk');
          } else {
            const rx = Math.random() * (sw - w);
            targetX = rx + w / 2;
            setState('walk');
          }
        }
        break;
    }
  }

  /* --- ball physics --- */
  function updateBall() {
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

    if (ball.y <= 0) {
      ball.y = 0;
      if (Math.abs(ball.vy) < 1.5) {
        ball.vy = 0;
      } else {
        ball.vy = Math.abs(ball.vy) * BOUNCE;
      }
    }

    const sh = stage.offsetHeight - 10;
    if (ball.y > sh) {
      ball.y = sh;
      ball.vy = -Math.abs(ball.vy) * BOUNCE;
    }

    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;

    const sw = stage.offsetWidth;
    if (ball.x < 5) { ball.x = 5; ball.vx = Math.abs(ball.vx) * 0.5; }
    if (ball.x > sw - 15) { ball.x = sw - 15; ball.vx = -Math.abs(ball.vx) * 0.5; }
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

  /* --- loop (requestAnimationFrame, throttled to ~60 FPS) --- */
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
