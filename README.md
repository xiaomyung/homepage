# homepage

Personal homelab dashboard served at `https://xiaomyung.com` — a static page with live health checks for all self-hosted services.

## Stack

- **Caddy** — serves the static files and reverse-proxies `/api/football/*` to the Flask backend
- **AdGuard Home** — DNS rewrite routes `xiaomyung.com` → `100.68.202.55` (Tailscale IP of the home server) for local and Tailscale-connected devices
- No build step — edit files and reload Caddy

## Running locally (without Caddy)

Requires **Python 3.10+**. Works on Linux, macOS, and Windows.

**Terminal 1 — start the evolution API:**

```sh
cd games/football/api
python3 -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate          # Windows (cmd)
# venv\Scripts\Activate.ps1      # Windows (PowerShell)
pip install -r requirements.txt
python app.py
```

**Terminal 2 — start the dev server (from repo root):**

```sh
python dev-server.py
```

Open **http://localhost:8000**. The dashboard loads with service dots showing "offline" (no homelab services to probe), but the football game and AI training work fully.

`dev-server.py` serves static files and proxies `/api/football/*` to Flask — no Caddy needed.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup, service cards, section layout |
| `style.css` | Monochrome dark theme, responsive grid, animations |
| `app.js` | Health checks via `fetch` (5s timeout, 30s re-check); stagger animation setup; grid overflow capping |
| `games/football/football.js` | ASCII football — visual renderer, manual controls, API client |
| `games/football/engine.js` | DOM-free game physics engine (used for both visual and headless) |
| `games/football/nn.js` | Feedforward neural network (18→20→16→12→9, tanh) |
| `games/football/trainer.js` | Web Worker for background headless training |
| `games/football/api/app.py` | Flask API server for evolution backend |
| `games/football/evolution/ga.py` | Genetic algorithm (selection, crossover, mutation) |
| `games/football/evolution/schema.sql` | SQLite schema for brains and matches |
| `misc/` | Dev assets (screenshots, drafts) — not served |

## Layout

Cards are grouped into `<section class="section">` elements inside a `.sections` flexbox row. Three sections per row on desktop (≥720px), single column on mobile (<720px). Each card has a status dot that turns green/red after probing its `data-check` URL.

Sections with 3+ cards are capped at ~2.2 visible cards with a hidden-scrollbar overflow, so a peek of the next card signals scrollability. `app.js` measures actual card height at runtime and sets `max-height` dynamically on each `.grid`.

## Services

| Category | Service | URL |
|----------|---------|-----|
| Infrastructure | Grafana | `xiaomyung.com/grafana` |
| Infrastructure | AdGuard Home | `xiaomyung.com/dns` |
| Infrastructure | VaultWarden | `xiaomyung.com/vaultwarden` |
| Downloads | qBittorrent | `xiaomyung.com/qbittorrent` |
| Downloads | Prowlarr | `xiaomyung.com/prowlarr` |
| Downloads | Readarr | `xiaomyung.com/readarr` |
| Media | Immich | `xiaomyung.com/immich` |
| Media | Plex | `xiaomyung.com/plex` |
| Media | Kavita | `xiaomyung.com/kavita` |
| Productivity | Open WebUI | `xiaomyung.com/llm` |
| Productivity | Nextcloud | `xiaomyung.com/nextcloud` |
| Dev Tools | Code-server | `xiaomyung.com/code` |
| Dev Tools | IT-Tools | `xiaomyung.com/it-tools` |
| Dev Tools | Stirling PDF | `xiaomyung.com/pdf` |
| Dev Tools | Forgejo | `xiaomyung.com/forgejo` |
| Gaming | Minecraft Panel | `xiaomyung.com/mc` |
| Gaming | BlueMap | `xiaomyung.com/bluemap` |

## Football AI Evolution

The ASCII football game features neural network-controlled players trained via a genetic algorithm. Evolution runs server-side (Python + SQLite); each browser tab acts as a stateless match arena — more tabs = faster evolution.

### Neural Network

- **Architecture:** Input(18) → Hidden(20) → Hidden(16) → Hidden(12) → Output(9)
- **Inputs:** player/opponent positions and velocities, player stamina, ball position/velocity (3D), goal positions, field width
- **Outputs:** movement direction, kick (yes/no + 3D direction + power), push (yes/no + power)
- **Activation:** tanh throughout, outputs scaled to capped physical values

