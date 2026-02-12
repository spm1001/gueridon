#!/usr/bin/env bash
# Deploy guéridon to kube.lan
# Usage: scripts/deploy.sh
#
# Pulls latest main, installs deps, builds, installs + restarts systemd service.
# Run from Mac — SSHes into kube to do the work.

set -euo pipefail

HOST="kube.lan"
REMOTE_DIR="/home/modha/Repos/gueridon"

echo "=== Deploying guéridon to $HOST ==="

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
