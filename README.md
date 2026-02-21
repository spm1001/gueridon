# Guéridon

*The tableside trolley — bringing the service to you.*

## Status

**Robustness:** Beta — actively developed, architecture stable
**Works with:** Claude Code (as backend), any browser (as client)
**Install:** `npm install && npm start`
**Requires:** Node.js 20+, Claude Code CLI, MAX subscription

A mobile web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Open your phone, pick a project folder, and start a session — Claude Code runs on your server, you interact from wherever you are.

## Why

Claude Code is a terminal application. That's great at a desk, less great from a phone or tablet. Guéridon puts a chat interface in front of Claude Code's streaming JSON protocol, so you can work from any device with a browser.

## Architecture

```
Phone (HTTPS) → tailscale serve (TLS termination)
                    → Node.js bridge (HTTP :3001)
                        → claude -p (stdio, per-folder)
```

Two processes. The **bridge** serves the web UI over HTTP and communicates with the browser via SSE (server→client) and POST (client→server). One CC process per folder, spawned lazily on first prompt.

The **web client** is a single HTML file — CSS, JS, and markup in one place. No framework, no build step, no dependencies. It translates CC's stream-json events into a chat UI with streaming responses, tool call display, thinking blocks, and a context gauge.

### Server modules

| File | Responsibility |
|------|---------------|
| `server/bridge.ts` | HTTP server, SSE transport, process lifecycle |
| `server/bridge-logic.ts` | Pure functions — session resolution, CC arg construction, delta conflation, path validation |
| `server/state-builder.ts` | Pure state machine translating CC stdout events into the frontend state shape |
| `server/folders.ts` | Folder scanning, session discovery, handoff reading |
| `server/push.ts` | Web Push (VAPID) notification delivery |
| `server/fun-names.ts` | Alliterative folder name generator |

## Quick start

```bash
git clone https://github.com/spm1001/gueridon
cd gueridon
npm install
npm start            # Bridge on :3001
```

Open `http://localhost:3001` in a browser. Pick a folder. Start prompting.

```bash
npm test             # 152 tests, <500ms
npm run test:watch   # Watch mode
```

### Remote access

Guéridon is designed for a setup where Claude Code runs on a server and you connect from a phone over Tailscale. `tailscale serve` terminates TLS; the bridge never touches HTTPS.

See [`docs/deploy-guide.md`](docs/deploy-guide.md) for the full walkthrough: Node install, Claude Code configuration, VAPID keys, systemd service, and phone verification.

## Features

- **Dark theme** — designed for late-night phone use
- **Streaming markdown** — hand-rolled block-level parser, chunk updates (not token-level)
- **Collapsible tool calls** — consecutive successful calls coalesce into a single header
- **Push notifications** — know when Claude finishes while your phone is locked
- **Session switcher** — per-folder session list, resume previous sessions
- **Slash command sheet** — send CC commands (`/compact`, `/cost`, `/context`) from the UI
- **AskUserQuestion buttons** — tap to answer when CC asks a question
- **Context gauge** — see how much context window remains

## Key design decisions

- **Lazy spawn** — CC process starts on first prompt, not on connect. No wasted processes.
- **Idle guards** — graduated response to idle sessions: warn, then kill, then resume on reconnect. Prevents orphaned processes consuming MAX seats.
- **SSE + POST** — EventSource for server→client, fetch POST for client→server. Auto-reconnects, stateless transport, no WebSocket complexity.
- **Single HTML file** — no build step, no framework, no vendored components. Edit and reload.
- **No auth** — designed for localhost or Tailscale mesh. Not for the open internet.

## Docs

| Doc | What's in it |
|-----|-------------|
| [`docs/deploy-guide.md`](docs/deploy-guide.md) | First-time install: Node, CC config, VAPID, systemd, Tailscale, phone setup |
| [`docs/decisions.md`](docs/decisions.md) | Architecture decisions with rationale |
| [`docs/kube-brain-mac-body.md`](docs/kube-brain-mac-body.md) | Multi-machine setup with Tailscale |
| [`docs/empirical-verification.md`](docs/empirical-verification.md) | CC stream-json event schemas, verified behaviour |
| [`docs/idle-guards-design.md`](docs/idle-guards-design.md) | Idle guard escalation design |
| [`docs/lifecycle-map.md`](docs/lifecycle-map.md) | Session lifecycle state machine |
| [`server/CC-EVENTS.md`](server/CC-EVENTS.md) | CC event reference for state-builder development |

## Part of the brigade

Guéridon is part of [Batterie de Savoir](https://github.com/spm1001/batterie-de-savoir) — a suite of tools for AI-assisted knowledge work, named for stations in a professional kitchen brigade.
