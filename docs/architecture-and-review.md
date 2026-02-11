# Architecture Map & Code Review

*Recovered from blown session 6c561b96, 2026-02-09. Three-lens (titans) review + full architecture mapping.*

## The Big Picture

```
index.html
  └── src/main.ts  ─── creates & wires ──→  3 core objects
        │
        ├── ClaudeCodeAgent    (adapter: CC JSON events → pi AgentEvents)
        ├── GueridonInterface  (Lit component: the chat UI)
        └── WSTransport        (WebSocket: browser ↔ bridge)

npm run bridge
  └── server/bridge.ts  ─── spawns ──→  claude -p --stream-json
        └── server/bridge-logic.ts  (pure decision functions)
        └── server/folders.ts       (scans ~/Repos for folders)
```

Two processes. Browser talks to bridge via WebSocket. Bridge talks to Claude Code via stdin/stdout.

## The File Map (12 source files + 6 vendored)

**Server (Node.js, port 3001)**

| File | Does |
|------|------|
| `server/bridge.ts` | WebSocket server, spawns CC processes, routes messages. Module-level side effect (WSS starts on import). |
| `server/bridge-logic.ts` | Pure functions: session resolution, path validation, CC CLI args, conflation helpers, idle guards. Testable. |
| `server/folders.ts` | Scans `~/Repos`, enriches with CC session/handoff state from filesystem. |

**Client application (browser, port 5173)**

| File | Does |
|------|------|
| `src/main.ts` | Entry point. Creates agent + transport + UI, wires callbacks, renders into `#app`. |
| `src/gueridon-interface.ts` | `<gueridon-interface>` — the shell. Input bar, message display, auto-scroll, gauge, toast. Light DOM. |
| `src/claude-code-agent.ts` | Adapter. Translates CC stream-json → pi-agent-core AgentEvents. No DOM, no WS — pure event translation. |
| `src/ws-transport.ts` | Browser WebSocket. Lobby/session modes, reconnect with backoff, prompt timeout. Implements `CCTransport`. |
| `src/folder-selector.ts` | `<folder-selector>` — modal dialog, extends mini-lit's DialogBase. |
| `src/ask-user-overlay.ts` | Bottom-sheet for CC's AskUserQuestion tool. Plain functions, not a custom element. |
| `src/message-components.ts` | `<user-message>`, `<assistant-message>`, `<tool-message>` — our leaf renderers. |
| `src/app.css` | Tailwind entry + mini-lit theme + custom styles (user pill, shimmer, scrollbar). |

**Vendored from pi-mono (src/vendor/, frozen at commit 41c4157b)**

| File | Does |
|------|------|
| `MessageList.ts` | `<message-list>` — renders stable message history. Dumb renderer, 12 props. |
| `StreamingMessageContainer.ts` | `<streaming-message-container>` — in-flight message with batched RAF updates. Imperative `setMessage()`. |
| `ThinkingBlock.ts` | `<thinking-block>` — collapsible thinking section with shimmer. |
| `ConsoleBlock.ts` | `<console-block>` — bash output with copy button. |
| `message-renderer-registry.ts` | Extensibility hook for custom renderers by role. MessageList calls it. |
| `i18n.ts` | Trimmed i18n (10 keys, not 200+). Re-exports from mini-lit. |

## Custom Element Nesting

```
<gueridon-interface>                         [ours]
  ├── <message-list>                         [vendored]
  │     ├── <user-message>                   [ours]
  │     │     └── <markdown-block>           [mini-lit npm]
  │     └── <assistant-message>              [ours]
  │           ├── <markdown-block>           [mini-lit npm]
  │           ├── <thinking-block>           [vendored]
  │           └── <tool-message>             [ours]
  │                 ├── <console-block>      [vendored, for Bash]
  │                 └── <code-block>         [mini-lit npm, for other tools]
  └── <streaming-message-container>          [vendored]
        └── <assistant-message>              [ours, same as above]

<folder-selector>                            [ours, modal overlay]
```

## npm Dependencies — What's Real vs Dead

| Package | Actually used? | Import type |
|---------|---------------|-------------|
| `@mariozechner/mini-lit` | **Yes** — icons, DialogBase, CSS theme, i18n | Value + types |
| `@mariozechner/pi-agent-core` | **Yes** — AgentEvent, AgentMessage, etc. | **Types only** |
| `@mariozechner/pi-ai` | **Yes** — Model, Usage types | **Types only** |
| `@mariozechner/pi-web-ui` | **NO — dead dependency** | Not imported anywhere |
| `lit` | **Yes** — everywhere | Value + types |
| `ws` | **Yes** — bridge server only | Value (server) |
| `lucide` | **Yes** (implicit) — icon SVGs in message-components + vendored | Value |

## Build Pipeline

```
index.html → Vite →  1. litClassFieldFix()   rewrites __defNormalProp for Lit reactivity
                      2. tailwindcss()         processes @import/@source in app.css
                      3. Lit dedup aliases      ensures one copy of lit + @lit/reactive-element
                      4. esbuild (es2020)       transpiles TS, class fields use [[Set]]
                  → dist/
```

