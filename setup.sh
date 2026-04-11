#!/usr/bin/env bash
# Bring-up script for the entire homepage on a fresh clone.
# Idempotent — re-running rebuilds the venv, re-installs services, and re-applies
# Caddyfile snippets.
#
# Requires: python3, sudo, systemctl, caddy already installed system-wide.
# Adds:
#   - Single shared venv at homepage/venv/ (used by stats and football APIs)
#   - systemd unit homepage-stats.service     (Python, this repo)
#   - systemd unit football-evolution.service (Python, this repo)
#   - systemd unit football-trainer.service   (Node.js, this repo)
#   - Caddyfile blocks for /api/stats/* and /api/football/* (if missing)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="/etc/caddy/Caddyfile"

# ── Python venv ───────────────────────────────────────────────────────────────
echo "==> Building shared Python venv at ${HERE}/venv"
python3 -m venv "${HERE}/venv"
"${HERE}/venv/bin/pip" install --quiet --upgrade pip
"${HERE}/venv/bin/pip" install --quiet -r "${HERE}/requirements.txt"

# ── systemd units ─────────────────────────────────────────────────────────────
install_unit() {
  local src="$1"
  local name
  name="$(basename "$src")"
  echo "==> Installing systemd unit ${name}"
  sudo install -m 644 "$src" "/etc/systemd/system/${name}"
}

install_unit "${HERE}/stats/homepage-stats.service"
# Football units are refreshed (so the shared-venv path stays in sync) but NOT
# started/restarted here — training is CPU-heavy and the operator decides when
# to run it. Use:  sudo systemctl start football-evolution football-trainer
install_unit "${HERE}/games/football/api/football-evolution.service"
install_unit "${HERE}/games/football/api/football-trainer.service"

sudo systemctl daemon-reload
sudo systemctl enable --now homepage-stats.service

# ── Caddy /api/stats route ────────────────────────────────────────────────────
# Note the wildcard pattern: /api/stats* (no slash before *) matches both
# /api/stats and /api/stats/anything. /api/stats/* would NOT match /api/stats.
echo "==> Ensuring /api/stats handle block in ${CADDYFILE}"
NEEDS_RELOAD=0
if sudo python3 - "${CADDYFILE}" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
correct = "\thandle /api/stats* {\n\t\treverse_proxy 127.0.0.1:5055\n\t}\n"
# (1) replace any prior wrong pattern in place
fixed = re.sub(
    r"\thandle /api/stats/?\* \{[^}]*\}\n",
    correct,
    src,
)
# (2) if no /api/stats block exists at all, inject right after /api/football block
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
    sys.exit(7)  # signal "changed" to the bash side
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
curl -fsS https://xiaomyung.com/api/football/health > /dev/null 2>&1 && echo "    /api/football OK" || true
echo "==> Done."
