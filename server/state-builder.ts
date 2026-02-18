/**
 * Server-side state builder: translates CC stdout events into BB's state.json shape.
 *
 * Replaces the 815-line client-side claude-code-agent.ts adapter.
 * Pure state machine — no IO, no network, no process management.
 */

// -- BB State types (exported for bridge-sse.ts and tests) --

export interface BBState {
  session: { id: string; model: string; project: string; context_pct: number };
  messages: BBMessage[];
  connection: "connected" | "disconnected";
  status: "working" | "idle" | "error";
  error: string | null;
  slashCommands: BBSlashCommand[] | null;
}

export interface BBMessage {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: BBToolCall[];
}

export interface BBToolCall {
  name: string;
  status: "running" | "completed" | "error";
  input: string;
  output: string | null;
  collapsed: boolean;
}

export interface BBSlashCommand {
  name: string;
  description: string;
  local: boolean;
}

// -- SSE delta types (what handleEvent returns for the bridge to broadcast) --

export type SSEDelta =
  | { type: "status"; status: "working" | "idle" }
  | { type: "activity"; activity: "thinking" | "writing" | "tool" }
  | { type: "content"; index: number; text: string }
  | { type: "tool_start"; index: number; name: string; input: string }
  | { type: "tool_complete"; index: number; status: "completed" | "error"; output?: string }
  | null;

// -- Constants --

const LOCAL_CMDS = new Set(["context", "cost", "compact", "help", "clear"]);
const DEFAULT_CONTEXT_WINDOW = 200_000;

// -- Helper: extract human-readable tool input --

function extractToolInput(name: string, args: Record<string, unknown>): string {
  if (name === "Bash") return (args.command as string) || "";
  if (name === "Read" || name === "Write" || name === "Edit")
    return (args.file_path as string) || "";
  if (name === "Grep") return (args.pattern as string) || "";
  if (name === "Glob") return (args.pattern as string) || "";
  if (name === "WebFetch") return (args.url as string) || "";
  if (name === "WebSearch") return (args.query as string) || "";
  if (name === "Task") return ((args.prompt as string) || "").slice(0, 100);
  // Fallback: first short string value
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length < 200) return v;
  }
  return JSON.stringify(args).slice(0, 100);
}

// -- StateBuilder --

export class StateBuilder {
  private state: BBState;

  // Streaming accumulation
  private currentText = "";
  private currentToolCalls: BBToolCall[] = [];
  private pendingToolJson = new Map<number, string>();    // block index → accumulated JSON
  private toolIdToIndex = new Map<string, number>();       // tool_use_id → index in currentToolCalls
  private blockTypes = new Map<number, string>();          // block index → "text" | "tool_use" | "thinking"
  private toolBlockToCallIndex = new Map<number, number>(); // block index → index in currentToolCalls

  // Dedup & context
  private seenMessageIds = new Set<string>();
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private lastInputTokens = 0;

  constructor(sessionId: string, project: string) {
    this.state = {
      session: { id: sessionId, model: "", project, context_pct: 0 },
      messages: [],
      connection: "connected",
      status: "idle",
      error: null,
      slashCommands: null,
    };
  }

  getState(): BBState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Process a CC event, return an SSE delta to broadcast (or null). */
  handleEvent(event: Record<string, unknown>): SSEDelta {
    switch (event.type) {
      case "system":
        return this.handleSystem(event);
      case "stream_event":
        return this.handleStreamEvent(event);
      case "assistant":
        return this.handleAssistant(event);
      case "user":
        return this.handleUser(event);
      case "result":
        return this.handleResult(event);
      default:
        return null;
    }
  }

  /** Replay JSONL events (from parseSessionJSONL). Builds state silently — no deltas. */
  replayFromJSONL(events: string[]): void {
    for (const str of events) {
      let wrapper: { event?: Record<string, unknown> };
      try {
        wrapper = JSON.parse(str);
      } catch {
        continue;
      }
      const ccEvent = wrapper.event;
      if (ccEvent) {
        this.handleEvent(ccEvent);
      }
    }
  }