The `litClassFieldFix` plugin is critical — without it, `@state()` properties on *any* Lit component (ours or vendored) silently fail to trigger re-renders.

---

## Three-Lens Code Review

### Critical / High Priority

| # | Finding | Source | Action |
|---|---------|--------|--------|
| 1 | ~~**Agent state never resets between folder switches**~~ **FIXED (gdn-walaco)** — `reset()` method added, called on folder switch. | Epimetheus | ~~Add `reset()` method, call on folder switch~~ Done |
| 2 | **`pi-web-ui` still in package.json** — dead dependency, pulls entire transitive chain (pdfjs, xlsx, @aws-sdk). Directly contradicts the vendoring work. | All three | Remove from package.json |
| 3 | ~~**`message_end` emitted before `pendingToolCalls` populated**~~ **FIXED (gdn-zuhacu)** — `tool_execution_start/end` added to setupSubscription. | Epimetheus | ~~Handle `tool_execution_start/end` in subscription~~ Done |
| 4 | ~~**`prompt()` swallows transport absence**~~ **FIXED (gdn-vosejo)** — guard sets error + emits agent_end. | Epimetheus | ~~Guard against null transport~~ Done |
| 5 | ~~**Unknown CC event types silently dropped**~~ **FIXED (gdn-pudaco)** — default cases with `console.debug` in both handlers. | Prometheus | ~~Add default case with logging~~ Done |
| 6 | **`litClassFieldFix` regex fragility** — depends on exact esbuild output format. Failure = blank components. Warning exists but build test doesn't catch it. | Prometheus, Epimetheus | Investigate `useDefineForClassFields: false` as alternative |
| 7 | **No client-side message persistence** — page refresh loses entire conversation. The biggest UX gap for mobile (tabs get killed). | Prometheus | IndexedDB persistence or replay capture |

### Medium Priority

| # | Finding | Source |
|---|---------|--------|
| 8 | Token sum calculation duplicated 3x — bug magnet if CC adds token fields | Metis |
| 9 | `CCEvent` type too loose (`[key: string]: any`) — no exhaustive switch checking | Metis |
| 10 | Toast element leaks on disconnect — appended to `document.body`, never removed | Epimetheus, Metis |
| 11 | `console.trace` left in FolderSelector — debug instrumentation in production | Metis |
| 12 | No `visibilitychange` listener — mobile tab resume waits up to 30s for reconnect | Prometheus |
| 13 | `toolCallNames` + `askUserToolCallIds` grow unbounded across sessions | Epimetheus |
| 14 | Lobby queue has no `.catch()` — one error breaks all subsequent lobby messages | Epimetheus |
| 15 | Handoff parsing assumes exact line positions — format change = silent failure | Epimetheus |
| 16 | Tab indentation inconsistency in message-components.ts (tabs vs spaces) | Metis |

### Low Priority

| # | Finding |
|---|---------|
| 17 | Dead stubs: `streamFn`, `getApiKey`, `setModel`, `setThinkingLevel`, `setTools` |
| 18 | Paperclip button has no handler (placeholder) |
| 19 | `@property({ type: Object })` should be `attribute: false` on message components |
| 20 | No PWA manifest for home screen install |
| 21 | No WebSocket compression (perMessageDeflate) |
| 22 | No auth on bridge server (fine for localhost, risky for network) |
| 23 | `_state.error` is set but never rendered in UI |

### What the reviewers praised

All three noted the code is **well-structured for its age and scope**. Specific praise for:
- Clean layer separation (transport / adapter / UI / bridge never leak concerns)
- Comments that explain *why*, not what
- Strong test suite (183 tests, multiple strategies)
- Correct Lit idioms (light DOM, connectedCallback classes, @query guards)
- `bridge-logic.ts` extraction was the right call
- State derivation in `folders.ts` encodes hard-won knowledge well

## Message Replay: Two Paths

There are two distinct replay mechanisms, both producing the same wire format for the adapter:

| Path | When | Source | User messages from |
|------|------|--------|--------------------|
| **Live buffer replay** | Page refresh during active session | `session.messageBuffer` (CC stdout events) | Bridge injects at prompt time |
| **JSONL replay** | Resuming a paused session | `parseSessionJSONL()` reads CC's `~/.claude/projects/` file | CC's own session JSONL |

Both produce `{source: "cc", event: {type: "user", message: {role: "user", content: "..."}}}`.

**Why two paths:** The live buffer captures events as they happen (including conflated deltas). The JSONL file is CC's own record, which has different structure (grouped by message ID, no stream_events). `parseSessionJSONL` translates the JSONL format into the same wire events the adapter expects.

**Conflation note (2026-02-11):** Live buffer now stores *merged* content_block_delta events (one per 250ms tick) rather than raw token-rate deltas. JSONL replay produces no deltas at all (only complete assistant messages). Both paths work because the adapter handles either format — stream events build up `streamMessage`, complete `assistant` events replace it.
