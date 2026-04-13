# homepage

Personal homelab dashboard served at `https://xiaomyung.com` — a static page with a live infra banner, health checks for every self-hosted service, and an ASCII football game whose players are trained in the background via a neuroevolutionary GA.

The site is Tailscale/LAN-only: AdGuard rewrites `xiaomyung.com` → `100.68.202.55` (Tailscale IP of the home server). The legacy domain `https://home.home.arpa` redirects there.

## Stack

- **Caddy** — serves static files, reverse-proxies `/api/football/*` and `/api/stats*` to the Flask backends
- **AdGuard Home** — the DNS rewrite that keeps the domain local
- No build step — edit files, reload Caddy

## Layout

- **Neofetch-style banner** at the top — every row is a live measurement (time, uptime, load, CPU temp, RAM, `/` + `/storage` + `/cloud` usage, SMART drive temps, Docker container counts). Data comes from `/api/stats`, which `stats/app.py` assembles from node-exporter + `docker ps`.
- **Service cards** grouped into `<section>`s inside a `.sections` flex row — three sections per row on desktop, single column ≤720px. Each card has a status dot driven by `checkService()` in `app.js` (5 s timeout, 30 s re-check, 4xx = online, 5xx = offline).
- **Grid overflow cap** — sections with 3+ cards are capped at ~2.2 visible cards by `capGrids()`; the partial card peek signals scrollability. Scrollbars are hidden.
- **ASCII Schwarzschild lens background** — `games/blackhole/blackhole.js` renders a black hole with a tilted accretion disk and a Keplerian star cluster into a viewport-filling `<pre id="bh-bg">` behind the page.

## Quickstart (local dev)

Requires **Python 3.10+**. On Debian/Ubuntu you may need `sudo apt install python3-venv` first. One shared venv at the repo root is used by every Python service.

```sh
git clone https://github.com/xiaomyung/homepage.git
cd homepage
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Windows notes:** use `py -3` instead of `python3` (the `python3` command doesn't exist on default Windows installs). Activate the venv with `.\venv\Scripts\Activate.ps1` in PowerShell or `venv\Scripts\activate.bat` in `cmd.exe`. PowerShell may need `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once before activation scripts can run.

Then run two processes in parallel:

```sh
# Terminal 1 — evolution API (Flask, 127.0.0.1:5050)
python games/football/api/app.py

# Terminal 2 — dev server (static files + /api/football proxy, :8000)
python dev-server.py
```

Open **http://localhost:8000**. The SQLite population auto-seeds on first launch — no migrations, no fixtures. Service dots show "offline" (no homelab services to probe) and the banner shows `—` for every field (`dev-server.py` doesn't proxy `/api/stats`), but the football game and AI training work fully. The Node.js `server-trainer.js` is optional and only used in production.

## Deployment (production)

On a fresh clone:

```sh
./setup.sh
```

This idempotently:
- builds the shared venv and installs `requirements.txt`
- installs `homepage-stats.service` (enabled, always-on — feeds the banner)
- installs `football-evolution.service` + `football-trainer.service` (installed but **not** started — training is CPU-heavy, start manually with `sudo systemctl start football-evolution football-trainer`)
- injects `/api/stats*` and `/api/football/*` `handle` blocks into `/etc/caddy/Caddyfile` if missing, reloads Caddy

After editing `style.css`, bump `?v=N` in the `<link>` tag in `index.html` so browsers pick up the new CSS, then `sudo systemctl reload caddy`.

`games/football/restart.sh` restarts the Flask API + Node trainer and reloads Caddy in one shot.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Dashboard markup, banner, service cards |
| `style.css` | Monochrome dark theme, responsive grid, animations |
| `app.js` | Health checks, banner updater, stats loader, grid capping |
| `dev-server.py` | Local dev: static files + `/api/football` reverse proxy |
| `setup.sh` | Idempotent production bring-up (venv + units + Caddy) |
| `requirements.txt` | Shared venv deps (Flask + requests) |
| `stats/app.py` | `/api/stats` shim — parses node-exporter, queries Docker |
| `games/blackhole/blackhole.js` | ASCII Schwarzschild lens background |
| `games/football/football.js` | Visual renderer, manual controls, API client |
| `games/football/engine.js` | DOM-free physics engine (shared by visual + headless paths) |
| `games/football/nn.js` | Feedforward NN — 18 → 20 → 16 → 18 → 9, LeakyReLU hidden + tanh output |
| `games/football/trainer.js` | Browser Web Worker headless trainer |
| `games/football/server-trainer.js` | Node.js multi-threaded headless trainer (runs 24/7 via systemd) |
| `games/football/api/app.py` | Flask evolution API (in-memory SQLite, 30 s persist) |
| `games/football/evolution/ga.py` | GA — tournament selection, crossover, mutation, weight decay |
| `games/football/evolution/schema.sql` | SQLite schema |
| `games/football/restart.sh` | Restart API + trainer + reload Caddy |
| `fonts/` | Vendored Iosevka Term woff2 (regular + medium) |
| `misc/` | Dev assets (screenshots, drafts) — not served |

## Services