### Genetic Algorithm

- Population: 50 brains, tournament selection (k=3), uniform crossover
- Mutation: 5% base rate, Gaussian noise (σ=0.3), top 2 elites preserved, ~6% random injection
- **Adaptive mutation:** when fitness plateaus over 20 generations, mutation rate and std ramp up to 3× automatically
- **Hall of Fame:** best brain saved every 50 generations; 20% of training matches pit current brains against historical champions
- New generation breeds when all brains have played ≥5 matches

### Fitness

All components normalized to [0, 1] with tunable weights (`W_*` constants in `app.py`):

| Weight | Component | What it rewards |
|--------|-----------|----------------|
| 0.40 | Goals scored | Scoring (goals/3) |
| 0.09 | Attack zone | Ball near opponent's goal |
| 0.08 | Possession | Ticks closer to ball than opponent |
| 0.08 | Goal kicks | Kicks directed at goal |
| 0.07 | Near misses | Shots that barely miss |
| 0.05 | Proximity | Staying close to ball |
| 0.05 | Advance | Moving ball toward goal |
| 0.05 | Frame hits | Hitting the goal post |
| 0.04 | Saves | Defensive clearances near own goal |
| 0.03 | Air kicks | Spectacular aerial kicks |
| 0.03 | Stamina | Managing stamina well |
| −0.05 | Conceded | Goals conceded penalty |
| −0.03 | Exhaustion | Time spent frozen |
| −0.02 | Pushed | Getting pushed penalty |

### Game Mechanics

- **Stamina:** drains with speed, kicks, and pushes; auto-recovers; low stamina reduces caps
- **Push:** NN-controlled strength; pusher loses stamina, victim loses 2×
- **Kick accuracy:** noise proportional to power — max power = wild shot
- **Air kick:** when kickDz output > 0.5, player jumps (height up to 2 text rows, controlled by kickDz). Wider reach than ground kicks, but only connects on airborne balls — air kicking a ground ball = whiff
- **Headless sims:** randomize field width (600–900px) so brains generalize

### Manual Controls

- **WASD** — movement; **Left click** — kick; **Right click** — push
- **Mobile:** on-screen joystick + kick/push buttons (appears ≤720px)
- Manual mode disables the 120s match timeout

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/football/matchup?count=N` | GET | Get N brain pairs to play (75% self-play, 20% HoF, 5% random) |
| `/api/football/results` | POST | Report batch of match outcomes |
| `/api/football/showcase` | GET | Two diverse brains for visual match (40% vs HoF, 30% vs mid-ranked, 20% vs random, 10% HoF vs HoF) |
| `/api/football/best` | GET | Current best brain weights |
| `/api/football/stats` | GET | Generation, fitness, match counts |
| `/api/football/config` | GET/POST | Get or set evolution parameters |
| `/api/football/history` | GET | Fitness history for graphing |
| `/api/football/reset` | POST | Wipe all data and restart |

### Running the Backend

```sh
cd games/football/api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py  # runs on 127.0.0.1:5050
```

In production, Caddy proxies `/api/football/*` to the Flask server. For local development without Caddy, see [Running locally](#running-locally-without-caddy) above.

The SQLite database is auto-created at `games/football/evolution/football.db`. Population state is persisted to `football_persist.db` every 30s.

## Deployment (production)

Requires Caddy as reverse proxy (serves static files and proxies the API). See [Running locally](#running-locally-without-caddy) for development without Caddy.

```sh
# After editing style.css, bump ?v=N in the <link> tag in index.html
# then reload Caddy:
sudo systemctl reload caddy
```

## Adding a service

1. Add a Caddy site block with `header Access-Control-Allow-Origin "https://xiaomyung.com"`
2. Add a redirect shortcut in the `xiaomyung.com` entry-point block
3. Add a `.card` inside the right `<section>` in `index.html` — set `data-check` to the direct `*.home.arpa` URL (`--i` for stagger animation is set automatically by `app.js`)
4. Bump `?v=N` in the `<link>` tag if `style.css` was touched
5. Reload Caddy