  // -- Event handlers --

  private handleSystem(event: Record<string, unknown>): SSEDelta {
    if (event.subtype !== "init") return null;

    if (event.model) this.state.session.model = event.model as string;
    if (event.session_id) this.state.session.id = event.session_id as string;

    // Slash commands — handle both string and {name, description} shapes
    const rawCmds = event.slash_commands as unknown[] | undefined;
    if (rawCmds && Array.isArray(rawCmds)) {
      this.state.slashCommands = rawCmds.map((cmd) => {
        if (typeof cmd === "string") {
          const name = cmd.replace(/^\//, "");
          return { name, description: "", local: LOCAL_CMDS.has(name) };
        }
        const obj = cmd as { name?: string; description?: string };
        const name = (obj.name || "").replace(/^\//, "");
        return {
          name,
          description: obj.description || "",
          local: LOCAL_CMDS.has(name),
        };
      });
    }

    this.state.status = "working";
    return { type: "status", status: "working" };
  }

  private handleStreamEvent(event: Record<string, unknown>): SSEDelta {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner) return null;

    switch (inner.type) {
      case "message_start":
        return this.onMessageStart();
      case "content_block_start":
        return this.onContentBlockStart(inner);
      case "content_block_delta":
        return this.onContentBlockDelta(inner);
      case "content_block_stop":
        return this.onContentBlockStop(inner);
      default:
        return null; // message_delta, message_stop — no BB-relevant data
    }
  }

  private onMessageStart(): SSEDelta {
    this.currentText = "";
    this.currentToolCalls = [];
    this.pendingToolJson.clear();
    this.blockTypes.clear();
    this.toolBlockToCallIndex.clear();
    return null;
  }

  private onContentBlockStart(inner: Record<string, unknown>): SSEDelta {
    const index = inner.index as number;
    const block = inner.content_block as Record<string, unknown> | undefined;
    if (!block) return null;

    const blockType = block.type as string;
    this.blockTypes.set(index, blockType);

    if (blockType === "text") {
      return { type: "activity", activity: "writing" };
    }

    if (blockType === "tool_use") {
      const name = (block.name as string) || "Unknown";
      const toolId = block.id as string;
      const call: BBToolCall = {
        name,
        status: "running",
        input: "",
        output: null,
        collapsed: true,
      };
      const callIndex = this.currentToolCalls.length;
      this.currentToolCalls.push(call);
      if (toolId) this.toolIdToIndex.set(toolId, callIndex);
      this.toolBlockToCallIndex.set(index, callIndex);
      return { type: "activity", activity: "tool" };
    }

    if (blockType === "thinking") {
      return { type: "activity", activity: "thinking" };
    }

    return null;
  }

  private onContentBlockDelta(inner: Record<string, unknown>): SSEDelta {
    const index = inner.index as number;
    const delta = inner.delta as Record<string, unknown> | undefined;
    if (!delta) return null;

    if (delta.type === "text_delta") {
      this.currentText += (delta.text as string) || "";
      return null; // text aggregated, emitted at content_block_stop
    }

    if (delta.type === "input_json_delta") {
      const existing = this.pendingToolJson.get(index) || "";
      this.pendingToolJson.set(index, existing + ((delta.partial_json as string) || ""));
      return null;
    }

    // thinking_delta — ignore
    return null;
  }

  private onContentBlockStop(inner: Record<string, unknown>): SSEDelta {
    const index = inner.index as number;
    const blockType = this.blockTypes.get(index);

    if (blockType === "text") {
      return { type: "content", index, text: this.currentText };
    }

    if (blockType === "tool_use") {
      const callIndex = this.toolBlockToCallIndex.get(index);
      if (callIndex === undefined) return null;

      const call = this.currentToolCalls[callIndex];
      const rawJson = this.pendingToolJson.get(index);
      if (rawJson) {
        try {
          const args = JSON.parse(rawJson);
          call.input = extractToolInput(call.name, args);
        } catch {
          call.input = rawJson.slice(0, 100);
        }
      }

      return { type: "tool_start", index: callIndex, name: call.name, input: call.input };
    }

    return null; // thinking — nothing to emit
  }

  private handleAssistant(event: Record<string, unknown>): SSEDelta {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    // Deduplicate by message ID
    const msgId = message.id as string;
    if (msgId) {
      if (this.seenMessageIds.has(msgId)) return null;
      this.seenMessageIds.add(msgId);
    }

    // Extract context tokens from per-message usage
    const usage = message.usage as Record<string, number> | undefined;
    if (usage) {
      this.lastInputTokens =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
      this.state.session.context_pct = Math.round(
        (this.lastInputTokens / this.contextWindow) * 100,
      );
    }

    // Build assistant message — prefer streaming accumulation, fall back to
    // content array from complete message (JSONL replay has no streaming events)
    let text = this.currentText || null;
    let toolCalls = this.currentToolCalls.length > 0 ? this.currentToolCalls : undefined;

    if (!text && !toolCalls) {
      const contentBlocks = message.content as unknown[] | undefined;
      if (Array.isArray(contentBlocks)) {
        const textParts: string[] = [];
        const calls: BBToolCall[] = [];
        for (const block of contentBlocks) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && b.text) {
            textParts.push(b.text as string);
          } else if (b.type === "tool_use") {
            const args = (b.input as Record<string, unknown>) || {};
            calls.push({
              name: (b.name as string) || "Unknown",
              status: "completed", // replay = already completed
              input: extractToolInput((b.name as string) || "", args),
              output: null,
              collapsed: true,
            });
            if (b.id) this.toolIdToIndex.set(b.id as string, calls.length - 1);
          }
        }
        if (textParts.length > 0) text = textParts.join("\n");
        if (calls.length > 0) {
          toolCalls = calls;
          this.currentToolCalls = calls; // so tool_result can find them
        }
      }
    }

