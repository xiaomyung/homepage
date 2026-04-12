/* ASCII Schwarzschild lens — black hole with a tilted accretion disk and a
 * Keplerian star cluster on independent orbits. Rendered into a viewport-
 * filling <pre> as a background layer behind the page content. */

/* ── Geometry ──────────────────────────────────────── */

const R_S = 1.0;
const B_CRIT = (3 * Math.sqrt(3) / 2) * R_S;
const SHADOW_RADIUS = 1.15 * B_CRIT;             // 1.15× cheat absorbs strong-field crowding
const SHADOW_R2 = SHADOW_RADIUS * SHADOW_RADIUS;
const RING_OUTER = SHADOW_RADIUS + 0.30;
const RING_OUTER_R2 = RING_OUTER * RING_OUTER;
const VIEW_HALF_HEIGHT = 13 * R_S;

/* ── Accretion disk ────────────────────────────────── */

const DISK_TILT_RAD = 15 * Math.PI / 180;        // camera elevation above disk plane
const DISK_SIN = Math.sin(DISK_TILT_RAD);
const DISK_R_IN = 3.0 * R_S;
const DISK_R_OUT = 14.0 * R_S;
const DISK_R_IN2 = DISK_R_IN * DISK_R_IN;
const DISK_R_OUT2 = DISK_R_OUT * DISK_R_OUT;
const DISK_SPAN = DISK_R_OUT - DISK_R_IN;
const DISK_INTENSITY = 1.05;
const DISK_SPOKES = 13;                          // prime → no obvious n-fold symmetry
const DISK_KEPLER_BASE_OMEGA = 15;               // angular speed at r = R_IN

/* ── Stars ─────────────────────────────────────────── */

const STAR_COUNT = 40;
const STAR_SIZE_MIN = 0.5;                       // disc radius in cell rows
const STAR_SIZE_MAX = 2.0;
const CAMERA_BH_DISTANCE = 80 * R_S;             // must be >> STAR_R_MAX
const STAR_R_MIN = 22 * R_S;
const STAR_R_MAX = 38 * R_S;
const STAR_FRAME_FILL = 0.80;                    // closest-approach image fill
const STAR_KEPLER_BASE = 5.4;                    // angular speed at r = STAR_R_MIN

/* ── Animation ─────────────────────────────────────── */

const FRAME_MS = 16;                             // ~60 fps target
const ROT_PER_SEC = 0.10;                        // global rotation speed (rad/s)

/* ── Brightness ramp ──────────────────────────────── */

const RAMP = " .'`,:;-~+=!*?coxsXOQ0$#%@&8B";
const RAMP_LEN = RAMP.length;
const RAMP_MAX = RAMP_LEN - 1;
const RING_RAMP_IDX = Math.max(0, RAMP.indexOf('·'));

/* ── Mount ─────────────────────────────────────────── */

