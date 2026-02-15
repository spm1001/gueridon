# Guéridon

*The tableside trolley — bringing the service to you.*

## Status

**Robustness:** Beta — actively developed, architecture stable
**Works with:** Claude Code (as backend), any browser (as client)
**Install:** `npm install && npm run start`
**Requires:** Node.js 20+, Claude Code CLI, MAX subscription

A mobile web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Open your phone, pick a project folder, and start a session — Claude Code runs on your server, you interact from wherever you are.

## Why

Claude Code is a terminal application. That's great at a desk, less great from a phone or tablet. Guéridon puts a chat interface in front of Claude Code's streaming JSON protocol, so you can work from any device with a browser.

## Architecture

```
Phone/Browser → WebSocket → Node.js bridge (:3001) → claude -p (stream-json)
```

Two processes. The **bridge** (`server/bridge.ts`) serves the web UI and proxies WebSocket connections to Claude Code processes. One CC process per session, spawned lazily on first prompt.

The **web client** is a Lit-based SPA that translates CC's stream-json events into a chat UI with streaming responses, tool call display, thinking blocks, and a context gauge.

There's also a **CLI client** (`cli/gdn.ts`) that connects to the same bridge from a terminal — same protocol, different renderer. Useful for working from a Mac while CC runs on a remote server.

## Quick start

```bash
git clone https://github.com/spm1001/gueridon
cd gueridon
npm install
npm run start        # Build + launch bridge on :3001
```

Open `http://localhost:3001` in a browser. Pick a folder. Start prompting.

### Development

```bash
npm run dev          # Vite HMR on :5173
npm run bridge       # Bridge on :3001 (separate terminal)
npm test             # 322 tests, ~1.5s
```

### Remote access (Kube + phone)

Guéridon is designed for a setup where Claude Code runs on a server (e.g., a Debian box) and you connect from a phone or another machine. See `docs/kube-brain-mac-body.md` for the full Tailscale-based architecture.

## Key design decisions

- **Lazy spawn** — CC process starts on first prompt, not on connect. No wasted processes.
- **Idle timeout** — 5 min idle → kill process → `--resume` on reconnect. Cheap session parking.
- **No auth** — designed for localhost or Tailscale mesh. Not for the open internet.
- **Vendored UI components** — 6 components from [pi-mono](https://github.com/nicohman/pi-mono) for message display. Our own leaf renderers. No heavy transitive deps.
- **Client-agnostic protocol** — the bridge doesn't know or care what's consuming its WebSocket. Web UI, CLI client, or something else — same wire format.

## Docs

| Doc | What's in it |
|-----|-------------|
| `docs/architecture-and-review.md` | Full file map, component nesting, dep table, build pipeline, 23-finding code review |
| `docs/bridge-protocol.md` | WebSocket message types, session lifecycle, reliability |
| `docs/decisions.md` | Architecture decisions with rationale |
| `docs/kube-brain-mac-body.md` | Multi-machine setup with Tailscale |
| `docs/empirical-verification.md` | CC stream-json event schemas, verified against CC 2.1.37 |

## Part of the brigade

Guéridon is part of [Batterie de Savoir](https://github.com/spm1001/batterie-de-savoir) — a suite of tools for AI-assisted knowledge work, named for stations in a professional kitchen brigade.
