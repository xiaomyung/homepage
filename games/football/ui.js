/**
 * Football v2 — UI wiring.
 *
 * Binds the DOM elements authored in index.html to the game loop.
 * Covers:
 *   - Scoreboard (tags, names, score, timer)
 *   - Start/Stop button
 *   - Options button + panel toggle (panel contents wired in ui_options.js
 *     in phase 4d2/4d3)
 *   - Auto-pause via visibilitychange + pagehide + pageshow
 *
 * Design: pure functions + small handle objects. No single god-class.
 * main.js composes the pieces and holds the top-level state.
 */

/* ── Scoreboard ─────────────────────────────────────────── */

export function createScoreboard() {
  const el = {
    p1Tag: document.getElementById('game-p1-tag'),
    p1Name: document.getElementById('game-p1-name'),
    p2Tag: document.getElementById('game-p2-tag'),
    p2Name: document.getElementById('game-p2-name'),
    score: document.getElementById('game-score'),
    timer: document.getElementById('game-timer'),
  };

  return {
    setMatchup(p1, p2Source) {
      el.p1Tag.textContent = '[nn]';
      el.p1Name.textContent = (p1?.name ?? '—').toLowerCase();
      if (p2Source && p2Source.type === 'fallback') {
        el.p2Tag.textContent = '[fb]';
        el.p2Name.textContent = 'fallback';
      } else {
        el.p2Tag.textContent = '[nn]';
        el.p2Name.textContent = (p2Source?.name ?? '—').toLowerCase();
      }
    },
    setScore(scoreL, scoreR) {
      el.score.textContent = `${scoreL} — ${scoreR}`;
    },
    setTimer(seconds) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      el.timer.textContent =
        `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    },
  };
}

/* ── Start/Stop button ──────────────────────────────────── */

export function createStartStopButton({ onStart, onStop }) {
  const btn = document.getElementById('game-start-btn');
  let running = false;

  const render = () => {
    btn.textContent = running ? '[ stop ]' : '[ start ]';
    btn.dataset.running = running ? 'true' : 'false';
  };

  btn.addEventListener('click', () => {
    if (running) {
      running = false;
      render();
      onStop?.();
    } else {
      running = true;
      render();
      onStart?.();
    }
  });

  render();

  return {
    setRunning(next) {
      if (next === running) return;
      running = next;
      render();
    },
    isRunning() {
      return running;
    },
  };
}

/* ── Options button (panel toggle) ──────────────────────── */

export function createOptionsToggle() {
  const btn = document.getElementById('game-options-btn');
  const panel = document.getElementById('game-options-panel');
  let open = false;

  const render = () => {
    btn.textContent = open ? '[ close ]' : '[ options ]';
    panel.dataset.open = open ? 'true' : 'false';
  };

  btn.addEventListener('click', () => {
    open = !open;
    render();
  });

  render();

  return {
    isOpen: () => open,
    setOpen(next) {
      if (next === open) return;
      open = next;
      render();
    },
  };
}

/* ── Auto-pause gate ────────────────────────────────────── */

/**
 * Installs visibility listeners. Calls `onAway` when the tab becomes
 * hidden or navigates away (including bfcache pagehide). NEVER calls
 * anything on return — the user must explicitly click Start to resume.
 *
 * Returns an `uninstall` function for tests.
 */
export function installAutoPause(onAway) {
  const handler = () => {
    if (document.hidden) onAway?.();
  };
  const pageHideHandler = () => onAway?.();

  document.addEventListener('visibilitychange', handler);
  window.addEventListener('pagehide', pageHideHandler);
  // pageshow is deliberately NOT wired to resume — resume is always manual.

  return () => {
    document.removeEventListener('visibilitychange', handler);
    window.removeEventListener('pagehide', pageHideHandler);
  };
}
