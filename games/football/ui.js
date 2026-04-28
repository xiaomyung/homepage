/**
 * Football v2 — UI wiring.
 *
 * Binds the DOM elements authored in index.html to the showcase loop.
 * Covers:
 *   - Scoreboard (role dots, names, score, timer)
 *   - Options panel toggle
 *   - Free / follow camera toggles
 *
 * The training-era widgets (start/stop, stats panel, fitness graph,
 * config controls, reset button) are gone with the broker. Their DOM
 * elements still sit in index.html as layout placeholders — they have
 * no JS handlers and their stat <dd> elements show "—" by default.
 */

/* ── Scoreboard ─────────────────────────────────────────── */

export function createScoreboard() {
  const el = {
    p1Dot: document.getElementById('game-p1-dot'),
    p1Name: document.getElementById('game-p1-name'),
    p2Dot: document.getElementById('game-p2-dot'),
    p2Name: document.getElementById('game-p2-name'),
    score: document.getElementById('game-score'),
    timer: document.getElementById('game-timer'),
  };

  return {
    setMatchup(p1, p2) {
      const p1Name = (p1?.name ?? '—').toLowerCase();
      const p2Name = (p2?.name ?? '—').toLowerCase();
      el.p1Name.textContent = p1Name;
      el.p2Name.textContent = p2Name;
      el._p1Name = p1Name;
      el._p2Name = p2Name;
    },
    /** Update role indicator dots. role[side] in {null, 'contender', 'support'}. */
    setRoles(leftRole, rightRole) {
      el.p1Dot.dataset.role = leftRole || '';
      el.p2Dot.dataset.role = rightRole || '';
    },
    setScore(scoreL, scoreR) {
      el.score.textContent = `${scoreL} — ${scoreR}`;
    },
    /** Show "Winner: <name>" in place of the live score during the
     *  matchend pause. */
    setWinner(side) {
      if (!side) return;
      const name = side === 'left' ? el._p1Name : el._p2Name;
      el.score.textContent = `Winner: ${name}`;
    },
    setTimer(seconds, totalSeconds) {
      const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      };
      el.timer.textContent = totalSeconds != null
        ? `${fmt(seconds)} / ${fmt(totalSeconds)}`
        : fmt(seconds);
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

/* ── Free camera toggle ─────────────────────────────────── */

/**
 * Wires the options-panel freecam toggle to the renderer's debug cam.
 * Shows a keybind help block while freecam is active. Mutually
 * exclusive with follow-cam.
 */
export function createFreeCamToggle({ renderer, onChange }) {
  const btn = document.getElementById('game-freecam-btn');
  const help = document.getElementById('game-freecam-help');
  if (!btn || !help) return null;
  const render = () => {
    const on = renderer.isDebugCamActive();
    btn.textContent = on ? '[ freecam: on ]' : '[ freecam: off ]';
    btn.dataset.active = on ? 'true' : 'false';
    help.dataset.open = on ? 'true' : 'false';
  };
  btn.addEventListener('click', () => {
    renderer.setDebugCam(!renderer.isDebugCamActive());
    render();
    onChange?.();
  });
  render();
  return { refresh: render };
}

/* ── Follow-ball camera toggle ──────────────────────────── */

export function createFollowCamToggle({ renderer, onChange }) {
  const btn = document.getElementById('game-followcam-btn');
  if (!btn) return null;
  const render = () => {
    const on = renderer.isFollowCamActive();
    btn.textContent = on ? '[ follow ball: on ]' : '[ follow ball: off ]';
    btn.dataset.active = on ? 'true' : 'false';
  };
  btn.addEventListener('click', () => {
    renderer.setFollowCam(!renderer.isFollowCamActive());
    render();
    onChange?.();
  });
  render();
  return { refresh: render };
}
