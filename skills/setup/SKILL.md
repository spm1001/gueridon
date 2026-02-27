---
name: gueridon
description: >
  Mobile web UI for Claude Code — setup, status, and management. Invoke FIRST
  when setting up gueridon on a new machine, checking bridge status, or
  troubleshooting mobile access. Triggers on 'set up gueridon', 'mobile Claude',
  'access from phone', 'check bridge status', 'gueridon status'. (user)
requires:
  - cli: node
    check: "node --version"
  - cli: npm
    check: "npm --version"
---

# Gueridon Setup & Management

Gueridon is a mobile web UI (PWA) that lets you interact with Claude Code from
a phone or tablet. It runs on a Linux server you control; you connect over
Tailscale from any browser.

## Architecture

```
Phone (HTTPS)
  --> tailscale serve (TLS termination, :443)
        --> Node.js bridge (HTTP, :3001)
              --> claude -p --output-format stream-json (stdio, per-folder)
```

**Two processes.** The bridge serves a single-file web UI over HTTP and
communicates with the browser via SSE (server-to-client) and POST
(client-to-server). One CC process per project folder, spawned lazily on first
prompt. Tailscale serve terminates TLS — the bridge never touches HTTPS.

**Key modules** (all in `server/`):

| Module | Role |
|--------|------|
| `bridge.ts` | HTTP server, SSE transport, CC process lifecycle |
| `bridge-logic.ts` | Pure functions — session resolution, CC arg construction, path validation |
| `state-builder.ts` | Translates CC stdout events into the frontend state shape |
| `folders.ts` | Folder scanning, session discovery, handoff reading |
| `orphan.ts` | Orphan CC process reaping after bridge restart |
| `push.ts` | Web Push (VAPID) notification delivery |

## Prerequisites

Before starting, ensure the target machine has:

1. **Debian 12+ (or similar Linux with systemd)** — tested on Debian 13 trixie
2. **Node.js >= 20** — Debian 13 ships this in its repos (`sudo apt-get install nodejs npm`)
3. **npm** — installed alongside Node
4. **Tailscale** — joined to your tailnet, with HTTPS cert provisioning enabled
5. **Claude Code CLI** — installed via `curl -fsSL https://claude.ai/install.sh | bash`, authenticated via `claude auth`
6. **A MAX subscription** — CC process spawns require it

## Setup Workflow

Follow these steps in order on the target server.

### Step 1: Install Node.js and Claude Code

```bash
# Node (Debian 13)
sudo apt-get update && sudo apt-get install -y nodejs npm

# Claude Code
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
claude auth   # interactive — follow the browser OAuth flow
```

### Step 2: Configure Claude Code for bridge use

The bridge spawns CC as a child process. Disable interactive terminal features
that would pollute the stdio event stream.

Merge into `~/.claude.json`:
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

