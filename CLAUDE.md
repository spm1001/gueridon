# Guéridon

Mobile web UI for Claude Code. The little table that brings the service to you.

## Architecture

```
Mobile browser → WebSocket → Node.js bridge → claude -p (stream-json) → MAX subscription
```

Process-per-session with `--session-id <uuid>`. Resume via `--resume` after process kill.

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/empirical-verification.md` | Verified JSONL schemas for CC 2.1.37. Every event type, edge case, abort mechanism. **Read this first.** |
| `docs/event-mapping.md` | CC events → pi-web-ui AgentEvents translation table. The adapter blueprint. |
| `docs/bridge-protocol.md` | WebSocket protocol between browser and bridge. Message types, session lifecycle, reliability. |
| `docs/decisions.md` | Architecture decisions with rationale. Permissions, session model, UI choices. |

## The Input Format (Critical)

```json
{"type":"user","message":{"role":"user","content":"..."}}
```

Other formats fail silently or with cryptic errors. See `docs/empirical-verification.md` for the wrong formats.

## Required CLI Flags

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --session-id <uuid> \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions
```

`--verbose` is mandatory for stream-json. Without it you get an unhelpful error.

## Quick Verify

```bash
python3 scripts/hello-cc.py
python3 scripts/hello-cc.py "What tools do you have?"
```

## Dev Server

```bash
npm run dev    # Vite on localhost:5173
npm run build  # Production build to dist/
```

## Dependencies

- **pi-web-ui:** Consumed from local fork source (NOT npm). See below.
- **pi-agent-core, pi-ai, mini-lit:** From npm (`@mariozechner/*`)
- **Bundler:** Vite with `@tailwindcss/vite`
- **Reference project:** `~/Repos/persistent-assistant` (David's Telegram bot, spawn-per-message approach)

## pi-mono Fork (Critical)

**guéridon consumes pi-web-ui TypeScript source directly from `~/Repos/pi-mono`.**

- Fork: `~/Repos/pi-mono`, branch `gueridon` (all our patches)
- Remote `origin` = spm1001/pi-mono, `upstream` = badlogic/pi-mono
- `main` tracks upstream clean. Rebase `gueridon` on `main` when upstream updates.

### How it works

`vite.config.ts` aliases `@mariozechner/pi-web-ui` → `~/Repos/pi-mono/packages/web-ui/src`. Vite compiles the TypeScript directly with `esbuild.target: "es2020"`, which uses `[[Set]]` semantics for class fields — this fixes Lit reactivity at source (no more tsgo class field bug).

**No build step.** Edit web-ui source → Vite HMR picks it up.

Lit is deduplicated across pi-mono and guéridon to prevent duplicate runtime issues.

### Our patches

The `gueridon` branch carries patches on top of upstream:
- `customStats` property on AgentInterface (fuel gauge hook)
- Per-message token stats removed (we use the fuel gauge instead)
- Double render fix (clear streaming container on `message_end`)
- Streaming line-buffer, tool call buffering, padding fix, /exit alias

### If pi-web-ui components render blank

Debug in this order:
1. `element.hasUpdated` — false means Lit never completed first render
2. Check `esbuild.target` in vite.config.ts — must be `"es2020"` for [[Set]] semantics
3. Check Vite alias is resolving to source, not stale npm package
4. `litClassFieldFix()` plugin is belt-and-suspenders (probably dead code now)

## Bridge Server

`server/bridge.ts` — WebSocket-to-stdio proxy. Full protocol in `docs/bridge-protocol.md`.

```bash
npm run bridge              # Start on :3001
npx tsx scripts/test-bridge.ts  # Integration tests (needs bridge running)
```

Key design decisions:
- **Lazy spawn:** CC process starts on first prompt, not on WS connect. No wasted processes.
- **`source` discriminator:** All server messages carry `source: "bridge"` or `source: "cc"` — structural, not string-convention.
- **`promptReceived` ack:** Confirms prompt hit CC stdin. Hook point for "sending → waiting" UI transition.
- **Ping/pong:** 30s interval, 10s timeout. Catches silently-dead mobile connections.
- **SIGTERM → SIGKILL:** 3s escalation on all process kills.
- **Early exit detection:** CC dying within 2s of spawn = flag/version problem, stderr surfaced to client.

## Session Model

- One `claude -p` process per browser session (spawned lazily on first prompt)
- ~8s cold start (hooks + init + first API call), fast subsequent turns
- Idle timeout (5min) → kill process → `--resume` on reconnect
- Multi-turn works over persistent stdin (verified)
- Mid-stream messages queue (no native steering)

## Abort

- **Soft (default):** Stop rendering on client, let backend finish
- **Hard:** Kill process → `--resume` for next turn (8s penalty)
- SIGINT and control messages both kill the process dead (bridge uses SIGTERM→SIGKILL escalation)
- Stdin close lets response finish then exits cleanly
