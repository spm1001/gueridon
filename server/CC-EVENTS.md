# CC Event Reference

Event shapes from Claude Code's `-p --output-format stream-json` mode.
Captured during bb-lovise spike (Feb 2026, CC v2.1.45).

## Event Sequence Per Turn

```
system:init → stream_event:message_start → stream_event:content_block_start
→ stream_event:content_block_delta (repeated) → user (replay echo, filtered)
→ assistant (complete message) → stream_event:content_block_stop
→ stream_event:message_delta → stream_event:message_stop → result
```

**Key facts:**
- `init` fires on EVERY turn, not just the first. Fresh metadata per prompt.
- `assistant` (complete message) fires BEFORE `content_block_stop`.
- `user` echo events (from `--replay-user-messages`) arrive mid-stream. Filter with `isUserTextEcho()`.
- `system:hook_started` and `system:hook_response` fire before `init`. Ignore them.

## system:init

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/home/modha/Repos/gueridon",
  "session_id": "8ca79bd7-...",
  "model": "claude-opus-4-6",
  "permissionMode": "bypassPermissions",
  "claude_code_version": "2.1.45",
  "slash_commands": ["context", "cost", "compact", ...],
  "tools": ["Task", "Bash", "Read", "Write", ...],
  "mcp_servers": [{"name": "mise", "status": "connected"}]
}
```

## stream_event:content_block_start (text)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "text", "text": "" }
  },
  "session_id": "...", "parent_tool_use_id": null
}
```

## stream_event:content_block_start (tool_use)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "tool_use", "id": "toolu_01ABC123", "name": "Bash" }
  }
}
```

No `input` field at start — input arrives via `input_json_delta` fragments.

## stream_event:content_block_delta (text_delta)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Here is the answer" }
  }
}
```

## stream_event:content_block_delta (input_json_delta)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "input_json_delta", "partial_json": "{\"command\":" }
  }
}
```

Multiple fragments concatenate to form valid JSON. Parse on `content_block_stop`.

## stream_event:content_block_stop

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_stop",
    "index": 0
  }
}
```

## assistant (complete message)

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01HMGdxZ8td6A9ivg9Wr95Kf",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "2" }
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 11742,
      "cache_read_input_tokens": 22679,
      "output_tokens": 1
    }
  },
  "session_id": "..."
}
```

For tool use, `content` includes `{ "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...} }` and `stop_reason` is `"tool_use"`.

## user (text echo — filtered by bridge)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "What is 1+1?"
  }
}
```

## user (tool_result)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC123",
        "content": "command output here",
        "is_error": false
      }
    ]
  }
}
```

`content` can be a string OR an array of `{type:"text", text:"..."}` — handle both.
`tool_use_id` (not `id`) links to the tool_use block.

## result

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2460,
  "duration_api_ms": 2299,
  "num_turns": 1,
  "result": "2",
  "session_id": "...",
  "total_cost_usd": 0.0849,
  "usage": {
    "input_tokens": 3,
    "output_tokens": 5,
    "cache_creation_input_tokens": 11742,
    "cache_read_input_tokens": 22679
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 3,
      "outputTokens": 5,
      "cacheReadInputTokens": 22679,
      "cacheCreationInputTokens": 11742,
      "costUSD": 0.0849,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  }
}
```

**There is no `cost_usd` field.** Use `total_cost_usd` (cumulative) or `modelUsage[model].costUSD`.

## SIGTERM/SIGKILL

CC does NOT trap SIGTERM. No result event, no flush. Process exits in ~20ms.
Bridge must synthesise the abort state transition on process exit.
Sessions survive kills — JSONL not corrupted, next `--resume` works.

## JSONL Envelope Format

Session JSONL files (on disk) and `parseSessionJSONL()` output use a wrapper:
```json
{"source": "cc", "event": {"type": "user", "message": {...}}}
```

The `event` field contains the raw CC event. Unwrap before passing to StateBuilder.

## API Error Events (assistant with isApiErrorMessage)

When the Anthropic API returns an error (e.g. 400 "Could not process image"), CC emits
an `assistant` event — not a `result` event. **No `result` event follows.** No streaming
events fire (`message_start`, `content_block_*`). The turn just... ends.

```json
{
  "type": "assistant",
  "isApiErrorMessage": true,
  "error": "unknown",
  "message": {
    "id": "msg_...",
    "model": "claude-opus-4-6",
    "role": "assistant",
    "stop_reason": "stop_sequence",
    "content": [
      {
        "type": "text",
        "text": "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Could not process image\"},\"request_id\":\"req_...\"}"
      }
    ],
    "usage": { "input_tokens": 100, "output_tokens": 0 }
  }
}
```

**Key fields:**
- `isApiErrorMessage: true` — the signal. Normal assistant events don't have this.
- `error: "unknown"` — error category (always "unknown" in observed cases).
- `message.content[0].text` — raw error with embedded JSON blob.
- **No `result` event follows** — bridge must treat this as turn-complete.

**Verified:** 2026-02-24, CC v2.1.50, session c73cd33d. Two PNG files read via the Read
tool produced base64 image blocks the API couldn't process. Every subsequent prompt
replayed the poisoned context and hit the same 400 — permanent death spiral.

## Stdin Envelope Format

```json
{"type": "user", "message": {"role": "user", "content": "text"}}
```

**`role: "user"` inside message is required** — omitting gives "Expected message role 'user', got 'undefined'".