Remove default marketplace plugins (adds startup overhead the bridge doesn't use):
```bash
rm -rf ~/.claude/plugins
```

### Step 3: Clone and install

```bash
mkdir -p ~/Repos
git clone https://github.com/spm1001/gueridon.git ~/Repos/gueridon
cd ~/Repos/gueridon
npm install
```

Smoke test — bridge should start and complain only about missing VAPID keys:
```bash
npx tsx server/bridge.ts
# Expected: "[push] No VAPID keys ... push disabled"
#           "[bridge] listening on port 3001"
# Ctrl+C to stop
```

### Step 4: Generate VAPID keys for push notifications

Push notifications require a VAPID keypair. The bridge reads from
`~/.config/gueridon/vapid.json`.

```bash
mkdir -p ~/.config/gueridon
cd ~/Repos/gueridon
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

Run this from within the gueridon directory — `web-push` is a project
dependency resolved via `node_modules/`.

### Step 5: Configure Tailscale HTTPS

```bash
sudo tailscale serve --bg --https=443 http://localhost:3001
sudo tailscale serve status
# Should show: https://<hostname>.<tailnet>.ts.net/ -> proxy http://localhost:3001
```

HTTPS is required for push notifications (Push API needs a secure context).

### Step 6: Install systemd service

```bash
sudo cp ~/Repos/gueridon/gueridon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gueridon
```

The unit file runs `tsx server/bridge.ts` as user `modha` with
`KillMode=process` — bridge restart does NOT kill CC child processes. They
become orphans; the new bridge reaps them on startup (SIGTERM) and the next
client connection resumes via `--resume`.

### Step 7: Verify from phone

1. Open `https://<hostname>.<tailnet>.ts.net/` on your phone
2. Folder switcher should list project folders
3. Tap a folder, send a test prompt, verify response
4. Allow notifications when prompted
5. Send another prompt, lock phone — push notification should arrive when Claude finishes
6. **iOS:** Share -> Add to Home Screen for standalone PWA mode

## Status Checks

### Bridge health

```bash
sudo systemctl status gueridon        # active (running)?
journalctl -u gueridon -f             # tail live logs
curl -s http://localhost:3001/folders  # should return JSON array
curl -s http://localhost:3001/status   # debug: sessions, memory, recent events
```

### Tailscale HTTPS

```bash
sudo tailscale serve status           # HTTPS proxy active?
```

### Active sessions

The `/status` endpoint returns current sessions, including per-folder CC PIDs,
session IDs, and turn state. Useful for diagnosing stuck or orphaned processes.

Session persistence file: `~/.config/gueridon/sse-sessions.json` — tracks
active CC PIDs so the bridge can reap orphans after restart.

### Push notification state

- VAPID keys: `~/.config/gueridon/vapid.json`
- Active subscriptions: `~/.config/gueridon/push-subscriptions.json`

## Troubleshooting

### Port 3001 already in use

Another bridge instance or process is holding the port:
```bash
lsof -i :3001
# Kill the offending process, then restart
sudo systemctl restart gueridon
```

### VAPID key regeneration

If push notifications stop working (expired subscriptions, key mismatch):
```bash
cd ~/Repos/gueridon
rm ~/.config/gueridon/vapid.json
rm ~/.config/gueridon/push-subscriptions.json
# Re-run the VAPID generation command from Step 4
sudo systemctl restart gueridon
# Re-subscribe from phone (notifications permission prompt will reappear)
```

### TLS certificate issues

Tailscale serve handles cert provisioning and renewal automatically. If HTTPS
stops working:
```bash
sudo tailscale serve status             # is the proxy still registered?
sudo tailscale serve --bg --https=443 http://localhost:3001  # re-register
```

If DNS resolution fails (only tailnet names resolve), check `resolvectl status`
— the fix is upstream in Tailscale DNS settings or router DHCP, not per-machine.

### Orphan CC processes

After a bridge crash, CC child processes may survive. The bridge reaps them
automatically on startup by reading `~/.config/gueridon/sse-sessions.json`
and sending SIGTERM (escalating to SIGKILL after 3 seconds). Processes older
than 24 hours are skipped.

To check manually:
```bash
ps aux | grep 'claude -p'
```

### Bridge restart during active session (self-deployment)

When working on gueridon *from* gueridon, restarting the bridge kills the
bridge, the new bridge reaps the CC process, and the client reconnects with
`--resume`. Chain test and restart in a single Bash call:
```bash
npm test 2>&1 | tail -5 && sudo systemctl restart gueridon
```

Do NOT run test and restart as separate tool calls — the session resumes
between them and the restart intent is lost.

## Session Awareness

Gueridon-spawned CC sessions differ from direct terminal sessions:

| Aspect | Terminal CC | Gueridon CC |
|--------|------------|-------------|
| Input/output | Interactive TTY | `stream-json` via stdio |
| Spawn trigger | User runs `claude` | Lazy on first prompt per folder |
| Session resume | Manual `--resume` | Automatic after bridge restart |
| System prompt | Default | Appended: mobile context, hostname, AskUserQuestion coaching |
| Disallowed tools | None by default | `WebFetch`, `TodoWrite`, `NotebookEdit` |
| Environment | User shell | `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |
| Idle management | None | Idle guards: warn after 5 min, safety cap at 30 min |
| AskUserQuestion | Text prompt | Returns error; user sees tappable buttons in UI |

The bridge sets `--permission-mode default` and loads MCP config from
`~/.claude/settings.json` via `--mcp-config`, so project-level settings and
MCP servers work the same as terminal sessions.

## Updating

```bash
cd ~/Repos/gueridon
git pull
npm install
sudo systemctl restart gueridon
```

After restart, the bridge reaps any orphan CC processes from the previous
instance and clients reconnect automatically via SSE.

## Key Paths

| Path | Purpose |
|------|---------|
| `~/Repos/gueridon/` | Source and working directory |
| `~/.config/gueridon/vapid.json` | VAPID keypair for push |
| `~/.config/gueridon/push-subscriptions.json` | Active push subscriptions |
| `~/.config/gueridon/sse-sessions.json` | CC PID tracking for orphan reaping |
| `/etc/systemd/system/gueridon.service` | Systemd unit (copied from repo) |
