# Kube as Brain, Mac as Body

## The Problem

Two machines, same repos, same user. Mac is primary for local work. Kube (Debian box) runs Gueridon for phone-based Claude Code sessions. Moving between them means either syncing files (piranha bites from OS differences, git corruption risk, `.arc/` conflicts) or losing context.

## The Insight

The problem isn't file sync. It's session mobility. And the answer isn't making two machines identical — it's making one machine the brain and letting the other be a viewport.

**Kube is the source of truth.** All code lives there. All CC processes run there. Mac provides the human interface — screen, browser, editor, keyboard.

## Architecture

```
┌─── Mac ───────────────────────────────────────────┐
│                                                    │
│  Terminal ──► CLI bridge client ──────────────────────► ws://kube:3001
│                                                    │        │
│  Chrome Debug :9222 ──► tailscale serve 9222  ◄────────── webctl (CC on Kube)
│                                                    │
│  Sublime/Editor ──► Taildrive mount ◄──────────────────── kube:~/Repos/
│                                                    │
│  Browser ──► https://kube.ts.net (dev servers) ◄───────── tailscale serve
│                                                    │
└────────────────────────────────────────────────────┘
                    │ Tailscale mesh │
┌─── Kube ──────────────────────────────────────────┐
│                                                    │
│  Gueridon bridge :3001 ──► CC process ──► ~/Repos/ │
│                                                    │
│  webctl ──► sameers-m4:9222 (Mac's Chrome via TS)  │
│                                                    │
│  tailscale drive share repos ~/Repos               │
│                                                    │
│  tailscale serve (dev servers as needed)            │
│                                                    │
└────────────────────────────────────────────────────┘
                    │ Tailscale mesh │
┌─── Phone ─────────────────────────────────────────┐
│                                                    │
│  Gueridon web UI ──► kube:3001                     │
│                                                    │
└────────────────────────────────────────────────────┘
```

## Why Not Sync?

We explored and rejected several approaches:

| Approach | Why Not |
|----------|---------|
| **Syncthing** | Two-way file sync + `.git/` directories = corruption risk. Even with `.stignore`, working tree sync across OSes invites permission/line-ending/case-sensitivity bites |
| **Git as relay** (commit → push → pull) | Safe for committed code, but dirty working state doesn't travel. Requires ceremony ("park" before switching). Kills mid-session mobility |
| **CC Teleport** (`& prefix` / `/tp`) | One-way only (cloud → local). Runs on Anthropic's sandboxed infrastructure, not Kube. The whole point of Gueridon is escaping that sandbox |
| **Mutagen** | Designed for this problem but adds a new daemon, new conflict model, new failure mode. Unnecessary if there's only one copy |

## Why Tailscale Does It All

Three Tailscale features replace three separate tools:

| Need | Tool It Replaces | Tailscale Feature |
|------|-----------------|-------------------|
| Mac editor access to Kube files | SSHFS | **Taildrive** — WebDAV share, Finder-native on Mac |
| CC controlling Mac's browser | SSH tunnel for CDP port | **`tailscale serve`** — expose Chrome's :9222 to tailnet |
| Browsing Kube dev servers from Mac | SSH port forwarding | **`tailscale serve`** — expose dev server ports to tailnet |

No SSH tunnels. No SSHFS. No third-party daemons. Just Tailscale, which is already running on both machines.

## The Bridge Protocol Is Already Client-Agnostic

Gueridon's bridge speaks SSE (server→client) + POST (client→server). It doesn't know or care what's on the other end. The endpoints (see `CLAUDE.md`) cover:

- `GET /folders` / `GET /events` — discover projects, receive live state
- `POST /session/:folder` — join a session
- `POST /prompt/:folder` — send a message
- SSE events — state snapshots, deltas, folder updates

A CLI client connects via the same HTTP endpoints, sends the same POSTs, receives the same SSE events. The bridge needs zero changes to support it.

### What The Bridge Must NOT Do

As the state machine gets simplified, avoid baking in browser assumptions:

- Don't assume clients render HTML/markdown (send raw, let client decide)
- Don't assume clients have a mouse (no hover-dependent interactions)
- Don't assume one client type per session (phone + terminal could coexist)
- Don't add client-type negotiation — the protocol is already universal

## The CLI Bridge Client

The only thing to build. A terminal program on Mac that connects to the Gueridon bridge and provides a CC-like experience.

### Core Features

