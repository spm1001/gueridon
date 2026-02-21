# Guéridon

Mobile web UI for Claude Code. Single HTML file, no framework, no build step.

## Architecture

```
Phone browser → HTTP → Node.js bridge → claude -p (stream-json) → MAX subscription
```

One HTML file (`index.html`) served by the bridge. SSE for live events, POST for commands. Process-per-session with `--session-id <uuid>`, resume via `--resume` after process kill.

## Running

```bash
npm start                    # Start bridge on port 3001
BRIDGE_PORT=3002 npm start   # Override port
npm test                     # Run all tests (~200 tests, <1s)
npm run test:watch           # Watch mode
```

Phone URL: `https://kube.atlas-cloud.ts.net/` (Tailscale HTTPS termination).

### Design iteration (brisk-bear repo)

The UI is designed in the `brisk-bear` repo using static state.json files and passe screenshots. When the design is ready, `index.html` is copied here. See `brisk-bear/CLAUDE.md` for the iteration loop.

## Deployment

Runs on **kube** (Debian Linux, Tailscale). Single systemd service.

```bash
sudo systemctl restart gueridon    # Restart bridge
sudo systemctl status gueridon     # Check health
journalctl -u gueridon -f          # Tail logs
```

- **`KillMode=process`** — bridge restart does NOT kill CC child processes. They become orphaned; the new bridge reaps them on startup (SIGTERM) and the next client connection resumes via `--resume`.
- **HTTPS terminated by `tailscale serve`** — bridge listens on HTTP :3001.
- **VAPID keys** for push notifications live at `~/.config/gueridon/vapid.json`.
- **Session persistence** — `~/.config/gueridon/sessions.json` tracks active CC PIDs so the bridge can reap orphans after restart.

See `docs/deploy.md` for VAPID key setup, Tailscale plumbing, and first-time install.

## Bridge Server

`server/bridge.ts` — HTTP server that serves the frontend and manages CC processes.

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve index.html |
| GET | `/events` | SSE stream (hello, folders, state, delta, ping) |
| GET | `/folders` | List available project folders |
| POST | `/session/:folder` | Connect to a folder's CC session |
| POST | `/prompt/:folder` | Send prompt (or queue if busy) |
| POST | `/abort/:folder` | SIGTERM the CC process |
| POST | `/exit/:folder` | Deliberate session close |
| POST | `/push/subscribe` | Register push subscription |
| POST | `/push/unsubscribe` | Remove push subscription |

**Key design:**
- **SSE + POST:** EventSource for server→client events, fetch POST for client→server commands. Auto-reconnects, stateless transport.
- **StateBuilder** (`server/state-builder.ts`): Pure state machine translating CC stdout events into the BB state shape. Emits SSE deltas during streaming, full state snapshots at turn end.
- **Delta conflation:** Text deltas accumulated and flushed on timer (not per-token). Reduces SSE traffic without visible latency.
- **Static serving:** index.html, sw.js, manifest.json, icons — no-cache headers, same port as API.
- **Lazy spawn:** CC process starts on first prompt, not on connect.
- **SIGTERM → SIGKILL:** 3s escalation on all process kills.
- **Orphan reaping:** On startup, reads sessions.json, SIGTERMs any live CC processes from the previous bridge instance.

## CC Process Flags

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --session-id <uuid> \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions
```

- `--verbose` is mandatory for stream-json mode.
- **Local commands (`/context`, `/cost`, `/compact`) produce NO stdout.** Bridge reads JSONL tail on empty-result turns to recover output.
- **Input format** (critical): `{"type":"user","message":{"role":"user","content":"..."}}`
- `--dangerously-skip-permissions` is still in use. Permission model review pending (bb-mecebe).

## Frontend

Single HTML file: CSS, HTML, JS — no splitting, no build, no dependencies.

- Dark theme only
- Hand-rolled block-level markdown parser
- Collapsible tool calls (consecutive successful calls coalesce)
- Enter never submits (mobile newlines), submit is the button
- Chunk-level updates (not token-level)
- Session switcher with per-folder session list
- Push notifications via service worker

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/deploy.md` | Deployment guide — systemd, Tailscale, VAPID keys |
| `docs/empirical-verification.md` | Verified CC event schemas, edge cases, abort mechanisms |
| `server/CC-EVENTS.md` | CC event reference for state-builder development |
