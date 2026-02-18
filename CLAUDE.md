# Guéridon

Mobile web UI for Claude Code. The little table that brings the service to you.

## Architecture

```
Mobile browser → WebSocket → Node.js bridge → claude -p (stream-json) → MAX subscription
```

Process-per-session with `--session-id <uuid>`. Resume via `--resume` after process kill.

## Deployment

Runs on **kube** (Debian Linux, Tailscale). Single systemd service.

```bash
sudo systemctl restart gueridon    # Build dist/ (ExecStartPre) then start bridge
sudo systemctl status gueridon     # Check health
journalctl -u gueridon -f          # Tail logs
```

- **`KillMode=process`** — bridge restart does NOT kill CC child processes. They become orphaned; the new bridge reaps them on startup (SIGTERM) and the next client connection resumes via `--resume`.
- **`ExecStartPre=npm run build`** — every restart rebuilds `dist/`. Safe because Vite build is ~2s.
- **HTTPS terminated by `tailscale serve`** — bridge listens on HTTP :3001.
- **VAPID keys** for push notifications live at `~/.config/gueridon/vapid.json`.
- **Session persistence** — `~/.config/gueridon/sessions.json` tracks active CC PIDs so the bridge can reap orphans after restart.

See `docs/deploy.md` for VAPID key setup, Tailscale plumbing, and first-time install.

## Running Locally

```bash
# Production (single process — bridge serves static files + WS on :3001)
npm run start              # Build + launch bridge
npm run bridge             # Launch bridge only (assumes dist/ exists)

# Development (two processes — Vite HMR on :5173, bridge WS on :3001)
npm run dev                # Vite dev server with HMR
npm run bridge             # Bridge in separate terminal

# Testing
npm test                   # Run all tests (400+ tests, ~3s)
npm run test:watch         # Watch mode for development
npm run test:mobile        # Launch mobile test harness (Chrome Debug + dev + bridge + CDP viewport)
npm run test:mobile --prod # Same but using production build on :3001
npm run test:mobile:stop   # Tear down test harness
```

**BRIDGE_URL logic:** `import.meta.env.DEV` (Vite) selects between dev (`ws://hostname:3001`) and prod (`same-origin`). In prod, the browser's own origin is the bridge — no separate URL needed.

**Build test isolation:** `build.test.ts` builds to a temp dir with explicit `NODE_ENV=production` so vitest's `import.meta.env.DEV=true` doesn't contaminate the real `dist/`.

## Quick Verify

```bash
python3 scripts/hello-cc.py
python3 scripts/hello-cc.py "What tools do you have?"
```

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

- `--verbose` is mandatory for stream-json mode. Without it you get an unhelpful error.
- **Local commands (`/context`, `/cost`, `/compact`) produce NO stdout in `-p` mode.** CC writes `<local-command-stdout>` events to the session JSONL, but the stream-json pipe is silent — no content blocks, no user events, just an empty `result`. The bridge never sees this output and clients never receive it. Confirmed 2026-02-17.
  - **JSONL pattern**: three entries per local command: `<local-command-caveat>`, `<command-name>/cmd</command-name>`, `<local-command-stdout>output</local-command-stdout>`
  - **Only 3 built-in commands are local**: `/context` (~1.9k chars markdown), `/cost` (~73 chars), `/compact` (~10 chars)
  - **Other slash commands** (`/init`, `/pr-comments`, `/release-notes`, `/review`, `/security-review`, `/insights`) trigger normal Claude turns and work fine through the pipe
  - **Discovery**: the `init` system event includes `slash_commands: [...]` — the full list, programmatically
  - **Fix**: bridge reads JSONL tail on empty-result turns to recover local command output
- `--dangerously-skip-permissions` is still in use. The `--allowed-tools` migration (gdn-kugeto) is **planned but not shipped**. `docs/decisions.md` describes it as if done — it's aspirational.
- `--append-system-prompt` coaches CC about AskUserQuestion error behavior on mobile.

### The Input Format (Critical)

```json
{"type":"user","message":{"role":"user","content":"..."}}
```

Other formats fail silently or with cryptic errors. See `docs/empirical-verification.md` for the wrong formats.

## Bridge Server

`server/bridge.ts` — HTTP + WebSocket server. Serves static files from `dist/` and proxies WebSocket connections to CC processes. Full protocol in `docs/bridge-protocol.md`.

Key design decisions:
- **Single process:** HTTP static serving + WS on one port (:3001).
- **Static files from `dist/`:** SPA fallback (extensionless paths → `index.html`), path traversal guard, MIME types, cache headers for Vite hashed assets.
- **Lazy spawn:** CC process starts on first prompt, not on WS connect.
- **`source` discriminator:** All server messages carry `source: "bridge"` or `source: "cc"`.
- **`promptReceived` ack:** Confirms prompt hit CC stdin. "sending → waiting" UI transition.
- **Ping/pong:** 30s interval, 30s timeout (generous for DERP relay on cellular).
- **SIGTERM → SIGKILL:** 3s escalation on all process kills.
- **Early exit detection:** CC dying within 2s of spawn = flag/version problem, stderr surfaced to client.
- **Orphan reaping:** On startup, reads `sessions.json`, SIGTERMs any live CC processes from the previous bridge instance.

### Session Model

