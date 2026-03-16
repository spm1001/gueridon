# Guéridon Deploy Guide

> Tested on tube (Debian 13 trixie, 2026-02-21).
> A human or Claude should be able to follow this start to finish.

## Prerequisites

- Debian 12+ (or similar Linux with systemd)
- Tailscale joined to your tailnet
- SSH access
- Git installed

## 1. Install Node.js

Debian 13 ships Node 20 in its repos — no third-party source needed.

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm
```

Verify:
```bash
node --version   # v20.x
npm --version    # 9.x
npx --version    # 9.x
```

## 2. Install Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

The installer puts the binary in `~/.local/bin/`. If that's not in your PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify:
```bash
claude --version   # 2.x
```

> **Note:** The bridge's systemd service needs `~/.local/bin` in its `PATH`
> environment line too — see step 6.

### Authenticate Claude Code

This is interactive — run it in a terminal and follow the browser OAuth flow:
```bash
claude auth
```

### Configure Claude Code for bridge use

The bridge spawns CC as a child process. These settings disable interactive
terminal features that would pollute the stdio event stream.

Merge these keys into `~/.claude.json`:
```json
"autoCompactEnabled": false,
"verbose": false,
"autoConnectIde": false,
"fileCheckpointingEnabled": false,
"respectGitignore": false,
"claudeInChromeDefaultEnabled": false
```

Create `~/.claude/settings.json` (required for `--mcp-config` — CC errors on startup if missing):
```bash
echo '{"mcpServers": {}}' > ~/.claude/settings.json
```

Create `~/.claude/settings.local.json`:
```json
{
  "spinnerTipsEnabled": false,
  "prefersReducedMotion": true
}
```

Or set them interactively: `claude` → `/settings` → toggle each one.

### Remove the default marketplace plugins

The installer auto-installs the Anthropic plugin marketplace. The bridge
doesn't use plugins and they add startup overhead.

```bash
rm -rf ~/.claude/plugins
```

To prevent re-installation, ensure `~/.claude.json` has:
```json
"officialMarketplaceAutoInstalled": false,
"officialMarketplaceAutoInstallAttempted": true
```

> **Why disable auto-compact?** The bridge tracks context usage via the
> `/context` endpoint and surfaces it in the UI. Auto-compaction happening
> silently behind the bridge's back confuses the context gauge.

## 3. Clone and install

Production runs from `/opt/gueridon`. Development happens in `~/Repos/gueridon`.

```bash
# Production checkout
sudo mkdir -p /opt/gueridon && sudo chown $USER:$USER /opt/gueridon
git clone https://github.com/spm1001/gueridon.git /opt/gueridon
cd /opt/gueridon
npm install
```

Quick smoke test — bridge should start and complain only about missing VAPID keys:
```bash
npx tsx server/bridge.ts
# Expected: "[push] No VAPID keys ... push disabled"
#           "[bridge] listening on port 3001"
# Ctrl+C to stop
```

Optionally, clone a separate development copy:
```bash
mkdir -p ~/Repos
git clone https://github.com/spm1001/gueridon.git ~/Repos/gueridon
```

## 4. VAPID keys for push notifications

Push notifications require a VAPID keypair. The bridge looks for it at
`~/.config/gueridon/vapid.json`.

```bash
mkdir -p ~/.config/gueridon
node -e "
  const wp = require('web-push');
  const keys = wp.generateVAPIDKeys();
  require('fs').writeFileSync(
    require('os').homedir() + '/.config/gueridon/vapid.json',
    JSON.stringify(keys, null, 2)
  );
  console.log('VAPID keys written to ~/.config/gueridon/vapid.json');
"
```

> **Note:** `web-push` is a dependency of gueridon, so `require('web-push')`
> works from within the project directory. Run this from `/opt/gueridon`.

## 5. Tailscale HTTPS

The bridge runs plain HTTP on port 3001. Tailscale serve terminates TLS with
auto-provisioned Let's Encrypt certs via your tailnet domain.

### Dedicated port (recommended if sharing a hostname)

If another service (e.g. Open WebUI, Grafana) also uses `tailscale serve` on the
same machine, give Guéridon its own HTTPS port so the two can never conflict.
Updates to the other app can't reclaim Guéridon's URL:

```bash
sudo tailscale serve --bg --https=8443 http://localhost:3001
```

Guéridon will be at `https://<hostname>.<tailnet>.ts.net:8443/`.