1. **Connect to bridge** — `https://kube:3001` (or Tailscale hostname)
2. **Folder picker** — `GET /folders` → display → user picks → `POST /session/:folder`
3. **Prompt loop** — read input → `POST /prompt/:folder` → stream SSE events → render
4. **Context gauge** — always-visible fuel bar from usage data in result events. The one thing Anthropic won't build.
5. **Streaming** — render text token-by-token, show tool calls in progress
6. **AskUserQuestion** — detect in stream, render options, user picks one, send as next prompt

### Nice-To-Have

- Markdown rendering in terminal (via glow, rich, or similar)
- Syntax-highlighted code blocks
- Image display (iTerm2/Kitty image protocol for screenshots CC takes)
- Vim keybindings for input
- Session list / resume picker
- `/close` and other slash commands passed through as prompts

### What It Inherits For Free

Because CC runs on Kube, the CLI client automatically gets:
- All MCP servers configured on Kube
- All hooks configured on Kube
- All skills (via text prompts — `/close`, `/open`, etc.)
- Session persistence (JSONL on Kube's disk)
- `--dangerously-skip-permissions` (Gueridon's model)

### What It Can't Do (Yet)

- **Image upload** — would need: client reads local file → base64 → sends via POST → bridge adds to CC's input. Requires bridge protocol extension.
- **`@` file mentions** — references local Mac files. Would need path translation or Taildrive-relative paths. Complex, defer.
- **IDE integration** — VS Code on Mac can't talk to CC on Kube through the bridge. Use VS Code Remote-SSH to Kube directly if needed.

## Tailscale Setup

### Taildrive (File Access)

On Kube:
```bash
tailscale drive share repos /home/modha/Repos
```

On Mac, mount via Finder: Connect to Server → `http://100.100.100.100:8080/ts-domain/kube/repos`

Or via CLI:
```bash
# macOS mounts WebDAV natively
mount_webdav http://100.100.100.100:8080/ts-domain/kube/repos /Volumes/kube-repos
```

### Chrome CDP (Browser Control)

On Mac:
```bash
tailscale serve --bg 9222
```

On Kube, update webctl config to point at Mac's Tailscale hostname:
```json
{"cdp_endpoint": "http://sameers-macbook-air.tail-xyz.ts.net:9222"}
```

Note: `sameers-m4` has been offline for 140 days. The active Mac is `sameers-macbook-air`. Verify which is current and update accordingly.

### Dev Servers

On whichever machine runs the dev server:
```bash
tailscale serve --bg 5173  # or whatever port
```

Browse from the other machine via Tailscale hostname.

### ACL Considerations

Tailscale ACLs need to allow:
- Kube → Mac on port 9222 (CDP)
- Mac → Kube on port 3001 (bridge) and 8080 (Taildrive)
- Both → each other on dev server ports as needed

Check current ACL policy and ensure `drive:share` and `drive:access` node attributes are set.

## What This Means For Gueridon

The bridge is now serving two client types: the web UI (phone/desktop browser) and the CLI client (Mac terminal). This is fine — the SSE+POST protocol is already agnostic. But keep it that way:

1. **No client-type field in the protocol.** Clients don't identify themselves. They don't need to.
2. **Rendering is client-side.** The bridge sends state snapshots and deltas via SSE. How they're displayed is the client's problem.
3. **State machine stays simple.** A session is a session regardless of what's consuming it.
4. **Image upload (when built) goes through the bridge protocol.** Both clients will want it eventually. Design the protocol extension once, both clients use it.

> **Note (2026-02):** The CLI client (`cli/bridge-client.ts`, `cli/gdn.ts`) was built for the old WebSocket protocol and is currently stale — it compiles but can't run against the SSE+POST bridge. Rewrite needed before Mac-as-viewport works.

## Build Order

1. **Tailscale config** — Taildrive share, `tailscale serve` for CDP. One-time setup on both machines. Verify ACLs.
2. **CLI bridge client** — minimal viable: connect, pick folder, prompt/response loop, context gauge. This is the core deliverable.
3. **Remote webctl** — update CDP endpoint config on Kube to point at Mac's Chrome via Tailscale. Test with a simple `webctl navigate` + `webctl snapshot`.
4. **Image upload** — bridge protocol extension + both clients. Defer until core is solid.

## Rejected Ideas

- **Device Lease Model** — claude-go's heartbeat/lease/takeover pattern. Unnecessary: there's only one user, input conflicts are a social problem not a technical one. If it ever matters, Gueridon's multi-client broadcast already handles multiple viewers. Adding exclusive locking would be premature complexity.
- **Session teleport** — copying JSONL files between machines. Path encoding differs per machine, and the handoff system (`/close` → `/open`) already carries semantic context. Raw transcripts are less useful than summaries.
- **Hybrid sync** — git for code + Syncthing for session files. Two sync mechanisms = two failure modes. One source of truth is simpler.
