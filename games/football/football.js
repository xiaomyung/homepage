/**
 * ASCII Football — visual renderer and game controller.
 *
 * Delegates physics to engine.js, AI decisions to nn.js.
 * Spawns a Web Worker (trainer.js) for background headless training.
 * Falls back to simple chase-and-kick AI if the API is unreachable.
 */

import { FootballEngine, FieldConfig, TICK } from './engine.js';
import { NeuralNet } from './nn.js';

/* ── Config ─────────────────────────────────────────────── */

const VISUAL_MATCH_TIMEOUT  = 45000;     // ms before auto-ending a displayed match
const MANUAL_IDLE_TIMEOUT   = 3000;      // ms of no input before returning to NN mode
const NAME_HIDE_DIST        = 35;
const API_BASE              = '/api/football';
const STATS_POLL_INTERVAL   = 3000;      // ms between stats fetches
const AI_PREDICT_FRAMES     = 20;
const MAX_WORKERS           = navigator.hardwareConcurrency || 4;
const STORAGE_KEY_WORKERS   = 'fb-worker-count';
let activeWorkers = [];
let targetWorkerCount = parseInt(localStorage.getItem(STORAGE_KEY_WORKERS)) || MAX_WORKERS;

/* ── Frames ─────────────────────────────────────────────── */

const FRAMES = {
  idle:  " O \n(|)\n/\\ ",
  walk:  ["  O\n(/\\\n/ \\", "  O\n//)\n | "],
  alert: "\\O/\n | \n/\\ ",
  kick:  [" O \n(|)\n |( ", " O \n(|)\n |\\_", " O \n(|)\n |) "],
  push:  " O \n(|\\_@\n/\\ ",
};

const SURNAMES = [
  'Messi', 'Ronaldo', 'Neymar', 'Mbappé', 'Haaland', 'Salah', 'De Bruyne',
  'Modric', 'Benzema', 'Lewandowski', 'Vinícius', 'Bellingham', 'Pedri',
  'Gavi', 'Saka', 'Foden', 'Kane', 'Son', 'Mané', 'Díaz', 'Griezmann',
  'Müller', 'Kimmich', 'Hakimi', 'Palmer', 'Yamal', 'Rodri', 'Doku',
];

/* ── DOM helpers ────────────────────────────────────────── */

function addPre(parent, text, cls) {
  const el = document.createElement('pre');
  el.setAttribute('aria-hidden', 'true');
  if (text) el.textContent = text;
  if (cls) el.className = cls;
  parent.appendChild(el);
  return el;
}

function addSpan(parent, text, cls) {
  const el = document.createElement('span');
  if (text) el.textContent = text;
  if (cls) el.className = cls;
  parent.appendChild(el);
  return el;
}

function pickName(exclude) {
  let name;
  do { name = SURNAMES[Math.floor(Math.random() * SURNAMES.length)]; } while (name === exclude);
  return name;
}

/* ── DOM setup ──────────────────────────────────────────── */

const stage = document.createElement('div');
stage.id = 'game-stage';
document.body.appendChild(stage);

const fieldBorderEl = addPre(stage, '', 'fb-field-border');
const goalLineL = addPre(stage, '  /\n / \n/  ', 'fb-goalline fb-goalline-l');
const goalLineR = addPre(stage, '\\  \n \\ \n  \\', 'fb-goalline fb-goalline-r');
const goalL = addPre(stage, '     ___ \n    /  /|\n   /__/_|\n  /__/   \n /   |   \n/____|  ', 'fb-goal fb-goal-l');
const goalR = addPre(stage, ' ___    \n|\\  \\   \n|_\\__\\  \n   \\__\\ \n   |   \\\n   |____\\', 'fb-goal fb-goal-r');
const ballEl = addPre(stage, 'o', 'fb-ball');
// Scoreboard: left name+score | right score+name, timer below
const scoreboardEl = document.createElement('div');
scoreboardEl.className = 'fb-scoreboard';
const sbLeft = document.createElement('span');
sbLeft.className = 'fb-sb-left';
const sbSep = document.createElement('span');
sbSep.className = 'fb-sb-sep';
sbSep.textContent = '\u2502';
const sbRight = document.createElement('span');
sbRight.className = 'fb-sb-right';
const timerEl = document.createElement('div');
timerEl.className = 'fb-timer';
scoreboardEl.appendChild(sbLeft);
scoreboardEl.appendChild(sbSep);
scoreboardEl.appendChild(sbRight);
scoreboardEl.appendChild(timerEl);
stage.appendChild(scoreboardEl);