- One `claude -p` process per browser session (spawned lazily on first prompt)
- ~8s cold start (hooks + init + first API call), fast subsequent turns
- Idle timeout (5min) → kill process → `--resume` on reconnect
- Multi-turn works over persistent stdin (verified)
- Mid-stream messages queue (no native steering)
- Session resolution: reconnect (in-memory) > resume (disk, handoff doesn't match) > fresh

### Abort

- **Soft (default):** Stop rendering on client, let backend finish
- **Hard:** Kill process → `--resume` for next turn (8s penalty)
- SIGINT and control messages both kill the process dead (bridge uses SIGTERM→SIGKILL escalation)
- Stdin close lets response finish then exits cleanly

## Dependencies

**pi-web-ui is NOT a dependency.** We vendored the 4 container/display components we need into `src/vendor/` and wrote our own message leaf renderers in `src/message-components.ts`. See `src/vendor/README.md` for provenance.

| Package | Role | Import type |
|---------|------|-------------|
| `@mariozechner/mini-lit` | Design system: MarkdownBlock, CodeBlock, CopyButton, DialogBase, `icon()`, CSS theme | npm (value + types) |
| `@mariozechner/pi-agent-core` | AgentEvent, AgentMessage, AgentState, AgentTool | npm (types only) |
| `@mariozechner/pi-ai` | Model, Usage | npm (types only — no `getModel` value import) |
| `lit` | Lit framework | npm |

**Bundler:** Vite with `@tailwindcss/vite`

### What's vendored (src/vendor/)

One-time copy from `pi-mono` commit `41c4157b` (2026-02-09):
- `MessageList.ts` — renders message sequence
- `StreamingMessageContainer.ts` — in-flight message with batched updates
- `ThinkingBlock.ts` — thinking collapse/expand
- `ConsoleBlock.ts` — bash output display
- `message-renderer-registry.ts` — extensibility hook
- `i18n.ts` — trimmed i18n wrapper (10 keys, not 200+)

### What we own (src/message-components.ts)

Our own `<user-message>`, `<assistant-message>`, `<tool-message>`. Replaces
pi-web-ui's Messages.ts + renderTool chain. No pdfjs-dist, xlsx, jszip, or
`@aws-sdk` transitive deps.

### If components render blank

Debug in this order:
1. `element.hasUpdated` — false means Lit never completed first render
2. Check `esbuild.target` in vite.config.ts — must be `"es2020"` for [[Set]] semantics
3. `litClassFieldFix()` plugin — still needed for Lit decorators in our code + vendored files
4. Lit dedup aliases — vendored files import `lit`, must resolve to our single copy

## CLI Client

Terminal client that connects to the bridge from Mac. Same protocol as the web client, different renderer.

```bash
npx tsx cli/gdn.ts [bridge-url]       # Default: ws://localhost:3001
npx tsx cli/gdn.ts ws://kube:3001     # Connect to Kube bridge
```

### Architecture

```
cli/bridge-client.ts   — Protocol/state layer (WS, CC event parsing, tool accumulation, reconnection)
        ↓ semantic callbacks (onText, onToolStart, onToolResult, onAskUser, ...)
cli/gdn.ts             — Rendering + input (currently raw ANSI + readline, replaceable by TUI)
```

`bridge-client.ts` emits semantic events — the rendering layer never sees raw CC events like `content_block_delta` or `input_json_delta`. This separation exists so the rendering layer can be replaced (raw ANSI → pi-tui) without touching protocol logic.

### Dependency chain for CLI work

```
gdn-patati (prototype, features)
    → bridge-client.ts extraction (done)
        → gdn-kojihe (vendor pi-tui, build TUI)
            → gdn-zerobu (share interpreter with web adapter)
```

### CC tool vocabulary

`summarizeToolInput()` in gdn.ts knows how to display each CC tool's arguments (Bash→command, Read→file_path, Grep→pattern, etc.). This is domain knowledge that survives a rendering rewrite — extract it when building the TUI.

## Notifications

- **Service worker** (`public/sw.js`): push + notificationclick handlers, skipWaiting/claim for instant activation. No fetch/cache handler yet (see gdn-gabeda).
- **Manifest** (`public/manifest.json`): minimal PWA manifest for iOS standalone notification support.
- **Client notifications** (`src/notifications.ts`): Notification API, permission request from user gesture, fires on agent_end (turn complete) and AskUserQuestion. Only notifies when page lacks focus.
- **Title badge**: document.title shows ✓/⏳/❓ prefix per Claude state. Favicon SVG gets colored dot.
- **Replay guard**: notifications and title badges suppressed during session replay.
- **Icons**: SVG icons in `public/` (icon-192.svg, icon-512.svg). iOS apple-touch-icon is SVG (may need PNG for better home screen icon quality).

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/deploy.md` | **Deployment guide.** systemd service, Tailscale, VAPID keys, first-time setup. |
| `docs/architecture-and-review.md` | Full architecture map + three-lens code review (2026-02-09). |
| `docs/empirical-verification.md` | Verified JSONL schemas for CC 2.1.37. Every event type, edge case, abort mechanism. |
| `docs/event-mapping.md` | CC events → pi-web-ui AgentEvents translation table. The adapter blueprint. |
| `docs/bridge-protocol.md` | WebSocket protocol between browser and bridge. Message types, session lifecycle, reliability. |
| `docs/decisions.md` | Architecture decisions with rationale. Permissions section is aspirational (see gdn-kugeto). |
| `docs/kube-brain-mac-body.md` | Two-machine architecture: Kube runs CC, Mac is the viewport. |
| `docs/lifecycle-map.md` | Behavioral lifecycle map — session states, transitions, edge cases. |

## Working Pattern: Write Analysis to Files

When producing architecture maps, reviews, or other analysis: **write to file first, present summary in chat**. Context can lock without warning. In-context-only analysis evaporates. Files survive.
