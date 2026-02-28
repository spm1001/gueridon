#!/usr/bin/env bash
# Deploy gueridon to /opt/gueridon from the current git remote.
# Usage: ./scripts/deploy.sh
set -euo pipefail

DEPLOY_DIR=/opt/gueridon

echo "=== Pulling latest ==="
git -C "$DEPLOY_DIR" pull --ff-only || { echo "Pull failed — check for local changes in $DEPLOY_DIR"; exit 1; }

echo "=== Installing dependencies ==="
cd "$DEPLOY_DIR" && npm install 2>&1 | tail -3

echo "=== Restarting service ==="
sudo systemctl restart gueridon
sleep 3

if systemctl is-active --quiet gueridon; then
  echo "=== Deployed ==="
  git -C "$DEPLOY_DIR" log --oneline -1
else
  echo "=== FAILED — checking logs ==="
  journalctl -u gueridon --no-pager -n 10
  exit 1
fi