// Stats bar lives outside the game stage (below it)
const statsEl = document.createElement('div');
statsEl.className = 'fb-config-stats';

// Stamina bars — always visible, positioned above goals
const staminaL = document.createElement('div');
staminaL.className = 'fb-stamina fb-stamina-l';
staminaL.innerHTML = '<div class="fb-stamina-fill"></div>';
stage.appendChild(staminaL);

const staminaR = document.createElement('div');
staminaR.className = 'fb-stamina fb-stamina-r';
staminaR.innerHTML = '<div class="fb-stamina-fill"></div>';
stage.appendChild(staminaR);

const staminaFillL = staminaL.querySelector('.fb-stamina-fill');
const staminaFillR = staminaR.querySelector('.fb-stamina-fill');

// Mobile touch controls
const touchControls = document.createElement('div');
touchControls.className = 'fb-touch-controls';
touchControls.innerHTML = `
  <div class="fb-joystick-area">
    <div class="fb-joystick-base">
      <div class="fb-joystick-thumb"></div>
    </div>
  </div>
  <div class="fb-touch-buttons">
    <button class="fb-btn-kick">KICK</button>
    <button class="fb-btn-push">PUSH</button>
  </div>
`;
touchControls.style.display = 'none';

/* ── Visual player objects ──────────────────────────────── */

function createVisualPlayer(side, name) {
  const el = addPre(stage, FRAMES.idle, 'fb-player');
  const nameEl = addSpan(stage, name, 'fb-name');
  return { el, nameEl, name, side };
}

const vp1 = createVisualPlayer('left', pickName());
const vp2 = createVisualPlayer('right', pickName(vp1.name));

// Reset button — reload icon
const resetBtn = document.createElement('button');
resetBtn.className = 'fb-reset-btn';
resetBtn.title = 'Reset evolution';
resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';

// More button — opens config panel
const moreBtn = document.createElement('button');
moreBtn.className = 'fb-more-btn';
moreBtn.title = 'Evolution stats';
moreBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

// Config panel (hidden by default)
const configPanel = document.createElement('div');
configPanel.className = 'fb-config-panel';
configPanel.style.display = 'none';
configPanel.innerHTML = `
  <div class="fb-config-graph">
    <canvas class="fb-fitness-canvas"></canvas>
  </div>
  <div class="fb-worker-control">
    <span class="fb-stat-label">Workers</span>
    <button class="fb-worker-btn" data-delta="-1">−</button>
    <span class="fb-worker-count"></span>
    <button class="fb-worker-btn" data-delta="+1">+</button>
  </div>
`;
configPanel.appendChild(statsEl);

// Worker count control
const workerCountEl = configPanel.querySelector('.fb-worker-count');
function updateWorkerDisplay() {
  workerCountEl.textContent = targetWorkerCount + '/' + MAX_WORKERS;
}
updateWorkerDisplay();
configPanel.querySelectorAll('.fb-worker-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setWorkerCount(targetWorkerCount + parseInt(btn.dataset.delta));
    updateWorkerDisplay();
  });
});

// Wrapper for buttons
const statsRow = document.createElement('div');
statsRow.className = 'fb-stats-row';
const btnGroup = document.createElement('div');
btnGroup.className = 'fb-btn-group';
btnGroup.appendChild(moreBtn);
btnGroup.appendChild(resetBtn);
statsRow.appendChild(btnGroup);

