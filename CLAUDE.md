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

## Dependencies

- **pi-web-ui packages:** `@mariozechner/pi-web-ui`, `pi-agent-core`, `pi-ai`, `mini-lit` (all on npm)
- **Bundler:** Vite with `@tailwindcss/vite`
- **Reference project:** `~/Repos/persistent-assistant` (David's Telegram bot, spawn-per-message approach)
- **pi-mono source:** `~/Repos/pi-mono` (for reference, consume via npm not source)

## Session Model

- One `claude -p` process per browser session
- ~8s cold start (hooks + init + first API call), fast subsequent turns
- Idle timeout → kill process → `--resume` on reconnect
- Multi-turn works over persistent stdin (verified)
- Mid-stream messages queue (no native steering)

## Abort

- **Soft (default):** Stop rendering on client, let backend finish
- **Hard:** Kill process → `--resume` for next turn (8s penalty)
- SIGINT and control messages both kill the process dead
- Stdin close lets response finish then exits cleanly
