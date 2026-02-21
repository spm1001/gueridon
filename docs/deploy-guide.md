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

```bash
mkdir -p ~/Repos
git clone https://github.com/spm1001/gueridon.git ~/Repos/gueridon
cd ~/Repos/gueridon
npm install
```

Quick smoke test — bridge should start and complain only about missing VAPID keys:
```bash
npx tsx server/bridge.ts
# Expected: "[push] No VAPID keys ... push disabled"
#           "[bridge] listening on port 3001"
# Ctrl+C to stop
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
> works from within the project directory. Run this from `~/Repos/gueridon`.

## 5. Tailscale HTTPS

The bridge runs plain HTTP on port 3001. Tailscale serve terminates TLS with
auto-provisioned Let's Encrypt certs via your tailnet domain.

```bash
sudo tailscale serve --bg --https=443 http://localhost:3001
```

Verify:
```bash
sudo tailscale serve status
# Should show: https://<hostname>.<tailnet>.ts.net/ → proxy http://localhost:3001
```

> **Required for push notifications.** The Push API needs a secure context (HTTPS).

## 6. Systemd service

```bash
sudo cp ~/Repos/gueridon/gueridon.service /etc/systemd/system/
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

1. Open `https://<hostname>.<tailnet>.ts.net/` on your phone
2. You should see the folder switcher with project folders listed
3. Tap a folder → send a test prompt → verify you get a response
4. When prompted, allow notifications
5. Send another prompt, then lock your phone — you should get a push notification when Claude finishes

### Add to Home Screen (iOS)

For the full app experience: Share → Add to Home Screen → open from there.
This gives you standalone mode (no Safari chrome) and persistent push notifications.

## Updating

```bash
cd ~/Repos/gueridon
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

Fix (runtime):
```bash
sudo resolvectl dns enp1s0f1 8.8.8.8 1.1.1.1
sudo resolvectl domain enp1s0f1 '~.'
```

Fix (persistent, for `/etc/network/interfaces` with DHCP):
```
iface enp1s0f1 inet dhcp
    dns-nameservers 8.8.8.8 1.1.1.1
```