// Insert elements after stage
stage.after(statsRow);
statsRow.after(configPanel);
configPanel.after(touchControls);

/* ── State ──────────────────────────────────────────────── */

let engine = null;
let field = null;
let state = null;
let nn1 = null;           // NN for player 1 (or null in fallback mode)
let nn2 = null;           // NN for player 2
let fallbackMode = false; // true when API is unreachable
let brewing = true;       // true until first best brain is available
let manualMode = false;   // true when player is using keyboard/touch
let lastManualInput = 0;
let matchStartTime = 0;
let matchTimerStopped = false;
let charW = 0, lineH = 0;
let nextMatchPending = false;
let matchEnding = false;

// Manual control state
const keys = {};
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
let kickPressed = false;
let pushPressed = false;

// Touch joystick state
let joystickActive = false;
let joystickDx = 0, joystickDy = 0;
let touchKickPressed = false;
let touchPushPressed = false;

/* ── Layout ─────────────────────────────────────────────── */

function measure() {
  if (!goalL.offsetHeight || !goalL.offsetWidth) return;
  lineH = goalL.offsetHeight / 6;
  charW = goalL.offsetWidth / 9;
}

function buildField() {
  measure();
  if (!charW) return;
  field = FieldConfig.fromDOM(goalL, goalR, goalLineL, goalLineR, stage);
  engine = new FootballEngine(field);
}

function buildFieldBorder() {
  if (!charW) measure();
  if (!charW || !stage.offsetWidth) return;
  const total = Math.floor(stage.offsetWidth / charW) - 1;
  if (total < 12) return;
  const w = Math.max(0, total - 2);
  const lines = [
    '     ' + '_'.repeat(Math.max(0, total - 10)) + '     ',
    '    /' + ' '.repeat(Math.max(0, total - 10)) + '\\    ',
    '   /' + ' '.repeat(Math.max(0, total - 8)) + '\\   ',
    '  /' + ' '.repeat(Math.max(0, total - 6)) + '\\  ',
    ' /' + ' '.repeat(Math.max(0, total - 4)) + '\\ ',
    '/' + '_'.repeat(w) + '\\',
  ];
  fieldBorderEl.textContent = lines.join('\n');
}

/* ── Particle effects ───────────────────────────────────── */

function spawnParticle(x, bottom, chars, color, pvx, pvy, fadeRate, maxFrames) {
  const spark = document.createElement('span');
  spark.textContent = chars[Math.random() * chars.length | 0];
  spark.style.cssText = `position:absolute;pointer-events:none;font-size:0.7rem;color:${color}`;
  spark.style.left = x + 'px';
  spark.style.bottom = bottom + 'px';
  stage.appendChild(spark);
  let sx = 0, sy = 0, op = 1, f = 0;
  (function animate() {
    f++;
    sx += pvx;
    sy += pvy + f * 0.15;
    op -= fadeRate;
    spark.style.transform = `translate(${sx}px,${sy}px)`;
    spark.style.opacity = Math.max(0, op);
    if (op > 0 && f < maxFrames) requestAnimationFrame(animate);
    else spark.remove();
  })();
}

function celebrate(cx) {
  const count = 6 + (Math.random() * 4 | 0);
  for (let i = 0; i < count; i++) {
    spawnParticle(cx, 30, ['*', '\u2726'], 'rgba(255,255,255,0.5)',
      (Math.random() - 0.5) * 6, -(2 + Math.random() * 4), 0.02, 50);
  }
}

function damageParticles(vp, pushDir) {
  const p = vp === vp1 ? state.p1 : state.p2;
  const cx = p.x + vp.el.offsetWidth / 2;
  const by = 20 + p.y;
  const count = 3 + (Math.random() * 3 | 0);
  for (let i = 0; i < count; i++) {
    spawnParticle(cx, by, ['!', '\u00d7', '\u00b7', '#'], 'rgba(247,118,142,0.7)',
      pushDir * (1 + Math.random() * 3) + (Math.random() - 0.5) * 2,
      -(1 + Math.random() * 3), 0.04, 30);
  }
}