Seventeen cards across **infrastructure**, **downloads**, **media**, **productivity**, **dev tools**, and **gaming**. Each card links to a `xiaomyung.com/<shortcut>` (Caddy redirects to the direct `*.home.arpa` URL) and health-checks the direct URL. The authoritative list lives in `index.html`.

## Football AI Evolution

Visit the homepage and an ASCII football match plays below the dashboard. Two stickmen compete, both controlled by evolved neural nets. Click anywhere to take over the left player; WASD/arrows move, left click kicks, right click pushes. Evolution runs server-side (Python + SQLite) and is fed matches by the browser Web Worker and an always-on Node.js server trainer.

### Neural network

- **Architecture:** 18 → 20 → 16 → 18 → 9 (LeakyReLU hidden, tanh output)
- **Inputs:** player/opponent positions and velocities, player stamina, ball position/velocity (3D), own/target goal positions, field width
- **Outputs:** movement (2), kick on/off, kick direction (3D), kick power, push on/off, push power
- **Init:** He scaling for LeakyReLU hidden layers, Xavier for the tanh output
- **Why this mix:** fully-tanh networks drifted weights into the saturation zone under unconstrained mutation, pinning outputs at ±1. LeakyReLU on hidden layers doesn't saturate, so selection pressure can actually steer things; tanh stays on the output because the engine relies on [-1, 1] actions.

### Genetic algorithm

- Population 50, tournament selection (k=5), two-point crossover, elitism 5, ~6% random injection
- Mutation: rate 0.10, Gaussian σ=0.10, per-mutation weight decay 0.995 (keeps the AR(1) equilibrium of weight std near He init scale — 0.999 was too gentle and saturated the output tanh)
- **Adaptive mutation:** when top fitness plateaus over 20 generations, rate and σ ramp up to 1.5× automatically
- **Hall of Fame:** best brain snapshotted every 50 generations; 10% of training matches pit current brains against HoF champions. Wiped on `/api/football/reset`.
- New generation breeds once every brain has played ≥5 matches

### Fitness

Range [-1, +1]. Positive and penalty weights each sum to 1.0. The dominant positive term is **goals** (0.40); **kick accuracy** (0.20) is *power-gated* so dribble taps no longer game the reward. The dominant penalties are **goals conceded** and **wasted kicks** (0.30 each). A small **ball-touch floor bonus** (0.05) closes the 0 → 1 kick credit-assignment cliff. Full `W_*` constants in `games/football/api/app.py`.

Previous shape was proximity-first with a heavy exhaustion penalty, which created a do-nothing local optimum around fitness 0.21 that the population converged to. Goals-first + ball-touch floor broke out of it.

### Controls

- **Keyboard:** WASD or arrow keys to move, left click to kick, right click to push
- **Touch (≤720px):** on-screen joystick + `KICK` / `PUSH` buttons
- Entering manual mode disables the 120 s match timeout

### Game mechanics

- **Stamina** drains with speed, kicks, pushes; auto-recovers; low stamina caps movement
- **Push:** NN-controlled strength; pusher loses stamina, victim loses 2×
- **Kick accuracy:** aim noise grows with power — max power = wild shot
- **Air kick:** when `kickDz > 0.5` the player jumps up to 2 rows; wider reach than ground kicks but only connects on airborne balls. Air-kicking a ground ball whiffs and is tracked/penalised.
- **Headless sims** randomize field width (600–900 px) so brains generalize

### API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/football/matchup?count=N` | GET | N brain pairs to play (85% self-play, 10% HoF, 5% random) |
| `/api/football/result` | POST | Report a single match outcome |
| `/api/football/results` | POST | Report a batch of match outcomes |
| `/api/football/showcase` | GET | Two diverse brains for the visual match (40% vs HoF, 30% vs mid-ranked, 20% vs random, 10% HoF vs HoF) |
| `/api/football/best` | GET | Current best brain weights |
| `/api/football/stats` | GET | Generation, fitness, match + trainer counts |
| `/api/football/config` | GET/POST | Evolution parameters |
| `/api/football/history` | GET | Fitness history for graphing |
| `/api/football/reset` | POST | Wipe all data and restart |

SQLite DB is auto-created at `games/football/evolution/football.db`; population state is persisted to `football_persist.db` every 30 s.

## Adding a service card

1. Add a Caddy site block with `header Access-Control-Allow-Origin "https://xiaomyung.com"` (if the service sends its own ACAO, also `header_down -Access-Control-Allow-Origin` inside `reverse_proxy`)
2. Add a `redir /<shortcut> https://<service>.home.arpa permanent` in the `xiaomyung.com` entry-point block
3. Add an `<a class="card">` inside the right `<section>` in `index.html` — `href` to the shortcut form, `data-check` to the direct `*.home.arpa` URL (stagger `--i` is set automatically by `app.js`)
4. Bump `?v=N` in the `<link>` tag if `style.css` was touched
5. `sudo systemctl reload caddy`

Not every service deserves a card: the dashboard is a launcher, not a status board. If a service has no UI worth visiting (e.g. a stateless backend like OnlyOffice Document Server), skip the card and rely on the Docker health check already covered by the daily Telegram digest.
