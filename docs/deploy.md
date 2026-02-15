# Deploying Guéridon

## Prerequisites

- Node.js 20+, npm
- Tailscale installed and connected to your tailnet
- Claude Code CLI (`claude`) in PATH

## One-time setup

### 1. Install dependencies and build

```bash
cd ~/Repos/gueridon
npm install
npm run build
```

### 2. Generate VAPID keys for push notifications

```bash
mkdir -p ~/.config/gueridon
node -e "
const wp = require('web-push');
const keys = wp.generateVAPIDKeys();
require('fs').writeFileSync(
  require('path').join(require('os').homedir(), '.config/gueridon/vapid.json'),
  JSON.stringify(keys, null, 2)
);
console.log('VAPID keys written');
"
```

### 3. Set up HTTPS via Tailscale

Guéridon's bridge runs plain HTTP on port 3001. TLS is terminated by `tailscale serve`, which provisions and auto-renews Let's Encrypt certs via your tailnet domain.

```bash
sudo tailscale serve --bg --https=443 http://localhost:3001
```

Verify:
```bash
sudo tailscale serve status
# Should show: https://<hostname>.<tailnet>.ts.net/ → proxy http://localhost:3001

curl -sI https://<hostname>.<tailnet>.ts.net/
# Should show: HTTP/2 200
```

**This is required for Push API** — push notifications need a secure context (HTTPS).

### 4. Install systemd service

```bash
sudo cp gueridon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gueridon
```

## Updating

```bash
cd ~/Repos/gueridon
git pull
npm install
npm run build
sudo systemctl restart gueridon
```

## Verifying push notifications

After deploying, open `https://<hostname>.<tailnet>.ts.net` on your phone:
1. Add to Home Screen (tick "Open as Web App")
2. Open from Home Screen
3. Send a prompt — Safari will ask for notification permission
4. Lock your phone — it should buzz when Claude finishes

Push subscriptions are stored in `~/.config/gueridon/push-subscriptions.json`.

## Architecture

```
Phone (HTTPS) → tailscale serve (TLS termination, :443)
                    → bridge (HTTP, :3001)
                        → claude -p (stdio, per-session)
```

`tailscale serve` handles certs, renewal, and WebSocket upgrade proxying. The bridge never touches TLS.