/* ── Rendering ──────────────────────────────────────────── */

function getFrame(p) {
  switch (p.state) {
    case 'walk':    return FRAMES.walk[p.fi % FRAMES.walk.length];
    case 'kick':
    case 'airkick': return FRAMES.kick[Math.min(p.fi, FRAMES.kick.length - 1)];
    case 'jump':    return FRAMES.alert;
    case 'push':    return FRAMES.push;
    case 'alert':   return FRAMES.alert;
    default:        return FRAMES.idle;
  }
}

function render() {
  if (!state || !field) return;
  const p1 = state.p1, p2 = state.p2, ball = state.ball;
  const pw = field.playerWidth;

  const c1 = p1.x + pw / 2;
  const c2 = p2.x + pw / 2;
  const hideNames = Math.abs(c1 - c2) < NAME_HIDE_DIST;

  [[vp1, p1], [vp2, p2]].forEach(([vp, p]) => {
    vp.el.textContent = getFrame(p);
    const w = vp.el.offsetWidth;
    const yOff = (p.jumpY || 0) + p.y;
    vp.el.style.transform = p.dir === 1
      ? `translate(${p.x}px,${-yOff}px)`
      : `translate(${p.x + w}px,${-yOff}px) scaleX(-1)`;

    const nw = vp.nameEl.offsetWidth;
    vp.nameEl.style.transform = `translate(${p.x + w / 2 - nw / 2}px,${-yOff}px)`;
    vp.nameEl.style.opacity = hideNames ? '0' : '1';
  });

  ballEl.style.transform = `translate(${ball.x}px,${-(ball.y + ball.z)}px)`;

  // Match timer
  if (!matchTimerStopped) {
    const elapsed = Date.now() - matchStartTime;
    const sec = Math.floor(elapsed / 1000);
    const min = Math.floor(sec / 60);
    timerEl.textContent = `${min}:${String(sec % 60).padStart(2, '0')}`;
  }

  // Stamina bars — always visible
  staminaFillL.style.width = (p1.stamina * 100) + '%';
  staminaFillR.style.width = (p2.stamina * 100) + '%';
}

function updateScoreboard() {
  if (!state) return;
  sbLeft.textContent = vp1.name + ' ' + state.scoreL + ' ';
  sbSep.textContent = '\u2502';
  sbRight.textContent = ' ' + state.scoreR + ' ' + vp2.name;
}

/* ── Fallback AI (original chase-and-kick) ──────────────── */

function fallbackAIOutputs(s, which) {
  const p = s[which];
  const opp = which === 'p1' ? s.p2 : s.p1;
  const ball = s.ball;

  // Predict ball position
  const tx = ball.x + ball.vx * AI_PREDICT_FRAMES;
  const ty = ball.y;

  // Move toward predicted ball
  const center = p.x + field.playerWidth / 2;
  const dx = tx - center;
  const dy = ty - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  const moveX = dx / dist;
  const moveY = dy / dist;

  // Kick toward opponent's goal
  const kickDir = p.side === 'left' ? 1 : -1;
  const canKickNow = Math.abs(dx) < field.playerWidth && Math.abs(dy) < 10 && ball.z < 10;

  // Push when close to opponent (random chance like original)
  const oppCenter = opp.x + field.playerWidth / 2;
  const oppDist = Math.abs(center - oppCenter);
  const closeToOpp = oppDist < 30 && Math.abs(p.y - opp.y) < 20;
  const wantPush = closeToOpp && Math.random() < 0.03;

  return [
    moveX, moveY,
    canKickNow ? 1 : -1,  // kick
    kickDir, 0, 0.2,       // kick direction (toward goal, slight lob)
    0.8,                    // kick power
    wantPush ? 1 : -1,     // push
    0.5,                    // push power
  ];
}

