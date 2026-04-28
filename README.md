# homepage

Personal homelab dashboard — a static page with a live infra banner, health-check dots for every self-hosted service, an ASCII Schwarzschild black hole background, and a football mini-game where two deterministic AI stickmen play continuous live matches.

## Running locally

**Prerequisites:** [Node.js 22+](https://nodejs.org/) (the only dependency).

### 1. Clone and start

```sh
git clone https://github.com/xiaomyung/homepage.git
cd homepage
```

Single terminal:

```sh
node dev-server.mjs
```

Open **http://localhost:8000**.

### 2. What to expect locally

- **Service cards** show as offline — the health checks probe `*.home.arpa` domains that only resolve on the homelab. This is expected.
- **Banner** shows `—` for every field — the stats endpoint needs node-exporter and Docker, which aren't present locally. This is expected.
- **Football game** works fully — pure client-side controller-vs-controller showcase matches loop continuously.
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
| `dev-server.mjs` | Local dev: static files + `/api/stats` proxy |
| `setup.sh` | Idempotent production bring-up (systemd unit + Caddy) |
| `requirements.txt` | Optional: Playwright for the headless screenshot dev tool |
| `stats/app.mjs` | `/api/stats` shim — parses node-exporter metrics + Docker status |
| `stats/homepage-stats.service` | systemd unit for the stats shim |
| `games/blackhole/blackhole.js` | ASCII Schwarzschild lens background animation |
| `games/football/main.js` | Football game entry point |
| `games/football/physics.js` | Headless physics engine (DOM-free, pure math) |
| `games/football/renderer.js` | Three.js 3D renderer (pooled capsule + sphere meshes, name labels, role dots) |
| `games/football/animation/` | Pure animation pipeline: state.js + poses.js + curves.js + sampler |
| `games/football/ai/controller.js` | Public seam: `decide(state, side) → Float64Array(9)` |
| `games/football/ai/perception.js` | Pure: state → situational facts |
| `games/football/ai/decision.js` | Pure: facts + role hysteresis → tactical intent |
| `games/football/ai/action.js` | Pure: intent → 9-float action vector |
| `games/football/ai/tuning.js` | All controller tunables in one file |
| `games/football/ai/names.js` | Footballer-name pool, seeded picker |
| `games/football/ui.js` | Scoreboard (role dots, names, score, timer), camera toggles |
| `games/football/tests/` | Node test runner tests — physics, ai/*, animation/*, frame-loop, stamina |
| `games/football/debug/` | Dev tools: test-renderer harness, Playwright screenshot scripts |
| `fonts/` | Vendored Iosevka Term woff2 (regular + medium) |

Three.js is loaded from a pinned `unpkg` CDN URL in `renderer.js` —
no vendored copy.

## Football scrimmage

Below the dashboard, two stickmen play continuous 30 s matches. The
controller is fully deterministic — pure-press behaviour with role
hysteresis, asymmetric goalie reflex, and per-side personality
seeded from each match's seed.

### Architecture

- **Controller pipeline** (under `games/football/ai/`):
  `perception.js` → `decision.js` → `action.js` → 9-float action
  vector. `controller.js` exports the public `decide(state, side)`
  seam; all constants live in `tuning.js`. Pure functions — the
  only mutated state is `state.aiRoleState[side]` for role hysteresis.
- **Inputs:** read directly off the public physics state (player
  positions/velocities, ball state, stamina, pause flags, field
  geometry). No NN-style sensor encoder, no normalised feature
  vector — situational facts are derived in `perception.js`.
- **Outputs:** movement (2D), kick toggle + direction (3D) + power,
  push toggle + power. Same 9-slot vector the physics engine
  consumed under the old NN pipeline.
- **Animation:** purely derived — `animation/state.js` advances LPF
  factors + phase, `animation/poses.js` composes a layered pose;
  physics state is never written from the animation layer.
- **Future learning:** the controller seam is a single function
  signature. A future learned policy ships as another module that
  exports the same `decide(state, side) → Float64Array(9)` and
  swaps in via one import.

### Controls

- **[ options ]** — toggles the panel: freecam + follow-ball
  toggles, test-renderer link.
- The **[ start ] / [ stop ] / [ reset ]** buttons in the panel
  are stubs — they sit in the DOM as layout placeholders for when
  learning gets re-introduced; clicking does nothing today.

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
4. Reload Caddy

Not every service deserves a card — the dashboard is a launcher, not a status board. If a service has no UI worth visiting, skip the card.

## Deploying to a homelab

On a fresh clone with Node 22+, Caddy, and systemd available:

```sh
./setup.sh
```

This installs the systemd unit for the stats shim, ensures the `/api/stats` reverse-proxy block exists in the Caddyfile, and verifies the endpoint responds. The football page is fully client-side — no server piece to install for it.

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
