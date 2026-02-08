# Architecture Decisions

Assumptions surfaced and resolved, 2026-02-08.

## Session Launch

**Directory picker at session start.** User chooses:
- An existing `~/Repos/*` folder (lists directories)
- Create new folder

This matters because the working directory determines:
- Which `CLAUDE.md` loads (project-specific instructions)
- Which `.mcp.json` loads (project-specific MCP servers)
- Which `.arc/` directory is active (project work tracking)
- File access scope (relative paths)

The bridge spawns `claude -p` with `cwd` set to the chosen directory.

## Permissions

**Use `--dangerously-skip-permissions`.** No interactive permission gate in stream-json mode.

The mobile UI surfaces all tool executions (tool name, arguments, result) so the user can see what's happening. If something looks wrong, user can:
- Soft abort (stop rendering, let backend finish)
- Hard abort (kill process, resume later)
- Send a corrective message

Per-session tool restriction via `--allowedTools` is available if needed for specific contexts.

## Model Selection

**Always default (latest model).** Hide the model picker. Claude Code manages model selection internally — currently defaults to Opus 4.6.

Thinking level selector: also hidden. Increasingly automatic. "Don't think when there's no thinking to be done."

## Concurrency

**4-7 concurrent sessions.** Each session = one Claude Code process (~200MB+ RSS with full harness).

Process lifecycle:
1. Created on session start (directory picker → spawn process)
2. Alive while WebSocket connected
3. Idle timeout (5 min?) after WebSocket disconnect → kill process
4. Resume via `--resume <session-id>` on reconnect

Kube.lan has plenty of resources for this.

## Abort Strategy

**Default: soft abort (client-side).** Stop rendering, let backend finish, discard excess tokens. Next message queues normally.

**User-initiated hard abort:** Kill process → `--resume` for next turn. 8s latency penalty. Use sparingly.

No native mid-stream steering. Second messages queue behind the current response.

## Flags for the Claude Code Process

```bash
claude -p \
  --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --session-id <browser-session-uuid> \
  --dangerously-skip-permissions \
  --allow-dangerously-skip-permissions
```

Optional per-session:
- `--append-system-prompt "User is on mobile device"` — mobile context
- `--allowedTools "..."` — tool restriction
- `--mcp-config "..."` — additional MCP servers

## UI Elements

**Keep from pi-web-ui:**
- MessageList, StreamingMessageContainer
- MessageEditor (input box)
- Artifact rendering (HTML, SVG, markdown, sandboxed iframe)
- Attachment handling

**Strip:**
- Model selector
- API key dialogs
- Cost tracking / usage stats
- Thinking level selector
- Provider/proxy settings

**Add:**
- Directory picker (session start)
- Tool execution viewer (show tool name, args, result)
- Session list (resume previous sessions)
- Connection status indicator (WebSocket health)

## Network

Tailscale for secure access. No separate auth layer needed — Tailscale identity is sufficient.

HTTPS via Tailscale's built-in certs or Caddy reverse proxy.

## AskUserQuestion Strategy

In `-p` mode, AskUserQuestion errors (no TTY). But the `tool_use` event containing the full question structure (questions, options, multiSelect) arrives in the stream BEFORE the error result. The bridge can:

1. Detect `tool_use: AskUserQuestion` in the stream
2. Extract questions/options, render as tappable buttons in mobile UI
3. Let the error result pass through (model sees it failed)
4. User taps an option → becomes the next user message
5. Model gets the answer as a natural continuation via the persistent process

Coach the model via `--append-system-prompt`: "AskUserQuestion will error in this environment. The user sees your question in the mobile UI and will respond in their next message."

This is strictly better than David's Telegram approach (where AskUserQuestion is just text) because we render structured options as tap targets. Zero typing on phone keyboard.

## Permission Model (revised)

Informed by persistent-assistant's approach:

**Option A (simple, like David's):** Use `--allowedTools` to restrict dangerous tools. When `permission_denials` appears in the result, show the user what was blocked. User approves → re-run with the tool added. Conversation-level permissions.

**Option B (our approach, better UX):** Use `--dangerously-skip-permissions` + show all tool executions in real-time. User watches and intervenes if needed. No denial/re-run cycle.

**Decision:** Start with Option B (observe and intervene). Consider adding Option A for specific contexts where you want explicit gates (e.g., production server access).

## Reference: persistent-assistant

David Beglen Boyle's `~/Repos/persistent-assistant` solves the same problem for Telegram:
- Spawn-per-message with `--resume` (no persistent process, no streaming)
- `permission_denials` in result → user approval → re-run with extra tools
- FIFO queue for message ordering
- Simple, crash-proof, but no real-time feedback

Guéridon goes further: persistent process + streaming + structured AskUserQuestion + real-time tool visibility. The mobile UX demands it — "sod it, I'll wait" is the failure mode we're designing against.

## Consuming pi-web-ui

All three packages are published to npm under `@mariozechner/` scope:
- `@mariozechner/pi-web-ui` (Lit web components)
- `@mariozechner/pi-agent-core` (Agent class, types)
- `@mariozechner/pi-ai` (LLM primitives)

**Approach: npm install from public registry.** No submodule, no local build coupling.

```bash
npm install @mariozechner/pi-web-ui @mariozechner/pi-ai @mariozechner/pi-agent-core @mariozechner/mini-lit lit
```

**Bundler:** Vite with `@tailwindcss/vite` plugin. The example app at `pi-mono/packages/web-ui/example/` is our template — minimal vite.config.ts (3 lines), standard Lit component wiring.

**CSS:** Import `@mariozechner/pi-web-ui/app.css` (built Tailwind).

**If we need to modify pi-web-ui later:** Escalate to `npm link` against the local pi-mono checkout.

## Open Questions (deferred)

1. **File browser** — should the UI show file contents when Claude edits files? Start without, add if needed.
2. **Artifact rendering** — Claude Code produces artifacts differently than pi's agent. May need adapter work.
3. **Hooks in bridge context** — SessionStart hooks fire on the server. Should they? Or suppress with config?
4. **Session metadata display** — show token counts? Session duration? Cost is irrelevant (MAX subscription).
