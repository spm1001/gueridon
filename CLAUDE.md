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
| `docs/architecture-and-review.md` | **Full architecture map + three-lens code review (2026-02-09).** File map, element nesting, dep table, build pipeline, 23 findings ranked by severity. |
| `docs/empirical-verification.md` | Verified JSONL schemas for CC 2.1.37. Every event type, edge case, abort mechanism. |
| `docs/event-mapping.md` | CC events → pi-web-ui AgentEvents translation table. The adapter blueprint. |
| `docs/bridge-protocol.md` | WebSocket protocol between browser and bridge. Message types, session lifecycle, reliability. |
| `docs/decisions.md` | Architecture decisions with rationale. Permissions, session model, UI choices. |

## Known Bugs (from code review 2026-02-09)

Start here before building features. See `docs/architecture-and-review.md` for full list.

1. **Agent state never resets on folder switch** (gdn-walaco) — singleton accumulates messages/tokens across sessions. Fix first.
2. **prompt() swallows null transport** (gdn-vosejo) — UI stuck streaming forever if called before WS connects
3. **Unknown CC events silently dropped** (gdn-pudaco) — no default case in handleCCEvent
4. **main.ts folder lifecycle** — deferred connect / pendingFolderConnect is a state machine hidden in callbacks. Source of dialog flash bug.

## Working Pattern: Write Analysis to Files

When producing architecture maps, reviews, or other analysis: **write to file first, present summary in chat**. Context can lock without warning. In-context-only analysis evaporates. Files survive.

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
npm run dev         # Vite on localhost:5173
npm run build       # Production build to dist/
npm test            # Run all tests (183 tests, ~2.25s)
npm run test:watch  # Watch mode for development
```

## Dependencies

**pi-web-ui is NOT a dependency.** We vendored the 4 container/display components we need into `src/vendor/` and wrote our own message leaf renderers in `src/message-components.ts`. See `src/vendor/README.md` for provenance.

| Package | Role | Import type |
|---------|------|-------------|
| `@mariozechner/mini-lit` | Design system: MarkdownBlock, CodeBlock, CopyButton, DialogBase, `icon()`, CSS theme | npm (value + types) |
| `@mariozechner/pi-agent-core` | AgentEvent, AgentMessage, AgentState, AgentTool | npm (types only) |
| `@mariozechner/pi-ai` | Model, Usage | npm (types only — no `getModel` value import) |
| `lit`, `lucide` | Lit framework, icon library | npm |

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
@aws-sdk transitive deps.

### If components render blank

Debug in this order:
1. `element.hasUpdated` — false means Lit never completed first render
2. Check `esbuild.target` in vite.config.ts — must be `"es2020"` for [[Set]] semantics
3. `litClassFieldFix()` plugin — still needed for Lit decorators in our code + vendored files
4. Lit dedup aliases — vendored files import `lit`, must resolve to our single copy

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
