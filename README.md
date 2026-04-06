# homepage

Personal homelab dashboard served at `https://xiaomyung.com` — a static page with live health checks for all self-hosted services.

## Stack

- **Caddy** — serves the static files and reverse-proxies `/api/football/*` to the Flask backend
- **AdGuard Home** — DNS rewrite routes `xiaomyung.com` → `100.68.202.55` (Tailscale IP of the home server) for local and Tailscale-connected devices
- No build step — edit files and reload Caddy

## Running locally (without Caddy)

You can run the dashboard and the football neuroevolution locally with just Python — no Caddy, no DNS rewrite, no services needed. Health-check dots will show "offline" (expected — there are no services to probe), but the football game and AI training work fully.

### Quick start

```sh
# 1. Start the evolution API
cd games/football/api
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py                    # Flask on 127.0.0.1:5050

# 2. In a second terminal, serve the static files from the repo root
python3 -m http.server 5050 -d . # WRONG — port conflict
```

The problem: the JS code fetches `/api/football/*` as a relative path, so the static file server and the API must share the same origin. The easiest way is a tiny reverse proxy script.

### Option A — Python dev server (recommended)

A single-file dev server that serves static files *and* proxies `/api/football` to Flask:

```sh
# Terminal 1 — Flask API
cd games/football/api
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py                    # runs on 127.0.0.1:5050

# Terminal 2 — dev server (from repo root)
python3 dev-server.py            # opens http://localhost:8000
```

Create `dev-server.py` in the repo root (already gitignored patterns cover it, or add it):

```python
"""Minimal dev server: static files + reverse proxy to Flask API."""
import http.server
import urllib.request
import os

API = "http://127.0.0.1:5050"
PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def do_GET(self):
        if self.path.startswith("/api/football"):
            self._proxy()
        else:
            super().do_GET()

    def do_POST(self):
        self._proxy()

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            API + self.path,
            data=body,
            headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
            method=self.command,
        )
        try:
            with urllib.request.urlopen(req) as resp:
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(resp.read())
        except Exception as e:
            self.send_error(502, str(e))

print(f"Dev server at http://localhost:{PORT}")
http.server.HTTPServer(("", PORT), Handler).serve_forever()
```

### Option B — any static file server + browser CORS disabled

If you'd rather use your own static server (Vite, `npx serve`, etc.), run it on any port and launch Chrome with CORS disabled for local dev:

```sh
# macOS
open -na "Google Chrome" --args --disable-web-security --user-data-dir=/tmp/chrome-dev

# Linux
google-chrome --disable-web-security --user-data-dir=/tmp/chrome-dev
```

Then update `API_BASE` in `football.js` and `trainer.js` to `http://127.0.0.1:5050/api/football` (absolute URL).

### What you'll see

- The dashboard loads with all service dots showing **offline** — this is normal without the homelab services
- The football game renders below the dashboard with two ASCII stickmen
- If the Flask API is running, headless training starts automatically in a web worker
- The scoreboard, stats line, and config panel (gear icon) show live evolution progress

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

- Population: 50 brains, tournament selection (k=5), uniform crossover
- Mutation: 5% rate, Gaussian noise (σ=0.3), top 2 elites preserved
- New generation breeds when all brains have played ≥5 matches

### Game Mechanics

- **Stamina:** drains with speed, kicks, and pushes; auto-recovers; low stamina reduces caps
- **Push:** NN-controlled strength; pusher loses stamina, victim loses 2×
- **Kick accuracy:** noise proportional to power — max power = wild shot
- **Headless sims:** randomize field width (600–900px) so brains generalize

### Manual Controls

- **WASD** — movement; **Left click** — kick; **Right click** — push
- **Mobile:** on-screen joystick + kick/push buttons (appears ≤720px)
- Manual mode disables the 120s match timeout

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/football/matchup?count=N` | GET | Get N brain pairs to play |
| `/api/football/result` | POST | Report match outcome |
| `/api/football/best` | GET | Current best brain weights |
| `/api/football/stats` | GET | Generation, fitness, match counts |

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
