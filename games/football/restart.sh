#!/bin/sh
# Restart all football evolution services and reload Caddy.
set -e

echo "Restarting football-evolution (Flask API)..."
sudo systemctl restart football-evolution

echo "Restarting football-trainer (headless trainer)..."
sudo systemctl restart football-trainer

echo "Reloading Caddy..."
sudo systemctl reload caddy

echo "Done."
systemctl is-active --quiet football-evolution && echo "  football-evolution: active" || echo "  football-evolution: FAILED"
systemctl is-active --quiet football-trainer && echo "  football-trainer: active" || echo "  football-trainer: FAILED"
