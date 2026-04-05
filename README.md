# homepage

Personal homelab dashboard served at `https://xiaomyung.com` — a static page with live health checks for all self-hosted services.

## Stack

- **Caddy** — serves the static files and proxies to each service
- **AdGuard Home** — DNS rewrite routes `xiaomyung.com` → `100.68.202.55` (Tailscale IP of the home server) for local and Tailscale-connected devices
- No build step — edit files and reload Caddy

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup, service cards, section layout |
| `style.css` | Monochrome dark theme, responsive grid, animations |
| `app.js` | Health checks via `fetch` (5s timeout, 30s re-check); stagger animation setup; grid overflow capping |
| `football.js` | ASCII football mini-game — two AI stickmen on a pitch below the dashboard; mouse controls player 1, click/tap to kick |
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

## Deployment

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