    const msg: BBMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls && { tool_calls: toolCalls }),
    };
    this.state.messages.push(msg);

    return null; // full state sent on result
  }

  private handleUser(event: Record<string, unknown>): SSEDelta {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const content = message.content;

    // String content = user text
    if (typeof content === "string") {
      this.state.messages.push({ role: "user", content });
      return null;
    }

    // Array content = tool results
    // Note: returns only the LAST tool_complete delta. The bridge should call
    // handleEvent per tool_result if it needs all deltas broadcast individually.
    // In practice, tool results arrive as a batch and the full state snapshot
    // at turn end corrects any UI lag. Acceptable trade-off for now.
    if (Array.isArray(content)) {
      let lastDelta: SSEDelta = null;
      for (const block of content) {
        if (block.type !== "tool_result") continue;

        const toolUseId = block.tool_use_id as string;
        const idx = this.toolIdToIndex.get(toolUseId);
        if (idx === undefined) continue;

        const call = this.currentToolCalls[idx];
        if (!call) continue;

        // Extract result text — can be string or array of {type:"text", text:"..."}
        let resultText: string | null = null;
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          resultText = block.content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text as string)
            .join("\n");
        }

        const status = block.is_error ? "error" : "completed";
        call.status = status;
        call.output = resultText;

        lastDelta = {
          type: "tool_complete",
          index: idx,
          status: status as "completed" | "error",
          ...(resultText && { output: resultText.slice(0, 500) }),
        };
      }
      return lastDelta;
    }

    return null;
  }

  private handleResult(event: Record<string, unknown>): SSEDelta {
    this.state.status = "idle";

    // Extract contextWindow from modelUsage
    const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
    if (modelUsage) {
      const firstModel = Object.values(modelUsage)[0];
      if (firstModel?.contextWindow) {
        this.contextWindow = firstModel.contextWindow as number;
        // Recompute with updated window
        if (this.lastInputTokens > 0) {
          this.state.session.context_pct = Math.round(
            (this.lastInputTokens / this.contextWindow) * 100,
          );
        }
      }
    }

    return { type: "status", status: "idle" };
  }
}
