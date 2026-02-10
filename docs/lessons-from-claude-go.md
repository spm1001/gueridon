# Lessons from claude-go

Claude-go was the predecessor to Guéridon — a self-hosted Claude Code web client built on tmux + JSONL file watching + WebSocket. It was retired in February 2026 after Guéridon's `claude -p` architecture proved superior.

This document captures what was learned the hard way, so future Claudes can reach for these patterns when the need arises rather than rediscovering them.

## Patterns Worth Knowing

### 1. The "Ask + Queue" Pattern (Async Permission Gates)

The hardest problem claude-go solved: how do you handle permission prompts when the user is on a train with their phone in their pocket?

```
Hook fires (PreToolUse)
  ↓
POST to server (queues notification)
  ↓
Return {"permissionDecision": "ask"} immediately  ← no blocking
  ↓
Terminal prompt appears, waits indefinitely
  ↓
... hours pass ...
  ↓
User opens phone, taps Approve → server sends keystroke to tmux
```

**The key insight: decouple notification from approval.** The hook doesn't block. The terminal prompt waits forever. The user responds whenever. Three independent pieces, loosely coupled.

**Why this matters for Guéridon:** Today we bypass permissions with `--dangerously-skip-permissions`. That's fine for personal use. If Guéridon is ever shared, or if CC adds features that need interactive confirmation in `-p` mode, this pattern is the one to implement. The equivalent in Guéridon's architecture would be: detect a permission-requiring event in the stream → queue it in bridge state → send it to the client → user taps → bridge writes the answer to CC's stdin.

### 2. Device Lease Model (Who Owns the Session?)

Claude-go implemented a heartbeat/lease system for exclusive device control:

- Client sends heartbeat every 5 seconds
- Server tracks `{ deviceId, lastHeartbeat }` per session
- Lease expires after 15 seconds of silence
- New device connecting to a leased session notifies the old device: "session-taken"
- Old device gets a "Take Back" button

**Why it matters:** Guéridon broadcasts to all connected clients (multi-tab friendly), but doesn't distinguish between "two tabs on my laptop" and "phone vs desktop competing for control." If input actions ever conflict across devices, this lease model is the answer.

### 3. Keystroke Timing for Multi-Select

Claude Code's terminal UI needs breathing room between keystrokes. Claude-go discovered empirically that toggling multiple options in `answer-multi` requires **50ms delays** between each keystroke. Without this, options don't toggle correctly.

**Guéridon avoidance:** We use JSON messages via stdin, not keystrokes. But if CC ever introduces interactions in `-p` mode that require sequential input (not atomic JSON messages), remember: add delays.

### 4. Tool Results Are User Messages

In CC's JSONL format, the flow is:
1. Assistant sends `tool_use` block
2. System sends `tool_result` as a **user** message (not assistant)
3. Assistant continues

This trips up every parser on first encounter. Both claude-go and Guéridon handle it, but it's worth calling out because it's counter-intuitive and easy to regress on.

### 5. Auto-Approved Tools Still Fire Hooks

If a tool is in `permissions.allow`, no prompt appears — but the hook still fires. In claude-go, this meant the keystroke went nowhere (or worse, to the wrong prompt). The fix: check tool name in the hook and exit early for tools with inline UI rendering (`AskUserQuestion`, `TodoWrite`).

**Guéridon avoidance:** No hooks. But if hooks are ever added, this edge case will bite.

### 6. tmux capture-pane Misses the Alternate Screen Buffer

`tmux capture-pane` only captures the normal screen buffer. Claude Code's interactive UI (the one with the progress spinner, tool approvals, etc.) runs in an alternate screen buffer, which `capture-pane` misses entirely.

The workaround: `tmux pipe-pane -t {session} "cat > /tmp/output.txt"` captures everything.

**Guéridon avoidance:** No tmux. But useful when debugging CC's terminal UI during development.

## Testing Layers Pyramid

Claude-go's testing model, adapted for Guéridon's architecture:

| Layer | Claude-go | Guéridon equivalent |
|-------|-----------|-------------------|
| UI rendering | `/dev/inject` + Playwright | Unit tests + Playwright |
| Button/interaction | Playwright click + API spy | Component tests + e2e |
| Input delivery | Real fishbowl (tmux keystrokes) | Bridge integration tests (stdin writes) |
| Full flow | kube.lan with hooks | Live CC process + bridge |

The "fishbowl" concept — a sandboxed real Claude session for integration testing — is worth having. Claude-go's `spinup-fishbowl.sh` created a temp directory, started a session there, and ran tests against it. Guéridon could do the same with `claude -p` in a sandbox directory.

## Architectural Decisions That Guéridon Got Right

For the record, these are the things Guéridon improved on:

- **`claude -p` over tmux scraping** — eliminates entire categories of problems (keystroke fragility, alternate screen buffer, path sanitization for JSONL lookup)
- **JSON stdin/stdout over file watching** — no partial-write handling, no polling interval tuning, no chokidar quirks on Linux
- **Process-per-session over tmux-per-session** — simpler lifecycle, no tmux dependency
- **Idle guards over lease expiry** — more nuanced (distinguishes "idle with no output" from "actively producing output slowly")

## The One Gap: Session Persistence Across Bridge Restarts

Claude-go's tmux sessions survived a server restart. Guéridon's subprocess model means a bridge crash or restart kills all active CC processes. The `--resume` flag helps reconnect, but there's no mechanism to:

1. Detect that a CC process was orphaned by a bridge restart
2. Automatically reconnect to it
3. Preserve the message buffer across restarts

Claude-go solved this with `KillMode=process` in systemd (only kills Node, not tmux children) and JSONL file watching (can always re-read the conversation from disk).

This is tracked as an Arc item — see the project's arc for details.

## Source

The claude-go repository lives at `~/Repos/claude-go` (archived, read-only). The full codebase, comments, and commit history contain additional context beyond what's summarised here.
