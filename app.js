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
