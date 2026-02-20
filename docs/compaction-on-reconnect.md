# Compaction on Reconnect

Design note on mid-stream reconnection for the SSE bridge. Prompted by
[zknill's article](https://zknill.io/posts/chatbots-worst-enemy-is-page-refresh/)
on the page-refresh problem in chatbot UIs.

## The problem

When a client reconnects mid-stream (page refresh, network drop, tab
switch on mobile), the bridge sends a state snapshot via
`stateBuilder.getState()`. But `getState()` only includes **completed
messages** — the in-progress assistant response (accumulated in
`currentText` and `currentToolCalls`) hasn't been committed to the
`messages[]` array yet. That happens in `handleAssistant()`, which fires
at turn end.

Result: a client reconnecting while CC is streaming sees the
conversation history but not the response being generated right now.
It picks up live deltas going forward, but the text generated between
the last `content_block_stop` and the reconnect moment is invisible
until the next delta or turn end.

## The fix: compacted snapshot

On reconnect, the state snapshot should include a **partial message**
representing the in-progress response:

```typescript
// In StateBuilder
getState(): BBState {
  const state = JSON.parse(JSON.stringify(this.state));

  // If mid-stream, append a partial assistant message
  if (this.currentText || this.currentToolCalls.length > 0) {
    state.messages.push({
      role: "assistant",
      content: this.currentText || null,
      partial: true,  // client knows this message is still streaming
      ...(this.currentToolCalls.length > 0 && {
        tool_calls: this.currentToolCalls,
      }),
    });
  }

  return state;
}
```

The client receives one event — the full conversation including
everything generated so far — and then resumes consuming live deltas.
No replay of individual `content_block_delta` events. No gap.

This is what Ably calls "message.append" semantics: connected clients
see individual token deltas, reconnecting clients see the compacted
result. Same data, different delivery.

## What the client needs to handle

1. **`partial: true` messages** — render like a normal assistant message
   but expect it to be replaced/extended by subsequent deltas.

2. **Dedup on turn complete** — when the full `assistant` event arrives
   and `handleAssistant()` commits the final message, the client must
   replace the partial message, not append a duplicate.

3. **No partial + no deltas** — if the partial message exists but no
   further deltas arrive (CC died mid-stream), the client shows what
   it has. The partial flag tells the UI to show an incomplete
   indicator.

## Why this matters on mobile

Gueridon's primary client is a phone on a cellular connection routed
through a DERP relay. Connections drop constantly — not from explicit
refreshes but from:

- iOS backgrounding the browser tab (30s–60s)
- Network switches (wifi ↔ cellular)
- DERP relay reconnection

Without compaction, every reconnect shows a conversation that's
"behind" reality for up to several seconds (or longer for slow
tool-heavy turns). With compaction, reconnect is seamless — the user
sees exactly what a continuously-connected client would see.

## Scope

This is a StateBuilder change + a small SSE bridge adjustment. The
reconnect contract in `bridge-sse.ts` already sends `getState()` on
session bind (line 669). Making `getState()` include partial messages
is all that's needed server-side.

Client-side needs the partial message handling described above. The
current web client doesn't have an SSE transport yet (only
`ws-transport.ts`), so this would be built into the new SSE transport
from the start.

## Provenance

Pattern observed in Ably's "message.append" design for AI token
streaming. Extracted here as a transport-agnostic principle:
**connected clients get deltas, reconnecting clients get compacted
state.** The stateful intermediary (our bridge) is what makes this
possible — without it, you're stuck with the Claude.ai refresh
experience.