/* ── Manual control outputs ─────────────────────────────── */

function manualOutputs(s) {
  let mx = 0, my = 0;

  // Keyboard
  if (keys['KeyW'] || keys['ArrowUp']) my = 1;
  if (keys['KeyS'] || keys['ArrowDown']) my = -1;
  if (keys['KeyA'] || keys['ArrowLeft']) mx = -1;
  if (keys['KeyD'] || keys['ArrowRight']) mx = 1;

  // Touch joystick overrides
  if (joystickActive) {
    mx = joystickDx;
    my = joystickDy;
  }

  // Kick: aim toward ball, moderate power
  const ball = s.ball;
  const p = s.p1;
  const center = p.x + field.playerWidth / 2;
  const kdx = ball.x - center;
  const kdy = ball.y - p.y;
  const kdz = ball.z > 5 ? 0.3 : 0.1;
  const klen = Math.sqrt(kdx * kdx + kdy * kdy) || 1;

  const doKick = kickPressed || touchKickPressed;
  const doPush = pushPressed || touchPushPressed;

  kickPressed = false;
  touchKickPressed = false;
  pushPressed = false;
  touchPushPressed = false;

  return [
    mx, my,
    doKick ? 1 : -1,
    kdx / klen, kdy / klen, kdz,
    0.4,                     // moderate kick power
    doPush ? 1 : -1,
    0.5,                     // moderate push power
  ];
}

/* ── API communication ──────────────────────────────────── */

function b64ToFloat32(b64) {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return new Float32Array(buffer);
}

