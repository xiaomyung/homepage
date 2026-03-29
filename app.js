async function checkService(card) {
  const dot = card.querySelector('.dot');
  const label = card.querySelector('.status-label');
  try {
    const res = await fetch(card.dataset.check, { cache: 'no-store' });
    if (res.status >= 500) throw new Error(res.status);
    dot.className = 'dot up';
    label.textContent = 'online';
  } catch {
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

// Stickman
(function () {
  //  walk frames (facing right; scaleX(-1) handles left)
  //   o     o     o     o
  //  /|>   -|-   <|\   -|-
  //  /       |    \      |
  const frames = [
    " o\n/|>\n/  ",
    " o\n-|-\n |",
    " o\n<|\\\n  \\",
    " o\n-|-\n |",
  ];
  const idle = " o\n-|-\n/\\";

  const stage = document.createElement('div');
  stage.id = 'stickman-stage';
  document.body.appendChild(stage);

  const el = document.createElement('pre');
  el.setAttribute('aria-hidden', 'true');
  el.textContent = idle;
  stage.appendChild(el);

  let x = 0;
  let targetX = 0;
  let dir = 1;
  let fi = 0;
  let tick = 0;

  const getTarget = clientX => clientX - stage.getBoundingClientRect().left;
  document.addEventListener('mousemove', e => { targetX = getTarget(e.clientX); });
  document.addEventListener('touchmove', e => { targetX = getTarget(e.touches[0].clientX); }, { passive: true });

  function step() {
    const w   = el.offsetWidth;
    const sw  = stage.offsetWidth;
    const dx  = targetX - (x + w / 2);
    const moving = Math.abs(dx) > 5;

    if (moving) {
      x  += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 4);
      dir = dx > 0 ? 1 : -1;
    }

    x = Math.max(0, Math.min(sw - w, x));

    if (moving) {
      if (++tick % 12 === 0) fi = (fi + 1) % frames.length;
      el.textContent = frames[fi];
    } else {
      fi = 0; tick = 0;
      el.textContent = idle;
    }

    el.style.transform = dir === 1
      ? `translateX(${x}px)`
      : `translateX(${x + w}px) scaleX(-1)`;

    requestAnimationFrame(step);
  }

  step();
})();
