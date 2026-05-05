/**
 * Football v2 — UI wiring.
 *
 * Binds the DOM elements authored in index.html to the showcase loop:
 * scoreboard (role dots, names, score, timer), options panel toggle,
 * free/follow camera toggles. Some elements in index.html are unwired
 * placeholders for future stat widgets — they show "—" by default.
 */

/** Format `seconds` as `MM:SS`, zero-padded. */
function fmtMmSs(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/** Look up a DOM element by id and throw a clear error if missing.
 *  Used by the scoreboard / options-panel factories where the page
 *  is always expected to ship the relevant markup; a missing id is
 *  a bug, not a graceful-degradation case. */
function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[football/ui] required element #${id} missing`);
  return el;
}

/* ── Scoreboard ─────────────────────────────────────────── */

export function createScoreboard() {
  const el = {
    p1Dot: requireEl('game-p1-dot'),
    p1Name: requireEl('game-p1-name'),
    p2Dot: requireEl('game-p2-dot'),
    p2Name: requireEl('game-p2-name'),
    score: requireEl('game-score'),
    timer: requireEl('game-timer'),
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
      el.timer.textContent = totalSeconds != null
        ? `${fmtMmSs(seconds)} / ${fmtMmSs(totalSeconds)}`
        : fmtMmSs(seconds);
    },
  };
}

/* ── Options button (panel toggle) ──────────────────────── */

export function createOptionsToggle() {
  const btn = requireEl('game-options-btn');
  const panel = requireEl('game-options-panel');
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
