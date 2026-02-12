#!/usr/bin/env bash
# Deploy guéridon to kube.lan
# Usage: scripts/deploy.sh
#
# Pulls latest main, installs deps, builds, installs + restarts systemd service.
# Run from Mac — SSHes into kube to do the work.

set -euo pipefail

HOST="kube.lan"
REMOTE_DIR="/home/modha/Repos/gueridon"

# Guard: don't deploy unpushed changes
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Uncommitted changes. Commit first." >&2
  exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "ERROR: Local HEAD ($LOCAL) != origin/main ($REMOTE). Push first." >&2
  exit 1
fi

echo "=== Deploying guéridon to $HOST ($(git log -1 --format='%h %s')) ==="

ssh "$HOST" bash -s "$REMOTE_DIR" << 'DEPLOY'
set -euo pipefail
REMOTE_DIR="$1"
cd "$REMOTE_DIR"

echo "--- Pulling latest ---"
git pull --ff-only

echo "--- Installing dependencies ---"
npm install

echo "--- Building ---"
npm run build

echo "--- Installing service ---"
sudo cp gueridon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gueridon

echo "--- Restarting ---"
sudo systemctl restart gueridon
sleep 2

echo "--- Status ---"
sudo systemctl status gueridon --no-pager

echo "=== Done ==="
DEPLOY