Set matching env vars in `gueridon.service`:
```ini
Environment=TAILSCALE_HOSTNAME=your-machine.your-tailnet.ts.net
Environment=TAILSCALE_PORT=8443
```

### Single service (port 443)

If Guéridon is the only `tailscale serve` consumer on the machine, use the
default port instead and omit `TAILSCALE_PORT` from the service file:

```bash
sudo tailscale serve --bg --https=443 http://localhost:3001
```

Guéridon will be at `https://<hostname>.<tailnet>.ts.net/`.

### Verify

```bash
sudo tailscale serve status
# Dedicated port: https://<hostname>.<tailnet>.ts.net:8443/ → proxy http://localhost:3001
# Default port:   https://<hostname>.<tailnet>.ts.net/      → proxy http://localhost:3001
```

> **Required for push notifications.** The Push API needs a secure context (HTTPS).

## 6. Systemd service

First, find your Tailscale hostname:
```bash
sudo tailscale serve status   # first line: https://<hostname>.<tailnet>.ts.net
```

Run the interactive configure script — it auto-detects your Tailscale hostname and writes `~/.config/gueridon/env`:

```bash
npm run configure
```

Then install:
```bash
sudo cp /opt/gueridon/gueridon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gueridon
```

Verify:
```bash
sudo systemctl status gueridon
# Should show: active (running)
# Logs should show: "[push] VAPID configured" and "[bridge] listening on port 3001"
```

Check logs if it fails:
```bash
sudo journalctl -u gueridon --no-pager -n 30
```

## 7. Verify from phone

1. Open `https://<hostname>.<tailnet>.ts.net:8443/` (or `:443/` if not using a dedicated port) on your phone
2. You should see the folder switcher with project folders listed
3. Tap a folder → send a test prompt → verify you get a response
4. When prompted, allow notifications
5. Send another prompt, then lock your phone — you should get a push notification when Claude finishes

### Add to Home Screen (iOS)

For the full app experience: Share → Add to Home Screen → open from there.
This gives you standalone mode (no Safari chrome) and persistent push notifications.

## Updating

```bash
cd /opt/gueridon
git pull
npm install
sudo systemctl restart gueridon
```

## Architecture

```
Phone (HTTPS) → tailscale serve (TLS termination, :443)
                    → bridge (HTTP, :3001)
                        → claude -p (stdio, per-folder)
```

`tailscale serve` handles certs and renewal. The bridge never touches TLS.
Push subscriptions are stored in `~/.config/gueridon/push-subscriptions.json`.

## Troubleshooting

### DNS not resolving public names

If `apt-get update` fails with "Temporary failure resolving", your machine
may only have Tailscale's MagicDNS (100.100.100.100) configured — which only
resolves tailnet names.

Check: `resolvectl status` — look for a physical interface with DNS servers.

The fix is upstream: configure your Tailscale DNS settings or router DHCP to
hand out public DNS servers. This ensures all tailnet machines get working
DNS without per-machine hacks.

### CORS rejections / stuck on "resuming"

Symptom: folders load but tapping a folder gets stuck on "resuming". Bridge logs show `request:rejected` with `reason: cors-origin`.

**Cause 1: wrong URL on the phone.** The bridge only accepts the Tailscale HTTPS URL. If you navigate to `http://clawdbot.tail8553f1.ts.net:3001` (direct HTTP, port 3001) instead of `https://clawdbot.tail8553f1.ts.net` (HTTPS, no port), every POST is rejected. Use the URL from `sudo tailscale serve status` — HTTPS, no port.

**Cause 2: `TAILSCALE_HOSTNAME` not set.** The bridge defaults to `tube.atlas-cloud.ts.net`. Set your actual hostname in the service file:

```ini
Environment=TAILSCALE_HOSTNAME=your-machine.your-tailnet.ts.net
```

Find your hostname: `sudo tailscale serve status` (first line, strip `https://`).

After editing: `sudo systemctl daemon-reload && sudo systemctl restart gueridon`.

Verify the env var was picked up: `sudo systemctl show gueridon | grep Environment`.

### Reboot verification

After install, reboot the machine and verify everything comes back:
```bash
sudo systemctl status gueridon          # should be active (running)
sudo tailscale serve status             # should show HTTPS proxy
curl -s http://localhost:3001/folders    # should return JSON
```

If DNS broke again, check with `resolvectl status` — the fix is upstream
(Tailscale DNS settings or router DHCP), not per-machine.