async function fetchShowcase() {
  try {
    const res = await fetch(`${API_BASE}/showcase`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (data.brewing || !data.brain_a) {
      return null; // still brewing
    }
    return {
      nn1: new NeuralNet(b64ToFloat32(data.brain_a)),
      nn2: new NeuralNet(b64ToFloat32(data.brain_b)),
    };
  } catch {
    return 'fallback';
  }
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ── Match lifecycle ────────────────────────────────────── */

function startMatch(brains) {
  if (!engine) return;

  state = engine.createState();
  matchStartTime = Date.now();
  matchTimerStopped = false;
  matchEnding = false;

  if (brains === 'fallback' || brains === null) {
    fallbackMode = true;
    nn1 = null;
    nn2 = null;
  } else {
    fallbackMode = false;
    nn1 = brains.nn1;
    nn2 = brains.nn2;
  }

  brewing = brains === null;

  // Pick fresh names
  vp1.name = pickName();
  vp2.name = pickName(vp1.name);
  vp1.nameEl.textContent = vp1.name;
  vp2.nameEl.textContent = vp2.name;

  updateScoreboard();
}

async function nextMatch() {
  if (nextMatchPending) return;
  nextMatchPending = true;
  try {
    const brains = await fetchShowcase();
    startMatch(brains);
  } finally {
    nextMatchPending = false;
  }
}

/* ── Main loop ──────────────────────────────────────────── */

function update() {
  if (!state || !engine || !field) return;

  // Check match timeout (only in non-manual mode)
  if (!manualMode && !matchEnding && !state.matchOver && !state.paused) {
    const elapsed = Date.now() - matchStartTime;
    if (elapsed > VISUAL_MATCH_TIMEOUT) {
      state.matchOver = true;
      state.winner = state.scoreL > state.scoreR ? 'left' : (state.scoreR > state.scoreL ? 'right' : null);
    }
  }

  // Match ended — start next (use matchEnding flag to prevent re-entry)
  if (state.matchOver && !matchEnding) {
    matchEnding = true;
    matchTimerStopped = true;
    setTimeout(nextMatch, 2000);
    if (state.winner) {
      const winnerName = state.winner === 'left' ? vp1.name : vp2.name;
      sbLeft.textContent = '';
      sbSep.textContent = 'Winner: ' + winnerName;
      sbRight.textContent = '';
    } else {
      sbLeft.textContent = '';
      sbSep.textContent = 'Draw!';
      sbRight.textContent = '';
    }
    timerEl.textContent = '';
    return;
  }

  // Check manual mode timeout — refresh if any key is held
  if (manualMode) {
    const anyKeyHeld = Object.values(keys).some(Boolean) || joystickActive;
    if (anyKeyHeld) lastManualInput = Date.now();
    if (Date.now() - lastManualInput > MANUAL_IDLE_TIMEOUT) {
      manualMode = false;
      touchControls.style.display = 'none';
    }
  }

  // Determine outputs for each player
  let p1Out, p2Out;

  if (manualMode) {
    p1Out = manualOutputs(state);
  } else if (fallbackMode) {
    p1Out = fallbackAIOutputs(state, 'p1');
  } else if (nn1 && !brewing) {
    const inputs = engine.buildInputs(state, 'p1');
    p1Out = nn1.forward(inputs);
  } else {
    p1Out = null; // brewing, no outputs
  }

  if (fallbackMode) {
    p2Out = fallbackAIOutputs(state, 'p2');
  } else if (nn2 && !brewing) {
    const inputs = engine.buildInputs(state, 'p2');
    p2Out = nn2.forward(inputs);
  } else {
    p2Out = null;
  }

  // Tick the engine
  engine.tick(state, p1Out, p2Out);

  // Handle visual events
  for (const evt of state.events) {
    if (evt === 'goal_left') {
      celebrate(goalL.offsetLeft + goalL.offsetWidth / 2);
      updateScoreboard();
    } else if (evt === 'goal_right') {
      celebrate(goalR.offsetLeft + goalR.offsetWidth / 2);
      updateScoreboard();
    } else if (evt === 'push') {
      // Find which player got pushed by checking push velocities
      if (Math.abs(state.p1.pushVx) > 1) damageParticles(vp1, state.p1.pushVx > 0 ? 1 : -1);
      if (Math.abs(state.p2.pushVx) > 1) damageParticles(vp2, state.p2.pushVx > 0 ? 1 : -1);
    }
  }

  if (state.matchOver || (state.winner && state.pausePhase === 'matchend')) {
    matchTimerStopped = true;
  }
}

/* ── Input handlers ─────────────────────────────────────── */

function activateManualMode() {
  manualMode = true;
  lastManualInput = Date.now();
  // Show touch controls on mobile
  if ('ontouchstart' in window) {
    touchControls.style.display = '';
  }
}

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (MOVE_KEYS.has(e.code)) {
    activateManualMode();
  }
});

document.addEventListener('keyup', e => {
  keys[e.code] = false;
});

// Left click = kick
stage.addEventListener('click', e => {
  if (e.button === 0) {
    kickPressed = true;
    activateManualMode();
  }
});

// Right click = push
stage.addEventListener('contextmenu', e => {
  e.preventDefault();
  pushPressed = true;
  activateManualMode();
});

// Touch joystick
const joystickBase = touchControls.querySelector('.fb-joystick-base');
const joystickThumb = touchControls.querySelector('.fb-joystick-thumb');

if (joystickBase) {
  let baseRect = null;
  joystickBase.addEventListener('touchstart', e => {
    e.preventDefault();
    joystickActive = true;
    baseRect = joystickBase.getBoundingClientRect();
    activateManualMode();
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!joystickActive || !baseRect) return;
    const touch = Array.from(e.touches).find(t => {
      const r = joystickBase.getBoundingClientRect();
      return t.clientX >= r.left - 50 && t.clientX <= r.right + 50;
    });
    if (!touch) return;
    const cx = baseRect.left + baseRect.width / 2;
    const cy = baseRect.top + baseRect.height / 2;
    const maxR = baseRect.width / 2;
    let dx = touch.clientX - cx;
    let dy = -(touch.clientY - cy); // invert Y: up = positive
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
    joystickDx = dx / maxR; // normalized -1 to 1
    joystickDy = dy / maxR;
    if (joystickThumb) {
      joystickThumb.style.transform = `translate(${dx}px, ${-dy}px)`;
    }
    activateManualMode();
  }, { passive: true });

  document.addEventListener('touchend', () => {
    joystickActive = false;
    joystickDx = 0;
    joystickDy = 0;
    if (joystickThumb) joystickThumb.style.transform = '';
  });
}