const target = document.getElementById('bh-bg');
if (target) {

  /* ── Deterministic PRNG (mulberry32) ────────────── */

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0xB14C0E);

  /* ── Star generation ──────────────────────────────
   * Each star: random orbital plane (uniform unit normal n), random radius,
   * phase, prograde/retrograde direction, and intrinsic depth. (u, v) is
   * an orthonormal basis in the orbit plane built via Gram-Schmidt against
   * a non-parallel helper. Position(θ) = radius · (u·cos θ + v·sin θ). */

  const stars = new Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    const nz = 2 * rand() - 1;
    const nphi = 2 * Math.PI * rand();
    const nr = Math.sqrt(Math.max(0, 1 - nz * nz));
    const nx = nr * Math.cos(nphi);
    const ny = nr * Math.sin(nphi);

    let hX = 0, hY = 0, hZ = 1;
    if (Math.abs(nz) >= 0.9) { hX = 1; hZ = 0; }
    let uX = ny * hZ - nz * hY;
    let uY = nz * hX - nx * hZ;
    let uZ = nx * hY - ny * hX;
    const ulen = Math.sqrt(uX * uX + uY * uY + uZ * uZ) || 1;
    uX /= ulen; uY /= ulen; uZ /= ulen;
    const vX = ny * uZ - nz * uY;
    const vY = nz * uX - nx * uZ;
    const vZ = nx * uY - ny * uX;

    stars[i] = {
      radius: STAR_R_MIN + (STAR_R_MAX - STAR_R_MIN) * rand(),
      uX, uY, uZ,
      vX, vY, vZ,
      phase: 2 * Math.PI * rand(),
      sign: rand() < 0.5 ? -1 : 1,
      depth: Math.pow(rand(), 0.6),
    };
  }

  // Per-frame scratch buffers — reused to avoid GC.
  const starProjX = new Float32Array(STAR_COUNT);
  const starProjY = new Float32Array(STAR_COUNT);
  const starProjD = new Float32Array(STAR_COUNT);
  let visibleStars = 0;

  /* ── Viewport state ──────────────────────────────── */

  let cols = 0, rows = 0;
  let viewHalfWidth = 0;
  let cellW_world = 0, cellH_world = 0;
  let cellAspect = 0.55;
  let maxOrbitR2 = 0;
  let cellBuf = new Uint8Array(0);
  let FOCAL = 1;

  function measure() {
    // Probe an 'M' to get real font cell dimensions in CSS pixels.
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:inherit;font-size:inherit;line-height:inherit;white-space:pre';
    target.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    const cellWpx = rect.width || 9;
    const cellHpx = rect.height || 16;
    target.removeChild(probe);

    cols = Math.max(20, Math.floor(window.innerWidth / cellWpx));
    rows = Math.max(10, Math.floor(window.innerHeight / cellHpx));
    if (cellBuf.length !== cols * rows) cellBuf = new Uint8Array(cols * rows);

    cellAspect = cellWpx / cellHpx;
    viewHalfWidth = VIEW_HALF_HEIGHT * (cols / rows) * cellAspect;
    cellW_world = (2 * viewHalfWidth) / cols;
    cellH_world = (2 * VIEW_HALF_HEIGHT) / rows;

    // FOCAL chosen so a star at max orbit at closest approach (cZ = D − R_MAX)
    // projects to FRAME_FILL × viewHalfWidth — no orbit ever exceeds the cap.
    FOCAL = STAR_FRAME_FILL * viewHalfWidth *
            (CAMERA_BH_DISTANCE - STAR_R_MAX) / STAR_R_MAX;

    // Cap max orbit radius at window_width/2 + 50px (in world units).
    const pxPerWorld = window.innerWidth / (2 * viewHalfWidth);
    const maxOrbitWorld = (window.innerWidth / 2 + 50) / pxPerWorld;
    maxOrbitR2 = maxOrbitWorld * maxOrbitWorld;
  }

  /* ── Pass A: orbit step → world → camera → lens → cull ─── */

  function projectStars(rotation) {
    visibleStars = 0;
    for (let i = 0; i < STAR_COUNT; i++) {
      const s = stars[i];
      // Keplerian-like ω ∝ r^(-3/2), signed by orbital direction.
      const omega = s.sign * STAR_KEPLER_BASE * Math.pow(STAR_R_MIN / s.radius, 1.5);
      const angle = s.phase + omega * rotation;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      // World position relative to BH at origin.
      const wX = s.radius * (s.uX * cosA + s.vX * sinA);
      const wY = s.radius * (s.uY * cosA + s.vY * sinA);
      const wZ = s.radius * (s.uZ * cosA + s.vZ * sinA);
      // Camera frame: BH parked at (0, 0, D).
      const cZ = CAMERA_BH_DISTANCE + wZ;
      if (cZ < 0.5) continue;
      const naiveX = (wX / cZ) * FOCAL;
      const naiveY = (wY / cZ) * FOCAL;
      // Schwarzschild primary image: θ = ½(β + √(β² + 8 r_s)).
      const beta2 = naiveX * naiveX + naiveY * naiveY;
      if (beta2 < 1e-8) continue;
      const beta = Math.sqrt(beta2);
      const theta = 0.5 * (beta + Math.sqrt(beta2 + 8 * R_S));
      const k = theta / beta;
      const projX = naiveX * k;
      const projY = naiveY * k;
      const projR2 = projX * projX + projY * projY;
      // Stars physically behind the BH whose lensed image lands inside the
      // shadow are absorbed by the photon sphere (invisible).
      if (wZ > 0 && projR2 < SHADOW_R2) continue;
      if (projR2 > maxOrbitR2) continue;
      starProjX[visibleStars] = projX;
      starProjY[visibleStars] = projY;
      // Closer (smaller cZ) → bigger and brighter; clamp on extreme close.
      starProjD[visibleStars] = s.depth * Math.min(1.6, CAMERA_BH_DISTANCE / cZ);
      visibleStars++;
    }
  }

  /* ── Pass B: per-cell background (shadow / ring / lensed disk) ─── */

  function renderBackground(rotation) {
    const cw = cellW_world;
    const ch = cellH_world;
    const yMax = DISK_R_OUT * DISK_SIN;
    let idx = 0;
    for (let row = 0; row < rows; row++) {
      const y = -VIEW_HALF_HEIGHT + (row + 0.5) * ch;
      for (let col = 0; col < cols; col++, idx++) {
        const x = -viewHalfWidth + (col + 0.5) * cw;
        const b2 = x * x + y * y;

        if (b2 < SHADOW_R2)     { cellBuf[idx] = 0; continue; }
        if (b2 < RING_OUTER_R2) { cellBuf[idx] = RING_RAMP_IDX; continue; }

        // Inverse Schwarzschild lens (image → source): scale = 1 − 2 r_s / b².
        const scale = 1 - 2 * R_S / b2;
        const sx = x * scale;
        const sy = y * scale;

        // Project source point onto disk plane: foreshortened by sin(tilt).
        const dskY = sy / DISK_SIN;
        const dskR2 = sx * sx + dskY * dskY;
        if (dskR2 <= DISK_R_IN2 || dskR2 >= DISK_R_OUT2) {
          cellBuf[idx] = 0;
          continue;
        }

        // Radial profile (peaks at inner edge), front-back depth (front bright),
        // and a Keplerian-sheared 13-spoke swirl pattern.
        const dskR = Math.sqrt(dskR2);
        const t = (DISK_R_OUT - dskR) / DISK_SPAN;
        const depth = 0.30 + 0.70 * ((sy + yMax) / (2 * yMax));
        const omega = DISK_KEPLER_BASE_OMEGA * Math.pow(DISK_R_IN / dskR, 1.5);
        const dskAngle = Math.atan2(dskY, sx);
        const swirl = 0.65 + 0.35 * Math.sin(DISK_SPOKES * dskAngle - rotation * omega);

        // Gamma 0.75 spreads the bright tail across the denser ramp glyphs.
        const lit = Math.pow(DISK_INTENSITY * t * t * depth * swirl, 0.75);
        cellBuf[idx] = lit >= 1 ? RAMP_MAX : (lit * RAMP_LEN) | 0;
      }
    }
  }

  /* ── Pass C: blit each visible star (max-blend over background) ─── */

  function blitStar(projX, projY, depth) {
    const cCol = Math.round((projX + viewHalfWidth) / cellW_world);
    const cRow = Math.round((projY + VIEW_HALF_HEIGHT) / cellH_world);
    // Disc radius in row units; col radius widened by 1/cellAspect so the
    // disc reads as a pixel-space circle (cells are taller than wide).
    const sizeRows = STAR_SIZE_MIN + (STAR_SIZE_MAX - STAR_SIZE_MIN) * depth * depth;
    const sizeR2 = sizeRows * sizeRows;
    const drRadius = Math.ceil(sizeRows);
    const dcRadius = Math.ceil(sizeRows / cellAspect);
    const peak = 0.45 + 0.55 * depth;

    for (let dr = -drRadius; dr <= drRadius; dr++) {
      const r = cRow + dr;
      if (r < 0 || r >= rows) continue;
      const rowOff = r * cols;
      for (let dc = -dcRadius; dc <= dcRadius; dc++) {
        const c = cCol + dc;
        if (c < 0 || c >= cols) continue;
        const dcPx = dc * cellAspect;
        const dist2 = dr * dr + dcPx * dcPx;
        if (dist2 > sizeR2) continue;
        const t = 1 - Math.sqrt(dist2) / sizeRows;
        const intensity = peak * t * t;
        const newIdx = intensity >= 1 ? RAMP_MAX : (intensity * RAMP_LEN) | 0;
        if (cellBuf[rowOff + c] < newIdx) cellBuf[rowOff + c] = newIdx;
      }
    }
  }

  function blitStars() {
    for (let i = 0; i < visibleStars; i++) {
      blitStar(starProjX[i], starProjY[i], starProjD[i]);
    }
  }

  /* ── Cell buffer → output string ─────────────────── */

  function bufferToString() {
    const lines = new Array(rows);
    for (let row = 0; row < rows; row++) {
      let line = '';
      const off = row * cols;
      for (let col = 0; col < cols; col++) {
        line += RAMP[cellBuf[off + col]];
      }
      lines[row] = line;
    }
    return lines.join('\n');
  }

  function renderFrame(rotation) {
    projectStars(rotation);
    renderBackground(rotation);
    blitStars();
    return bufferToString();
  }

  /* ── Animation loop with visibility gating ─────── */

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rotation = 0;
  let lastFrame = 0;
  let visible = document.visibilityState === 'visible';
  let rafId = null;

  function tick(ts) {
    rafId = null;
    if (!visible) return;
    if (ts - lastFrame >= FRAME_MS) {
      rotation += ROT_PER_SEC * ((ts - lastFrame) / 1000);
      lastFrame = ts;
      target.textContent = renderFrame(rotation);
    }
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId == null && visible && !reduceMotion) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  measure();
  target.textContent = renderFrame(0);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      measure();
      target.textContent = renderFrame(rotation);
    }, 120);
  });

  if (!reduceMotion) {
    document.addEventListener('visibilitychange', () => {
      visible = document.visibilityState === 'visible';
      if (visible) start();
    });
    start();
  }
}
