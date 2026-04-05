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

/* ── Section expand buttons (small screens) ── */

function syncExpandButtons() {
  const small = window.matchMedia('(max-width: 720px)').matches;
  document.querySelectorAll('.grid').forEach(grid => {
    const cards = grid.querySelectorAll('.card');
    let btn = grid.parentElement.querySelector('.grid-expand');
    if (cards.length < 3) {
      if (btn) btn.classList.remove('visible');
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'grid-expand';
      btn.addEventListener('click', () => {
        const expanding = !grid.classList.contains('expanded');
        grid.classList.toggle('expanded');
        const extra = cards.length - 2;
        btn.textContent = expanding ? '\u25b4 show less' : `\u25be ${extra} more`;
      });
      grid.after(btn);
    }
    const extra = cards.length - 2;
    if (!grid.classList.contains('expanded')) btn.textContent = `\u25be ${extra} more`;
    btn.classList.toggle('visible', small);
    if (!small) grid.classList.remove('expanded');
  });
}

syncExpandButtons();
window.addEventListener('resize', syncExpandButtons);