// Touch buttons
const btnKick = touchControls.querySelector('.fb-btn-kick');
const btnPush = touchControls.querySelector('.fb-btn-push');
if (btnKick) btnKick.addEventListener('touchstart', e => { e.preventDefault(); touchKickPressed = true; activateManualMode(); }, { passive: false });
if (btnPush) btnPush.addEventListener('touchstart', e => { e.preventDefault(); touchPushPressed = true; activateManualMode(); }, { passive: false });

// Reset evolution button
resetBtn.addEventListener('click', async () => {
  if (!confirm('Reset evolution? This wipes all brains and starts fresh.')) return;
  try {
    await fetch(`${API_BASE}/reset`, { method: 'POST' });
  } catch { /* reload anyway */ }
  location.reload();
});

// More button — toggle config panel
let graphInterval = null;
moreBtn.addEventListener('click', () => {
  const open = configPanel.style.display === 'none';
  configPanel.style.display = open ? '' : 'none';
  if (open) {
    loadFitnessGraph();
    graphInterval = setInterval(loadFitnessGraph, STATS_POLL_INTERVAL);
  } else if (graphInterval) {
    clearInterval(graphInterval);
    graphInterval = null;
  }
});

// Fitness graph
async function loadFitnessGraph() {
  try {
    const res = await fetch(`${API_BASE}/history?limit=10000`);
    if (!res.ok) return;
    let data = await res.json();
    if (!data.length) return;

    // Save raw last point before downsampling (for accurate label)
    const rawLast = data[data.length - 1];

    // Downsample to fit canvas width — average buckets when too many points
    const canvas = configPanel.querySelector('.fb-fitness-canvas');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 10, bottom: 2, left: 0, right: 30 };
    const gw = w - pad.left - pad.right;
    const gh = h - pad.top - pad.bottom;
    const maxPoints = Math.floor(gw); // 1 point per pixel max

    if (data.length > maxPoints) {
      const bucketSize = data.length / maxPoints;
      const downsampled = [];
      for (let i = 0; i < maxPoints; i++) {
        const start = Math.floor(i * bucketSize);
        const end = Math.floor((i + 1) * bucketSize);
        let topMax = -Infinity, avgSum = 0, count = 0;
        for (let j = start; j < end && j < data.length; j++) {
          if (data[j].top > topMax) topMax = data[j].top;
          avgSum += data[j].avg;
          count++;
        }
        downsampled.push({ top: topMax, avg: count ? avgSum / count : 0, gen: data[end - 1]?.gen || 0 });
      }
      data = downsampled;
    }

    ctx.clearRect(0, 0, w, h);

    const maxF = Math.max(...data.map(d => d.top), 0.1);
    const minF = Math.min(...data.map(d => d.avg));
    const step = gw / Math.max(data.length - 1, 1);

    function drawLine(key, color, lw) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      data.forEach((d, i) => {
        const x = pad.left + i * step;
        const y = pad.top + gh - ((d[key] - minF) / (maxF - minF || 1)) * gh;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    drawLine('avg', 'rgba(255,255,255,0.1)', 1);
    drawLine('top', 'rgba(255,255,255,0.35)', 1.5);

    // Last-point labels — use raw (pre-downsample) values, positioned at graph edge
    const lastX = pad.left + (data.length - 1) * step + 4;
    const lastTopY = pad.top + gh - ((rawLast.top - minF) / (maxF - minF || 1)) * gh;
    const lastAvgY = pad.top + gh - ((rawLast.avg - minF) / (maxF - minF || 1)) * gh;
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(rawLast.top.toFixed(2), lastX, lastTopY + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillText(rawLast.avg.toFixed(2), lastX, lastAvgY + 3);

    // Legend — top left
    ctx.textAlign = 'left';
    const ly = pad.top + 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(4, ly - 3); ctx.lineTo(16, ly - 3); ctx.stroke();
    ctx.fillText('best', 19, ly);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(48, ly - 3); ctx.lineTo(60, ly - 3); ctx.stroke();
    ctx.fillText('avg', 63, ly);
  } catch { /* silent */ }
}

// Resize
window.addEventListener('resize', () => {
  measure();
  if (charW) {
    goalLineL.style.left = (goalL.offsetLeft + goalL.offsetWidth - charW * 3) + 'px';
    goalLineR.style.left = goalR.offsetLeft + 'px';
  }
  buildField();
  buildFieldBorder();
  if (state && field) state.field = field;
});

/* ── Stats polling ──────────────────────────────────────── */

function updateStatsDisplay(data) {
  if (!data) {
    statsEl.textContent = fallbackMode ? 'Evolution offline — fallback AI' : '';
    return;
  }
  const t = data.trainers || {};
  const trainingParts = [];
  if (t.browser) trainingParts.push(`${t.browser} this`);
  if (t.server) trainingParts.push(`${t.server} server`);
  if (t.other) trainingParts.push(`${t.other} other`);

  const items = [
    ['Generation', data.generation],
    ['Top fitness', data.top_fitness],
    ['Avg fitness', data.avg_fitness ?? '—'],
    ['Total matches', data.total_matches.toLocaleString()],
    ['Avg goals', data.avg_goals],
    ['HoF brains', data.hof_size ?? '—'],
    ['Mutation', data.mutation_rate != null ? `${data.mutation_rate} / \u03c3${data.mutation_std}` : '—'],
    ['Goal size', data.goal_size ?? '—'],
  ];
  if (trainingParts.length) items.push(['Training', trainingParts.join(' · ') + ' sims/s']);
  statsEl.innerHTML = items.map(([k, v]) =>
    `<span class="fb-stat-item"><span class="fb-stat-label">${k}</span> ${v}</span>`
  ).join('');
}

setInterval(async () => {
  const data = await fetchStats();
  updateStatsDisplay(data);
}, STATS_POLL_INTERVAL);

/* ── Web Worker ─────────────────────────────────────────── */

function setWorkerCount(count) {
  count = Math.max(0, Math.min(MAX_WORKERS, count));
  targetWorkerCount = count;
  localStorage.setItem(STORAGE_KEY_WORKERS, count);

  // Start additional workers
  while (activeWorkers.length < count) {
    try {
      const w = new Worker(new URL('./trainer.js?v=3', import.meta.url), { type: 'module' });
      activeWorkers.push(w);
    } catch {
      break;
    }
  }
  // Terminate excess workers
  while (activeWorkers.length > count) {
    activeWorkers.pop().terminate();
  }
}

/* ── Init ───────────────────────────────────────────────── */

function init() {
  measure();

  // Position goal lines BEFORE building field config (fromDOM reads their offsetLeft)
  if (charW) {
    goalLineL.style.left = (goalL.offsetLeft + goalL.offsetWidth - charW * 3) + 'px';
    goalLineR.style.left = goalR.offsetLeft + 'px';
  }

  buildField();
  buildFieldBorder();

  // Start with fetching best brain
  nextMatch();
  setWorkerCount(targetWorkerCount);

  // Initial stats fetch
  fetchStats().then(updateStatsDisplay);
}

requestAnimationFrame(() => {
  init();

  let last = 0;
  (function loop(now) {
    if (now - last >= TICK) {
      last = now;
      update();
      render();
    }
    requestAnimationFrame(loop);
  })(0);
});
