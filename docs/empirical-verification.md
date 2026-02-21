# Empirical Verification: Claude Code Streaming JSON

**Date:** 2026-02-08
**Claude Code version:** 2.1.37
**Verified by:** Running actual commands and capturing output

## Required Flags

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \          # Token-by-token streaming (essential for UI)
  --replay-user-messages \              # Echo user messages back on stdout (receipt confirmation)
  --session-id <uuid> \                 # Deterministic session ID (enables --resume)
  --dangerously-skip-permissions --allow-dangerously-skip-permissions
```

- `--verbose` is **required** — without it, `--output-format stream-json` errors: "requires --verbose"
- `--include-partial-messages` adds `stream_event` lines for token-by-token UI updates
- `--replay-user-messages` echoes user messages back on stdout (useful for confirming receipt)
- `--session-id` sets a deterministic session ID — required for `--resume` on reconnection
- `--dangerously-skip-permissions` still fires hooks (system events) but skips tool permission prompts

## Input Format

```jsonl
{"type":"user","message":{"role":"user","content":"Your prompt here"}}
```

**Wrong formats that fail:**
- `{"type":"user","content":"..."}` → `TypeError: undefined is not an object (evaluating 'R.message.role')`
- `{"message":{"role":"user","content":"..."}}` → `Expected message type 'user' or 'control', got 'undefined'`
- `{"role":"user","content":"..."}` → silent failure (hooks fire, no response)

**Control messages** (`{"type":"control",...}`) — see Abort section below.

## Output Events (JSONL, one object per line)

### 1. System Events (hooks + init)

```jsonl
{"type":"system","subtype":"hook_started","hook_id":"...","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"...","session_id":"..."}
{"type":"system","subtype":"hook_response","hook_id":"...","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"...","session_id":"..."}
```

Then the init event (rich metadata):
```jsonl
{"type":"system","subtype":"init","cwd":"/path","session_id":"...","tools":["Bash","Read",...],"mcp_servers":[{"name":"mise","status":"connected"}],"model":"claude-opus-4-6","permissionMode":"bypassPermissions","slash_commands":[...],"claude_code_version":"2.1.37","agents":[...],"skills":[...]}
```

**Note:** Init fires on EVERY user message, not just the first. Same session_id, same tools. Bridge should use first init only; ignore subsequent ones or use as turn-start markers.

### 2. User Message Replay (with --replay-user-messages)

When enabled, user messages are echoed back on stdout:
```jsonl
{"type":"user","message":{"role":"user","content":"Say OK"},"session_id":"...","parent_tool_use_id":null,"uuid":"..."}
```

Arrives AFTER streaming starts (after first content delta). Useful for confirming the bridge's message was received.

### 3. Assistant Message (without --include-partial-messages)

Complete message arrives as a single event:
```jsonl
{"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_...","type":"message","role":"assistant","content":[{"type":"text","text":"Hello there, nice meeting you!"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":31184,"cache_read_input_tokens":0,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"..."}
```

### 4. Assistant Message (with --include-partial-messages)

Token-by-token streaming wrapped in `stream_event`:

```jsonl
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_...","role":"assistant","content":[],"stop_reason":null,"usage":{...}}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\n2\n3\n4\n5"}}}
{"type":"assistant","message":{...complete message...}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":13}}}
{"type":"stream_event","event":{"type":"message_stop"}}
```

Note: the complete `{"type":"assistant",...}` event still arrives mid-stream (before `content_block_stop`).

### 5. Tool Use

Assistant decides to call a tool:
```jsonl
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_...","name":"Bash","input":{"command":"echo hello-from-tool","description":"Echo a test string"}}],...}}
```

Tool result arrives as a "user" message:
```jsonl
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_...","type":"tool_result","content":"hello-from-tool","is_error":false}]},"tool_use_result":{"stdout":"hello-from-tool","stderr":"","interrupted":false,"isImage":false}}
```

Then assistant responds to the tool result (another assistant message).

### 6. Final Result

```jsonl
{"type":"result","subtype":"success","is_error":false,"duration_ms":26284,"duration_api_ms":23020,"num_turns":2,"result":"Done — output: `hello-from-tool`","session_id":"...","total_cost_usd":0.099,"usage":{...},"modelUsage":{...},"permission_denials":[]}
```

## Event Sequence Summary

### Simple text response:
```
system/hook_started (×N)           # first message only
system/hook_response (×N)          # first message only
system/init                        # every message
[stream_event/message_start]       # with --include-partial-messages
[stream_event/content_block_start]
[stream_event/content_block_delta] # ×N (token chunks)
[user replay]                      # with --replay-user-messages (arrives mid-stream!)
assistant (complete message)
[stream_event/content_block_stop]
[stream_event/message_delta]
[stream_event/message_stop]
result/success
```

### Tool use response:
```
system/init
assistant (with tool_use content)
user (with tool_result content + tool_use_result metadata)
assistant (text response to tool result)
result/success
```

## Verified: Multi-Turn Over Persistent Stdin

**CONFIRMED.** A single Claude Code process maintains conversation state across multiple messages sent to stdin.

Test: sent "Remember 7742" then "What number?" — second response correctly returned "7742."

Key observations:
- Session ID stays the same across messages
- **Init event (`system/init`) fires again for every message** — same session_id, same tools
- Hook events only fire once (session start), not per message
- No perceptible delay between messages (cache is warm after first)

**Architecture decision:** Process-per-session. One `claude -p` process per browser session. ~8s cold start (hooks + init + first API call), subsequent turns are fast.

## Verified: Session Resume

**`--resume` WORKS.** Start with `--session-id <uuid>`, kill the process, restart with `--resume <uuid>` — full conversation memory intact.

Test: Told process "secret word is GUERIDON", killed it, resumed with `--resume`, asked "what was the secret word?" → correctly answered "GUERIDON."

- `--continue` (most recent session in current dir) is **unreliable** — didn't work in testing
- `--resume <session-id>` with explicit UUID is the robust path

**Reconnection strategy:**
1. Keep process alive while WebSocket is connected
2. On WebSocket disconnect, start idle timeout (e.g., 5 minutes)
3. If timeout expires, kill process
4. On reconnect, `--resume <session-id>` to restore conversation
5. Replay message history to UI from stored messages (client-side)

**Startup cost on resume:** Same ~8s as fresh start (hooks + init + MCP). Session state comes from Claude Code's internal persistence, not from the process.

## Verified: Mid-Stream Message Queueing

**Messages sent while streaming are QUEUED, not rejected.** The current response completes fully, then the queued message is processed.

Test: Sent "write 500 words about bread" then mid-stream sent "Stop. What is 2+2?"
- First response completed in full (entire essay)
- Then "4" was returned as second response
- Two separate `result/success` events
- Process stayed alive

**Implication:** No native "steer" mechanism. Can't interrupt a response to redirect it. Options:
1. **Soft abort:** Stop rendering on client, let backend finish, discard excess. Simple, no latency penalty.
2. **Hard abort:** Kill process → `--resume` for next turn. Saves tokens but 8s latency penalty.
3. **Queue:** Just let it finish and process the queued message after. Most robust.

## Verified: Abort Mechanisms

### SIGINT
**Kills the process.** No graceful shutdown, no result event, process exits immediately.
- Not recoverable — need `--resume` to continue the session
- Not suitable for "pause" — this is a hard kill

### Control Messages
`{"type":"control",...}` with various payloads (abort, etc.) — all variants tested **kill the process** without emitting a result event. The process exits silently.
- Functionally identical to SIGINT
- No stderr errors for most variants
- `{"type":"control"}` (empty) gives stderr error but still kills

### Stdin Close (Graceful)
**Best mechanism.** Closing stdin mid-stream causes the process to:
1. Finish the current response completely
2. Emit the full assistant message
3. Emit `result/success`
4. Exit with code 0

This is the graceful shutdown path — lets the response complete, then clean exit.

### Summary

| Mechanism | Stops tokens? | Clean result? | Process survives? | Next turn |
|---|---|---|---|---|
| SIGINT | Yes | No | No | `--resume` |
| Control message | Yes | No | No | `--resume` |
| Close stdin | No (finishes) | Yes | No (exits 0) | `--resume` |
| Soft abort (client) | No (finishes) | Yes | Yes | Normal |
| Queue next message | No (finishes) | Yes | Yes | Automatic |

**Recommended default:** Soft abort (stop rendering) + queue. Use hard abort (kill + resume) only for very long responses the user wants to stop immediately.

## Verified: Permission Handling

**No interactive permission prompt exists in stream-json mode.** Tested all `--permission-mode` variants:

| Mode | Behaviour in `-p` mode |
|---|---|
| `default` | Respects settings.json allow/deny. Allowed tools run. Denied tools simply don't appear in tool list. |
| `bypassPermissions` | All tools run without checks. |
| `acceptEdits` | Auto-approves Edit/Write, auto-approves others per settings.json. |
| `dontAsk` | Denies anything not in settings.json. |
| `delegate` | For agent teams only, not applicable to bridge. |

**Key finding:** `--disallowedTools` removes tools from the model's visible set entirely (they don't appear in init). The model adapts by not trying to use them. No permission event is emitted — there's nothing to approve/deny because the model never sees the tool.

**`permission_denials`** appears in the `result` event (always an array, usually empty). If a tool was attempted but blocked, it shows up here post-hoc.

**Deny-and-notify pattern (tested, doesn't work with `--disallowedTools`):** Attempted to use `permission_denials` in the result event to surface blocked actions. However:
- Deny lists remove tools from the model's view entirely — it never attempts them
- `permission_denials` is always empty because the model never calls denied tools
- The model routes around restrictions: Bash denied → uses Task subagent → Bash subagent runs it. Task denied → uses Skill. Everything denied → fakes the output as text.
- Pattern-based restrictions (e.g., `Bash(git:*)`) were not enforced in testing

### Verified: --allowed-tools Semantics (2026-02-11)

`--allowed-tools` is **additive, not restrictive**. It auto-approves listed tools; unlisted tools remain available but require permission (and in `-p` mode, permission = denial).

Test: `--allowed-tools AskUserQuestion` (only AskUserQuestion listed). Init event showed all 22 standard tools, not just AskUserQuestion. The flag adds to the default set.

**`--allowed-tools` + `permission_denials` = working deny-and-notify.** Unlike `--disallowedTools` (which hides tools entirely), `--allowed-tools` leaves all tools visible but gates execution. The model attempts the tool, gets denied, and the denial appears in the result event with full tool input.

### Verified: settings.json Takes Precedence (2026-02-16)

**`settings.json` allow list overrides `--allowed-tools`.** If settings.json has a blanket `"Bash"` in its allow list, Bash runs without denial regardless of whether `--allowed-tools` includes it. Tested with `--allowed-tools "Read,Edit,Write,Glob,Grep"` (Bash excluded) and `--permission-mode default` — Bash ran successfully, `permission_denials: []`.

**To gate Bash via `--allowed-tools`, you must first remove the blanket `"Bash"` from settings.json** and replace it with specific patterns (e.g., `"Bash(git:*)"`, `"Bash(npm:*)"`, etc.).

### Verified: Persistent Stdin Hangs on Unlisted Tools (2026-02-16)

**In persistent `-p` mode with stdin pipe, an unlisted tool causes a hang, not a denial.** CC blocks waiting for interactive TTY approval that can never come. No output, no `permission_denials` event. The process must be killed externally.

This only affects the persistent stdin model (Guéridon). **Spawn-per-message with stdin=/dev/null** (persistent-assistant's model) gets proper denial because CC detects no TTY and fails the permission prompt immediately.

The Feb 11 test (above) showed AskUserQuestion being denied — this was because AskUserQuestion has a unique **second permission gate** that always denies in `-p` mode regardless of `--allowed-tools`. Regular tools like Bash do not have this second gate and hang instead.

### persistent-assistant's Permission Model (2026-02-16)

persistent-assistant (github.com/davidbeglenboyle/persistent-assistant) uses a spawn-per-message architecture with stdin ignored. Their permission routing works because of this architecture difference:

1. `--allowed-tools Read,Edit,Write,Glob,Grep,...` (whitelist, excluding Bash)
2. CC tries Bash → not in allowed list → **denied** (stdin is /dev/null, so no hang)
3. Bridge surfaces denial to user (Telegram approval prompt)
4. User approves → bridge respawns with Bash added to `--allowed-tools`

**This pattern cannot be directly adopted for Guéridon's persistent stdin model.** See `~/.claude/plans/serene-floating-map.md` for the adapted approach using settings.json patterns as the primary gate.

### Verified: AskUserQuestion Two-Gate Behavior (2026-02-11)

AskUserQuestion has **two permission gates**, and `--allowed-tools` only bypasses the first:

| Gate | What it controls | `--allowed-tools` bypasses? |
|------|-----------------|---------------------------|
| **Tool availability** (API level) | Whether CC presents the tool to the model | Yes — AskUserQuestion appears in tool list |
| **Tool execution** (`-p` mode) | Whether CC executes the tool_use | **No** — always denied in `-p` mode |

Tested with `--allowed-tools AskUserQuestion --permission-mode default`:
- CC generated a proper AskUserQuestion tool_use (3 structured questions, options, multiSelect)
- Tool execution returned `is_error: true`, content: `"Answer questions?"`
- The `"Answer questions?"` string is the TUI permission prompt leaking as error content
- AskUserQuestion appears in `permission_denials` in the result event
- CC gracefully degraded: took a second turn reformulating the question as text

**stdin cannot inject tool_results.** Stream-json input accepts only `type: "user"` and `type: "control"` messages. Tool execution is internal to CC — there is no mechanism to externally answer an AskUserQuestion via stdin.

**The deny-intercept-render pattern is confirmed necessary** regardless of flags. The valuable part: CC generates excellent structured question data (questions, options, multiSelect) that the bridge intercepts from the stream for native UI rendering.

**Decision for the bridge:** Migrate from `--dangerously-skip-permissions` to `--allowed-tools` whitelist (gdn-fuhepu). Retains observe-and-intervene UX for whitelisted tools, adds permission routing for non-whitelisted tools, and the AskUserQuestion intercept pattern is unchanged.

## Verified: MCP Tool Use

**MCP tool calls are identical to built-in tool calls in stream-json output.** Same event structure:
- `stream_event/content_block_start` with `content_block.type: "tool_use"` and `name: "mcp__mise__search"`
- `stream_event/content_block_delta` with `input_json_delta` for tool arguments
- `assistant` message with tool_use content
- `user` message with tool_result

**Minor difference in tool_use_result metadata:**
- Built-in (Bash): `{"stdout": "...", "stderr": "...", "interrupted": false, "isImage": false}`
- MCP (mise): `{"content": "{...json...}"}`

The bridge mapper needs to handle both shapes, but the event flow is the same.

**Also observed:** The model loaded the `mise` skill (via `Skill` tool) before calling `mcp__mise__search`. The skill system teaches MCP usage patterns. This is expected and correct.

## Verified: Thinking Blocks

Enable via environment variable on the Claude Code process:
```bash
MAX_THINKING_TOKENS=5000 claude -p --verbose --output-format stream-json --include-partial-messages ...
```

Or: `CLAUDE_CODE_EFFORT_LEVEL=high`

Produces `thinking` content blocks with `thinking_delta` streaming events, followed by a `signature_delta` (integrity check), then the normal `text` content blocks.

Note: Opus 4.6 uses adaptive reasoning — `MAX_THINKING_TOKENS` sets a budget but the model decides how much to actually use. `MAX_THINKING_TOKENS=0` disables thinking entirely.

## Useful Additional Flags

| Flag | Purpose | Bridge use |
|---|---|---|
| `--session-id <uuid>` | Deterministic session ID | Map browser session → CC session |
| `--resume <id>` | Resume a killed session | Reconnection after WebSocket drop |
| `--replay-user-messages` | Echo user messages on stdout | Confirm receipt |
| `--include-partial-messages` | Token-by-token streaming | Essential for typing UX |
| `--append-system-prompt` | Inject extra context | "User is on mobile" |
| `--model` | Set model | Could expose in UI |
| `--allowedTools` | Restrict tools | Mobile-specific tool set |
| `--mcp-config` | Load specific MCPs | Context-specific tools |
| `--max-budget-usd` | Spending cap | Safety valve |
| `--no-session-persistence` | Don't save sessions | For ephemeral chats |
