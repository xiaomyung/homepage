# homepage

Personal homelab dashboard — a static page with a live infra banner, health-check dots for every self-hosted service, an ASCII Schwarzschild black hole background, and a football mini-game whose AI players are trained via neuroevolution in the browser.

## Running locally

**Prerequisites:** [Node.js 22+](https://nodejs.org/) (the only dependency).

### 1. Clone and start

```sh
git clone https://github.com/xiaomyung/homepage.git
cd homepage
```

Open two terminals:

```sh
# Terminal 1 — football evolution broker
node games/football/api/broker.mjs

# Terminal 2 — dev server (static files + API proxy)
node dev-server.mjs
```

Open **http://localhost:8000**.

### 2. What to expect locally

- **Service cards** show as offline — the health checks probe `*.home.arpa` domains that only resolve on the homelab. This is expected.
- **Banner** shows `—` for every field — the stats endpoint needs node-exporter and Docker, which aren't present locally. This is expected.
- **Football game** works fully — the showcase match, training workers, evolution, and stats panel all run locally.
- **Black hole background** renders normally.

### Windows notes

Use PowerShell or `cmd.exe`. Node.js for Windows works out of the box — no WSL needed. The same two commands above apply.

### macOS / Linux

Works as-is with any Node 22+ install (Homebrew, nvm, fnm, distro package).

## File layout

| Path | Purpose |
|------|---------|
| `index.html` | Dashboard markup, banner, service cards, football section |
| `style.css` | Monochrome dark theme, responsive grid, animations |
| `app.js` | Health checks, banner updater, stats loader, grid capping |
| `dev-server.mjs` | Local dev: static files + `/api/football` and `/api/stats` proxy |
| `setup.sh` | Idempotent production bring-up (systemd units + Caddy) |
| `requirements.txt` | Optional: Playwright for the headless screenshot dev tool |
| `stats/app.mjs` | `/api/stats` shim — parses node-exporter metrics + Docker status |
| `stats/homepage-stats.service` | systemd unit for the stats shim |
| `games/blackhole/blackhole.js` | ASCII Schwarzschild lens background animation |
| `games/football/main.js` | Football game entry point |
| `games/football/physics.js` | Headless physics engine (DOM-free, pure math) |
| `games/football/renderer.js` | Three.js 3D renderer (pooled capsule + sphere meshes) |
| `games/football/animation/` | Pure animation pipeline: state.js + poses.js + curves.js + sampler |
| `games/football/nn.js` | Feedforward neural net (25→16→9, LeakyReLU + tanh) |
| `games/football/fallback.js` | Handcoded fallback heuristic (frozen baseline opponent) |
| `games/football/worker.js` | Web Worker for headless training matches |
| `games/football/training-orchestrator.js` | Client-side matchmaker + sync loop |
| `games/football/matchmaker.js` | Deterministic matchup picker (pop + fallback rotation) |
| `games/football/ui.js` | Scoreboard, stats panel, fitness graph, config controls |
| `games/football/api/broker.mjs` | Node broker: population store, breeding, stats API |
| `games/football/evolution/ga.mjs` | Genetic algorithm: tournament selection, crossover, mutation |
| `games/football/evolution/build-warm-start.mjs` | Offline tool: generates `warm_start_weights.json` |
| `games/football/tests/` | Node test runner tests — physics, nn, fallback, broker, matchmaker, animation/*, frame-loop, stamina, runtime-timer, fitness, reset-pipeline, etc. |
| `games/football/debug/` | Dev tools: test-renderer harness, headless profiler, Playwright screenshot scripts |
| `fonts/` | Vendored Iosevka Term woff2 (regular + medium) |

Three.js is loaded from a pinned `unpkg` CDN URL in `renderer.js` —
no vendored copy.

## Football AI

Below the dashboard, two AI stickmen play football. Showcase matches loop automatically. Click **[ start ]** to begin training — browser web workers run headless matches in the background.

### Architecture

- **Neural net:** 25→16→9 (LeakyReLU hidden, tanh output, 569 weights). Inputs 20–24 are derived (possession / ball threat / goal distances) so the small net mostly routes pre-cooked features into the action.
- **Inputs:** player/opponent positions + velocities, stamina, ball state (3D), goal positions, field width — plus the derived features above. All normalized to [-1, 1].
- **Outputs:** movement (2D), kick toggle + direction (3D) + power, push toggle + power.
- **Training:** fully client-side. Web Workers run headless physics matches, report results to the broker. Broker aggregates and triggers breeding when every brain has enough matches.
- **Genetic algorithm:** population 50, tournament selection (k=5), two-point crossover, Gaussian mutation with weight decay, 5 elites carried forward, ~6% random injection per generation.
- **Warm start:** generation 0 is seeded from a supervised-learning distillation of the fallback heuristic, not random weights.
- **Animation:** purely derived — `animation/state.js` advances LPF factors + phase, `animation/poses.js` composes a layered pose; physics state is never written from the animation layer (preserves bit-deterministic showcase replay).

### Broker API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/football/population` | GET | Full population snapshot (weights + metadata) |
| `/api/football/results` | POST | Aggregated match results from client workers |
| `/api/football/showcase` | GET | Brain pair + seed + weights snapshots for the visual match (1:1 fallback-mode vs brain-vs-brain replays) |
| `/api/football/stats` | GET | Generation, fitness, match counts, runtime |
| `/api/football/history` | GET | Fitness history for the graph (downsampled) |
| `/api/football/config` | GET/POST | Evolution tunables |
| `/api/football/reset` | POST | Wipe population, re-seed from warm start |

### Controls

- **[ start ] / [ stop ]** — toggle background training workers
- **[ options ]** — stats panel, fitness graph, worker count, freecam, follow-cam, test-renderer link, reset
- **Auto-pause** — training stops when the tab is hidden or the app is backgrounded

### Animation debug harness

`games/football/debug/test-renderer.html` shows 8 grouped harnesses
(locomotion, ground kick, airkick, airborne ball, pushing, ball
contact, collisions, dead-ball) with N scenarios per strip ticking
in parallel. Lazy-mounted on viewport entry with a WebGL-context cap
so the page handles many strips without going black. A speed slider
(0–2×) lets you frame-step animations. Reachable from the homepage's
options panel via the **[ test renderer ]** button.

## Adding a service card

1. Add a Caddy site block with `header Access-Control-Allow-Origin "https://xiaomyung.com"`
2. Add a `redir /<shortcut> https://<service>.home.arpa permanent` in the `xiaomyung.com` entry-point block
3. Add an `<a class="card">` in the appropriate `<section>` in `index.html` — `href` to the shortcut, `data-check` to the direct URL
4. Bump `?v=N` in the `<link>` tag if `style.css` was touched
5. `sudo systemctl reload caddy`

Not every service deserves a card — the dashboard is a launcher, not a status board. If a service has no UI worth visiting, skip the card.

## Deploying to a homelab

On a fresh clone with Node 22+, Caddy, and systemd available:

```sh
./setup.sh
```

This installs the systemd units for the stats shim and football broker, injects the API reverse-proxy blocks into the Caddyfile, and verifies the endpoints respond.

### Optional: Playwright screenshot tool

The `games/football/debug/screenshot.py` script captures headless screenshots for visual debugging. It requires Python 3 + Playwright:

```sh
python3 -m venv venv
pip install -r requirements.txt
playwright install chromium
```

This is only needed for development — production runs entirely on Node.

## Running tests

```sh
node --test games/football/tests/*.test.mjs
```
