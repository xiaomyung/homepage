#!/bin/sh
# Restart all football evolution services and reload Caddy.
set -e

restart_if_active() {
  if systemctl is-active --quiet "$1"; then
    echo "Restarting $1..."
    sudo systemctl restart "$1"
  else
    echo "Skipping $1 (not running)"
  fi
}

restart_if_active football-evolution
restart_if_active football-trainer

echo "Reloading Caddy..."
sudo systemctl reload caddy

echo "Done."
systemctl is-active --quiet football-evolution && echo "  football-evolution: active" || echo "  football-evolution: stopped"
systemctl is-active --quiet football-trainer && echo "  football-trainer: active" || echo "  football-trainer: stopped"
