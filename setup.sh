#!/usr/bin/env bash
# Bring-up script for the homepage on a fresh homelab clone.
# Idempotent — re-running re-installs units and re-applies Caddy blocks.
#
# Requires: node (>=22), sudo, systemctl, caddy already installed system-wide.
# Adds:
#   - systemd unit homepage-stats.service     (Node, /api/stats shim)
#   - systemd unit football-evolution.service  (Node, football broker)
#   - Caddyfile blocks for /api/stats* and /api/football/* (if missing)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="/etc/caddy/Caddyfile"

# ── systemd units ─────────────────────────────────────────────────────────────
install_unit() {
  local src="$1"
  local name
  name="$(basename "$src")"
  echo "==> Installing systemd unit ${name}"
  sudo install -m 644 "$src" "/etc/systemd/system/${name}"
}

install_unit "${HERE}/stats/homepage-stats.service"
install_unit "${HERE}/games/football/api/football-evolution.service"

sudo systemctl daemon-reload
sudo systemctl enable --now homepage-stats.service
# Football broker is installed but NOT started by default — training is
# CPU-heavy on the clients it serves, so start manually:
#   sudo systemctl start football-evolution.service

# ── Caddy /api/stats route ────────────────────────────────────────────────────
echo "==> Ensuring /api/stats handle block in ${CADDYFILE}"
NEEDS_RELOAD=0
if sudo python3 - "${CADDYFILE}" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
correct = "\thandle /api/stats* {\n\t\treverse_proxy 127.0.0.1:5055\n\t}\n"
fixed = re.sub(
    r"\thandle /api/stats/?\* \{[^}]*\}\n",
    correct,
    src,
)
if "handle /api/stats" not in fixed:
    fixed = re.sub(
        r"(\thandle /api/football/\* \{[^}]*\}\n)",
        r"\1\n" + correct,
        fixed, count=1,
    )
    if "handle /api/stats" not in fixed:
        sys.exit("could not find /api/football handle block to anchor against")
if fixed != src:
    with open(path, "w") as f:
        f.write(fixed)
    sys.exit(7)
PY
then
  echo "    (no Caddyfile changes)"
else
  rc=$?
  if [ "$rc" -eq 7 ]; then
    NEEDS_RELOAD=1
  else
    exit "$rc"
  fi
fi

if [ "$NEEDS_RELOAD" = "1" ]; then
  sudo systemctl reload caddy
fi

# ── Verify ────────────────────────────────────────────────────────────────────
echo "==> Verifying"
sleep 1
curl -fsS https://xiaomyung.com/api/stats > /dev/null && echo "    /api/stats   OK"
curl -fsS https://xiaomyung.com/api/football/stats > /dev/null 2>&1 && echo "    /api/football OK" || true
echo "==> Done."
