# Investigation: /context output not rendering in Guéridon UI

## Status: Open — bridge fix confirmed working, client rendering issue remains

## What We Know

### The bug fix works at the bridge layer
- `isUserTextEcho()` in bridge-logic.ts now returns `false` for `<local-command-stdout>` content
- The bridge buffers and forwards local command output to clients
- Confirmed via test suite (376 passing) and empirical CC spawn test

### The bug fix works at the adapter layer (partially)
- `handleUserEvent()` in claude-code-agent.ts detects `<local-command-stdout>` prefix
- Adds the message to `agent.state.messages`
- Emits `message_end` event
- `syncState()` fires in GueridonInterface, copies messages to `_messages`

### But the UI doesn't show it
- After restart with new code deployed, `/context` still produces no visible output
- The `<local-command-stdout>` content IS reaching CC (it appeared in my conversation context)
- So the event flows: CC stdout → bridge → WebSocket → adapter → state — but not → screen

## Hypotheses to Test

### H1: message_end without a preceding message_start confuses the UI
The local command output fires `message_end` directly (no `message_start` / `message_update` cycle). The `message-list` component or `streaming-message-container` might not render messages that didn't go through the full streaming lifecycle.

**Test:** Check if `message-list` renders all messages from `_messages` regardless of how they arrived, or if it relies on streaming events to create message containers.

### H2: User messages don't render after the conversation starts
The `message-list` component renders user messages that were added by `prompt()` (which fires `agent_start` + `turn_start`). A user message injected by CC (via `handleUserEvent`) might not trigger the right rendering path.

**Test:** Check how `message-list` decides which messages to render. Does it snapshot on certain events, or does it always reflect `_messages`?

### H3: The message gets added but is immediately overwritten
`syncState()` copies `agent.state.messages` into `_messages`. If `handleResult` fires immediately after and resets state, the message might be visible for one frame then gone.

**Test:** Check the result event handler — does it clear messages or streaming state that would affect display?

### H4: Lit reactivity issue
The `_messages` array reference might not change (mutation vs replacement). Lit needs a new array reference to trigger re-render.

**Test:** Check if `handleUserEvent` creates a new array (`[...this._state.messages, userMessage]`) or mutates in place. (From earlier reading: it does spread, so this is likely not the issue.)

### H5: The event arrives but the prompt() lifecycle interferes
When the user types `/context`, the client calls `prompt()` which adds a user message and sets `isStreaming = true`. Then the local command result arrives — but the streaming container might be consuming events and the `message_end` gets swallowed.

**Test:** Check the streaming container's behaviour when it receives `message_end` for a message it doesn't have (the local command output is a different message than the streaming one).

## Investigation Steps

1. **Add console.log tracing in adapter** — log when `handleUserEvent` adds a local command message, and when `message_end` is emitted
2. **Add console.log tracing in GueridonInterface** — log when `syncState` runs and what `_messages.length` is
3. **Check message-list rendering** — does it render all `_messages`, or only messages with certain properties?
4. **Check the full event sequence** — from typing `/context` to the result event, what events fire in what order? Use the bridge's WebSocket traffic or browser devtools
5. **Test with a hardcoded local command message** — inject a fake `<local-command-stdout>` user event in the adapter to see if the rendering path works at all

## Files to Examine

| File | What to Check |
|------|---------------|
| `src/gueridon-interface.ts` | `setupSubscription()` — does `message_end` path work for non-streamed messages? |
| `src/vendor/MessageList.ts` | How does it render `_messages`? Any filtering? |
| `src/message-components.ts` | Is there a renderer for `role: "user"` messages with `<local-command-stdout>` content? |
| `src/vendor/message-renderer-registry.ts` | How are message types mapped to renderers? |
| `src/claude-code-agent.ts` | The `handleUserEvent` → `message_end` flow — is there a missing `message_start`? |

## Context from Empirical Testing

CC emits this sequence for `/context`:
```
1. {"type":"system","subtype":"init",...}                          — always fires
2. {"type":"user","message":{"content":"<local-command-stdout>..."}} — the output
3. {"type":"result","subtype":"success","duration_ms":504,...}     — zero usage
```

No `stream_event`, no `assistant`, no `content_block_*` events. The adapter's streaming lifecycle (`message_start` → `content_block_delta` → `message_end`) never fires for this turn.
