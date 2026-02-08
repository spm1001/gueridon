# Event Mapping: Claude Code → pi-web-ui AgentEvents

## The Interface Contract

`<agent-interface>` from pi-web-ui expects a `session` object with:

### Required State (AgentState)
```typescript
{
  systemPrompt: string;          // can be empty
  model: Model<any>;             // needs id, name at minimum
  thinkingLevel: ThinkingLevel;  // "off" | "minimal" | ...
  tools: AgentTool<any>[];       // can be empty array
  messages: AgentMessage[];      // accumulated conversation
  isStreaming: boolean;
  streamMessage: AgentMessage | null;
  pendingToolCalls: Set<string>;
  error?: string;
}
```

### Required Methods
```typescript
subscribe(fn: (e: AgentEvent) => void): () => void
prompt(message: string | AgentMessage): Promise<void>
abort(): void
setModel(m: Model<any>): void       // can be no-op
setThinkingLevel(l): void           // can be no-op
```

### Required Public Fields
```typescript
streamFn: any       // AgentInterface checks if === streamSimple, set to non-streamSimple value
getApiKey: any      // AgentInterface checks if falsy, set to a stub
```

## Event Mapping

### Text Response (with --include-partial-messages)

| Claude Code Event | → AgentEvent | Notes |
|---|---|---|
| First `{"type":"user",...}` sent | `{ type: "agent_start" }` then `{ type: "turn_start" }` | Emit when prompt() called |
| `stream_event/message_start` | `{ type: "message_start", message }` | Build partial AssistantMessage from CC's message |
| `stream_event/content_block_delta` (text) | `{ type: "message_update", message, assistantMessageEvent }` | `assistantMessageEvent = { type: "text_delta", contentIndex, delta, partial }` |
| `stream_event/content_block_stop` | — | Internal bookkeeping only |
| `stream_event/message_stop` | `{ type: "message_end", message }` | Final accumulated message |
| `result/success` | `{ type: "turn_end", message, toolResults: [] }` then `{ type: "agent_end", messages }` | |

### Tool Use Response

With `--include-partial-messages`, tool use arguments stream as `input_json_delta`:

| Claude Code Event | → AgentEvent | Notes |
|---|---|---|
| `stream_event/content_block_start` (type=tool_use) | `{ type: "message_update", message, assistantMessageEvent: { type: "toolcall_start" } }` | Start building ToolCall in content |
| `stream_event/content_block_delta` (input_json_delta) | `{ type: "message_update", ..., assistantMessageEvent: { type: "toolcall_delta" } }` | Accumulate JSON fragments |
| `stream_event/content_block_stop` | `{ type: "message_update", ..., assistantMessageEvent: { type: "toolcall_end" } }` | Complete ToolCall with parsed arguments |
| `assistant` (complete, with tool_use content) | `{ type: "message_end", message }` | Message contains toolCall in content |
| (after message_end) | `{ type: "tool_execution_start", toolCallId, toolName, args }` | Add to pendingToolCalls |
| `user` with `tool_result` | `{ type: "tool_execution_end", toolCallId, toolName, result, isError }` | Remove from pendingToolCalls |
| Next `assistant` (text) | New `message_start` → `message_update` → `message_end` cycle | |
| `result/success` | `{ type: "turn_end" }` + `{ type: "agent_end" }` | |

**Tool use stop_reason:** When the assistant message contains only tool_use (no text), the `message_delta` event has `stop_reason: "tool_use"` instead of `"end_turn"`. Map both to pi's `stopReason: "toolUse"` or `"stop"` accordingly.

## Message Type Mapping

### Claude Code AssistantMessage → pi AssistantMessage

```typescript
// From Claude Code:
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." }
      // or { "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...} }
    ],
    "stop_reason": null,
    "usage": { "input_tokens": 3, "output_tokens": 10, ... }
  }
}

// Map to pi:
{
  role: "assistant",
  content: [
    { type: "text", text: "..." }
    // or { type: "toolCall", id: "toolu_...", name: "Bash", arguments: {...} }
  ],
  api: "anthropic",
  provider: "anthropic",
  model: "claude-opus-4-6",
  usage: { input: N, output: N, cacheRead: N, cacheWrite: N, totalTokens: N, cost: {...} },
  stopReason: "stop",  // map from CC's stop_reason / result event
  timestamp: Date.now()
}
```

**Content block mapping:**
- CC `{ "type": "text", "text": "..." }` → pi `{ type: "text", text: "..." }` (same shape!)
- CC `{ "type": "tool_use", "id", "name", "input" }` → pi `{ type: "toolCall", id, name, arguments: input }`

### Claude Code Tool Result → pi ToolResultMessage

