# Plan: Subagent Stdout Event Filtering

**Outcome:** gdn-pimime — Subagent stdout events don't contaminate parent state

## Background

CC streams subagent (Agent/Task) events through the parent's stdout. These events
are structurally identical to parent events but carry `parent_tool_use_id` (non-null).
The bridge processes them identically, causing:

1. **Context % drops** — subagent `assistant` events overwrite `context_pct` with
   the subagent's smaller token count
2. **Phantom messages** — subagent `assistant` events pass dedup (different msg ID)
   and get pushed to `state.messages`
3. **State wipes** — subagent `message_start` resets `currentText`, `currentToolCalls`,
   `thinkingBlocks`, `blockTypes`
4. **Tool targeting bugs** — tool_complete can't find the running tool because
   subagent `message_start` pushed a new assistant skeleton between tool_start and
   tool_complete

## Historical Fixes That Were Treating Symptoms

| Commit | Fix | Subagent-related? | Unwind? |
|--------|-----|-------------------|---------|
| `17c87a7` | tool_complete backwards search | **Yes** — "Task+Thinking interleaving" | Simplify after verification |
| `9be7569` | Block index collision / mini-reset | **Partly** — genuine inner-API-call need + subagent noise | Keep core, simplify edges |
| `87b4e99` | Server-side message splitting (gdn-dakena) | **Partly** — replaced over-splitting client heuristic | Keep, observe |
| `4b36a7c` | Extract usage before dedup | **Partly** — subagent usage extracted then msg deduplicated | Keep ordering, context_pct fix covers the real issue |
| `700d25e` | suppressDeltas on mid-turn reconnect | **Independent** — real transport issue | Keep |
| `e040252` | Tool deltas through suppression | **Partly** — subagent phantom tools contributed | Keep — correct regardless |

## Phased Approach

### Phase 1: The Filter (high confidence, low risk)

Add `parent_tool_use_id` check at the top of `handleCCEvent` in `bridge.ts`.
This is the single choke point where all CC stdout events enter the bridge.

```typescript
function handleCCEvent(session: Session, event: Record<string, unknown>): void {
  // Subagent events flow through parent stdout — their usage, messages, and
  // streaming state belong to a different context window. Filter them out.
  if (event.parent_tool_use_id) return;
  ...
```

Also check inside `stream_event` wrappers — the `parent_tool_use_id` may be on
the outer wrapper OR on the inner `event` object:

```typescript
  // stream_event wrappers may carry parent_tool_use_id at the wrapper level
  if (event.type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    // Check both wrapper and inner for parent_tool_use_id
    if (event.parent_tool_use_id) return;
  }
```

**Tests:**
- Unit test: `handleCCEvent` ignores events with `parent_tool_use_id`
- Unit test: `handleCCEvent` passes parent events through (parent_tool_use_id: null)
- Integration: StateBuilder context_pct stable when interleaved subagent events arrive

### Phase 2: Capture Test (verify assumption)

We need to **prove** that subagent events carry `parent_tool_use_id` on CC's actual
stdout. The JSONL doesn't record these. Options:

1. **Instrumented bridge:** Add temporary logging in `handleCCEvent` that captures
   raw events with `parent_tool_use_id` to a debug file during Agent execution
2. **Minimal repro:** Spawn `claude -p` with Agent tool, capture raw stdout with `tee`
3. **Check the CC debug log** (`~/.claude/debug/<session>.txt`) — may contain stdout events

This is the one assumption we haven't verified from real data (the SDK docs confirm
the field exists, but we haven't seen it on actual CC stdout yet).

### Phase 3: Observe (patience required)

After Phase 1, run normally for several sessions with Agent-heavy workloads:

- [ ] Context % stays stable during Agent execution
- [ ] No phantom assistant messages appear in the message list
- [ ] tool_complete targeting doesn't break
- [ ] Message overwrite bugs don't recur
- [ ] Mid-turn reconnect shows correct state

### Phase 4: Simplify Guards (only after Phase 3 confirms)

**Candidates for simplification (not removal):**

1. **tool_complete backwards search** (`17c87a7`): If phantom messages stop being
   inserted, the backwards search is unnecessary — can revert to checking only
   the last message. Keep the test, change the implementation.

2. **Block index collision detector** (`9be7569`, `87b4e99`): The core logic is still
   needed for genuine parent inner API calls (which don't emit `message_start`).
   But some of the edge-case handling was added for subagent-caused collisions.
   Observe which collision paths still fire with the filter in place.

3. **`turnHasAssistant` guard** (line 564): The mini-reset on second assistant message
   within a turn was partly compensating for subagent assistant messages arriving.
   With filtering, this guard fires less often. Keep — still needed for genuine
   multi-assistant turns.

**Do NOT simplify yet:**
- `suppressDeltas` — independent transport issue
- `seenMessageIds` dedup — needed for `--include-partial-messages` regardless
- `currentMessagePushed` guard — prevents content_block_stop patching wrong message

### Phase 5: Documentation

- [x] CC-EVENTS.md — subagent event section added
- [x] empirical-verification.md — diagnosis documented
- [ ] CLAUDE.md — add invariant: "bridge filters subagent events by parent_tool_use_id"
- [ ] State builder comments — note which guards are still needed post-filter

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `parent_tool_use_id` not present on stdout events | Low (SDK docs confirm, CC-EVENTS.md sample shows it) | Phase 2 capture test |
| Filtering breaks something that needs subagent events | Very low (bridge has no legitimate use for subagent state) | Phase 3 observation |
| Simplifying guards introduces new bugs | Medium | Only simplify after observation; keep tests |
| CC changes the field name in future versions | Low | Version-gate the filter, add fallback logging |
