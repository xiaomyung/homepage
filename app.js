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

/* ── Cap grids at 2.2 visible cards ── */

function capGrids() {
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-gap')) || 8;
  document.querySelectorAll('.grid').forEach(grid => {
    const cards = grid.querySelectorAll('.card');
    if (cards.length < 3) { grid.style.maxHeight = ''; return; }
    const cardH = cards[0].offsetHeight;
    grid.style.maxHeight = `${cardH * 2.2 + gap * 2}px`;
  });
}

capGrids();
window.addEventListener('resize', capGrids);