```typescript
// From Claude Code:
{
  "type": "user",
  "message": { "content": [{ "tool_use_id": "...", "type": "tool_result", "content": "...", "is_error": false }] },
  "tool_use_result": { "stdout": "...", "stderr": "...", "interrupted": false, "isImage": false }
}

// Map to pi:
{
  role: "toolResult",
  toolCallId: "...",
  toolName: "Bash",  // need to look up from the preceding tool_use
  content: [{ type: "text", text: "..." }],
  details: { stdout: "...", stderr: "...", interrupted: false },  // for custom renderers
  isError: false,
  timestamp: Date.now()
}
```

## State Management

The adapter maintains `AgentState` locally:

1. **On prompt()**: Set `isStreaming = true`, emit `agent_start` + `turn_start`
2. **On stream deltas**: Update `streamMessage` (partial AssistantMessage), emit `message_update`
3. **On message complete**: Move `streamMessage` → append to `messages`, set `streamMessage = null`
4. **On tool_use**: Add tool call ID to `pendingToolCalls`
5. **On tool_result**: Remove from `pendingToolCalls`, append ToolResultMessage to `messages`
6. **On result/success**: Set `isStreaming = false`, emit `turn_end` + `agent_end`
7. **On error**: Set `error` string, `isStreaming = false`

## Verified: Thinking Blocks

Enabled via `MAX_THINKING_TOKENS=5000` (or any non-zero value) environment variable on the Claude Code process. Also controllable via `CLAUDE_CODE_EFFORT_LEVEL=high`.

**Stream sequence:**
```
stream_event/content_block_start   → content_block.type: "thinking"
stream_event/content_block_delta   → delta.type: "thinking_delta", delta.thinking: "..."  (×N)
stream_event/content_block_delta   → delta.type: "signature_delta"  (integrity check)
stream_event/content_block_stop
stream_event/content_block_start   → content_block.type: "text"
stream_event/content_block_delta   → delta.type: "text_delta", delta.text: "..."  (×N)
stream_event/content_block_stop
```

**In complete assistant message**, both blocks appear:
```json
{"type":"assistant","message":{"content":[
  {"type":"thinking","thinking":"The prime numbers less than 20 are..."},
  {"type":"text","text":"The answer is 77"}
]}}
```

**Mapping to pi-web-ui:** Direct match. pi's `ThinkingContent` is `{type: "thinking", thinking: "...", thinkingSignature?: "..."}`. Pass through. The `signature_delta` maps to `thinkingSignature`.

**For the bridge:** Set `MAX_THINKING_TOKENS` or `CLAUDE_CODE_EFFORT_LEVEL` in the process environment when spawning. Could expose thinking toggle in the mobile UI if desired.

## Artifacts

Claude Code does NOT have a native artifact concept in stream-json. When asked to create HTML/SVG, it uses the `Write` tool:

```jsonl
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/file.html","content":"<!DOCTYPE html>..."}}]}}
```

The `tool_use_result` metadata includes: `{"type":"create","filePath":"/tmp/file.html","content":"..."}`.

**Adapter options:**
1. **Detect Write of .html/.svg/.md files** → create pi's `ArtifactMessage` → render in sandboxed iframe
2. **Show as tool result** → user sees "File created at /tmp/file.html" (simple, defer artifact rendering)
3. **Serve written files via bridge** → bridge has a static file endpoint, WebSocket sends URL to iframe

Start with option 2, add option 1 as polish.

## Attachments (Mobile File Upload)

Mobile browser file upload → WebSocket → bridge needs to:
1. Receive binary data over WebSocket
2. Write to a temp directory on the server
3. Reference the file path in the user message to Claude Code

pi-web-ui supports `Attachment` objects (`{id, type, fileName, mimeType, size, content: base64, extractedText?}`).

For the bridge, the flow is:
- Mobile UI sends attachment via WebSocket (base64 or binary frame)
- Bridge writes to `/tmp/gueridon-uploads/<session-id>/<filename>`
- Bridge constructs user message: `"I've uploaded a file at /tmp/gueridon-uploads/.../photo.jpg. [extracted text if document]"`
- Claude Code reads the file via its Read tool

For images, Claude Code can read image files directly. For documents (PDF, etc.), the bridge should extract text before sending.

## What to Stub

| pi-web-ui expects | Guéridon provides | Why |
|---|---|---|
| `model` in state | Static `Model` object with CC's model ID | CC manages model selection |
| `thinkingLevel` | `"off"` | CC manages thinking internally |
| `tools` array | Empty `[]` or populated from init event | For display only |
| `streamFn` | `() => {}` (non-null stub) | Prevents AgentInterface from patching it |
| `getApiKey` | `() => "max-subscription"` | Prevents API key dialog |
| `setModel()` | No-op | CC manages this |
| `setThinkingLevel()` | No-op | CC manages this |
