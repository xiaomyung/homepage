/**
 * Football v2 — Iosevka SDF atlas generator.
 *
 * At first call, rasterizes a set of glyphs through tiny-sdf using the
 * browser's already-loaded Iosevka Term font and packs them into a single
 * texture atlas. The atlas is cached in IndexedDB under a font-versioned
 * key so subsequent page loads skip generation entirely (~0ms hit).
 *
 * Called once from main.js at startup, before the renderer initializes.
 * Returns:
 *   {
 *     texture:  THREE.CanvasTexture,      // ready to pass to a shader material
 *     glyphs:   Map<char, GlyphMetrics>,  // atlas UV + pixel metrics per char
 *     atlasSize: number,                  // pixel size of the square atlas
 *     glyphSize: number,                  // pixel size of each glyph cell
 *   }
 */

import * as THREE from './vendor/three.module.js';
import TinySDF from './vendor/tiny-sdf.js';

/** Bump whenever the glyph set, font size, or SDF params change. */
const ATLAS_VERSION = 4;

const FONT_FAMILY = 'Iosevka Term';
const FONT_WEIGHT = 'normal';
const FONT_SIZE = 32;
const SDF_BUFFER = 3;
const SDF_RADIUS = 8;

const CACHE_DB_NAME = 'football-atlas';
const CACHE_STORE = 'atlases';
const CACHE_KEY = `iosevka-v${ATLAS_VERSION}-${FONT_SIZE}`;

/**
 * Character set the game draws. Keep this focused — every glyph adds to
 * the atlas size. Add chars as the renderer needs them.
 */
const GLYPHS =
  'abcdefghijklmnopqrstuvwxyz' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '0123456789' +
  ' .,:;!?/\\|()[]{}<>-_=+*&@#$%^~`"\'' +
  '─│┌┐└┘├┤┬┴┼' + // box-drawing for field/UI
  '░▒▓█▄▀▐▌'; // blocks for stamina / effects

/* ── Public API ───────────────────────────────────────────── */

/**
 * Build (or load from cache) the Iosevka SDF atlas. Idempotent — repeated
 * calls return the cached atlas instantly.
 */
export async function buildAtlas() {
  const cached = await loadFromCache();
  if (cached) {
    return instantiateFromImageData(cached);
  }

  // Wait for the Iosevka woff2 to load before rasterizing
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const result = renderAtlas();
  await saveToCache({
    atlasSize: result.atlasSize,
    glyphSize: result.glyphSize,
    pixels: result.imageData,
    glyphs: Array.from(result.glyphs.entries()),
  });
  return instantiateFromImageData({
    atlasSize: result.atlasSize,
    glyphSize: result.glyphSize,
    pixels: result.imageData,
    glyphs: Array.from(result.glyphs.entries()),
  });
}

/* ── Rendering ────────────────────────────────────────────── */

function renderAtlas() {
  const tinySdf = new TinySDF({
    fontSize: FONT_SIZE,
    buffer: SDF_BUFFER,
    radius: SDF_RADIUS,
    fontFamily: FONT_FAMILY,
    fontWeight: FONT_WEIGHT,
  });

  // Each glyph occupies a `glyphSize × glyphSize` cell. tiny-sdf sizes its
  // output canvas as `fontSize + buffer * 4`; use that as the cell.
  const glyphSize = tinySdf.size;
  const numGlyphs = GLYPHS.length;

  // Square atlas — simplest packing. Grid side = ceil(sqrt(N)).
  const gridSide = Math.ceil(Math.sqrt(numGlyphs));
  const atlasSize = gridSide * glyphSize;

  // Build in a plain ImageData buffer we can upload to a canvas
  const atlas = new Uint8ClampedArray(atlasSize * atlasSize * 4);
  const glyphMap = new Map();

  // Inset the stored UVs by half a texel on each side to prevent linear
  // filtering from bleeding into adjacent cells at cell boundaries.
  const HALF_TEXEL = 0.5 / atlasSize;

  for (let i = 0; i < numGlyphs; i++) {
    const ch = GLYPHS[i];
    const col = i % gridSide;
    const row = Math.floor(i / gridSide);
    const px = col * glyphSize;
    const py = row * glyphSize;

    const { data, width, height, glyphWidth, glyphHeight, glyphAdvance } = tinySdf.draw(ch);

    // tiny-sdf returns an 8-bit grayscale buffer where each byte is the
    // SDF distance. Splat into RGBA with the SDF value in the green channel
    // (the shader samples only green).
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = y * width + x;
        const dst = ((py + y) * atlasSize + (px + x)) * 4;
        const v = data[src];
        atlas[dst] = v;
        atlas[dst + 1] = v;
        atlas[dst + 2] = v;
        atlas[dst + 3] = 255;
      }
    }

    glyphMap.set(ch, {
      u: px / atlasSize + HALF_TEXEL,
      v: py / atlasSize + HALF_TEXEL,
      w: glyphSize / atlasSize - 2 * HALF_TEXEL,
      h: glyphSize / atlasSize - 2 * HALF_TEXEL,
      glyphWidth,
      glyphHeight,
      advance: glyphAdvance,
    });
  }

  return {
    atlasSize,
    glyphSize,
    imageData: atlas,
    glyphs: glyphMap,
  };
}

/* ── Three.js material plumbing ───────────────────────────── */

function instantiateFromImageData({ atlasSize, glyphSize, pixels, glyphs }) {
  // Upload pixels into an OffscreenCanvas / canvas2d, wrap in CanvasTexture
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(atlasSize, atlasSize)
    : document.createElement('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    canvas.width = atlasSize;
    canvas.height = atlasSize;
  }
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(pixels, atlasSize, atlasSize);
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return {
    texture,
    glyphs: new Map(glyphs),
    atlasSize,
    glyphSize,
  };
}

/* ── IndexedDB cache ──────────────────────────────────────── */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadFromCache() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const store = tx.objectStore(CACHE_STORE);
      const req = store.get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function saveToCache(payload) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const store = tx.objectStore(CACHE_STORE);
      const req = store.put(payload, CACHE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Cache failures are non-fatal — we just regenerate next time
  }
}
