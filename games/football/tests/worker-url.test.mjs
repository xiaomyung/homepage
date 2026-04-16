/**
 * Cross-reference test for the warm-start worker URL.
 *
 * ui.js spawns the worker with `new URL(<path>, import.meta.url)`.
 * A wrong relative path (e.g. '../warm-start-worker.js' instead of
 * './warm-start-worker.js') resolves to a 404 and causes the client
 * to flip straight to the "reloading page" phase with no visible
 * progress — the exact regression that shipped in one of the earlier
 * iterations of this PR.
 *
 * This test scans ui.js for the Worker constructor call and asserts
 * the resolved file actually exists on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_JS = resolve(HERE, '..', 'ui.js');

test('warm-start worker URL in ui.js resolves to a real file', () => {
  const src = readFileSync(UI_JS, 'utf8');
  const match = src.match(/new URL\(\s*['"]([^'"]+warm-start-worker\.js(?:\?[^'"]*)?)['"]\s*,\s*import\.meta\.url\s*\)/);
  assert.ok(match, 'ui.js must spawn the warm-start worker via new URL(..., import.meta.url)');
  // Strip any ?v=N cache-bust suffix before checking the file on disk.
  const relPath = match[1].split('?')[0];
  // ui.js is at games/football/ui.js; resolve the worker URL relative to it.
  const resolved = resolve(dirname(UI_JS), relPath);
  assert.ok(
    existsSync(resolved),
    `worker URL '${relPath}' in ui.js resolves to '${resolved}' which does not exist`,
  );
});
