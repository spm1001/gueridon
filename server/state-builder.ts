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
  slashCommands: BBSlashCommand[] | null;
}

export interface BBMessage {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: BBToolCall[];
  thinking?: string;
  synthetic?: boolean;
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

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export type SSEDelta =
  | { type: "status"; status: "working" | "idle" }
  | { type: "activity"; activity: "thinking" | "writing" | "tool" }
  | { type: "content"; index: number; text: string }
  | { type: "thinking_content"; text: string }
  | { type: "tool_start"; index: number; name: string; input: string }
  | { type: "tool_complete"; index: number; status: "completed" | "error"; output?: string }
  | { type: "ask_user"; questions: AskUserQuestion[]; toolCallId: string }
  | { type: "message_start" }
  | { type: "api_error"; error: string }
  | null;

// -- Constants --

// CC-reported commands tagged local: true (auto-send in frontend).
// Bridge-only commands (abort, exit) live in index.html BRIDGE_COMMANDS — not here.
const LOCAL_CMDS = new Set(["context", "cost", "compact", "help", "clear"]);
const DEFAULT_CONTEXT_WINDOW = 200_000;

// -- Helper: extract human-readable tool input --

function extractToolInput(name: string, args: Record<string, unknown>): string {
  if (name === "Bash") return (args.command as string) || "";
  if (name === "Read" || name === "Write" || name === "Edit")
    return (args.file_path as string) || "";
  if (name === "Grep") return (args.pattern as string) || "";
  if (name === "Glob") return (args.pattern as string) || "";
  if (name === "WebSearch") return (args.query as string) || "";
  if (name === "Task") return ((args.prompt as string) || "").slice(0, 100);
  // Fallback: first short string value
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length < 200) return v;
  }
  return JSON.stringify(args).slice(0, 100);
}

// -- Helper: extract human-readable error from CC API error message --

function extractApiErrorText(message: Record<string, unknown>): string {
  const contentBlocks = message.content as unknown[] | undefined;
  if (!Array.isArray(contentBlocks)) return "API error";

  const raw = contentBlocks
    .filter((b: unknown) => (b as Record<string, unknown>).type === "text")
    .map((b: unknown) => (b as Record<string, unknown>).text as string)
    .join(" ");

  // Extract the human-readable message from the JSON blob
  // Raw: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"},...}'
  try {
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const apiMessage = parsed?.error?.message;
      if (apiMessage) {
        const status = raw.match(/API Error: (\d+)/)?.[1] || "?";
        return `API error ${status}: ${apiMessage}`;
      }
    }
  } catch { /* fall through to raw */ }

  return raw || "API error";
}

// -- StateBuilder --

export class StateBuilder {
  private state: BBState;

  // Streaming accumulation
  private currentText = "";
  private textBlocks = new Map<number, string>();          // block index → accumulated text for that block
  private thinkingBlocks = new Map<number, string>();      // block index → accumulated thinking text
  private currentToolCalls: BBToolCall[] = [];
  private pendingToolJson = new Map<number, string>();    // block index → accumulated JSON
  private toolIdToIndex = new Map<string, number>();       // tool_use_id → index in currentToolCalls
  private blockTypes = new Map<number, string>();          // block index → "text" | "tool_use" | "thinking"
  private toolBlockToCallIndex = new Map<number, number>(); // block index → index in currentToolCalls

  // The tool calls from the last committed assistant message — used by handleUser
  // to attach tool results. Separate from currentToolCalls so replay of a second
  // assistant message doesn't inherit the first message's tool calls.
  private lastCommittedToolCalls: BBToolCall[] = [];

  // AskUserQuestion suppression — block indices and tool_use_ids to hide from UI
  private askUserBlockIndices = new Set<number>();
  private askUserToolIds = new Set<string>();
  private askUserBlockToolId = new Map<number, string>(); // block index → tool_use_id

  // True during replayFromJSONL — controls whether handleAssistant resets
  // currentText/currentToolCalls. During live streaming, onMessageStart handles
  // the reset; during replay, message_start never fires so handleAssistant must.
  private replaying = false;

  // True after handleAssistant pushes a new message. content_block_stop only
  // patches state.messages when this is true, preventing blocks from a new
  // inner API call from overwriting the previous message. Reset by
  // onMessageStart and the inner-API-call mini-reset in onContentBlockStart.
  private currentMessagePushed = false;

  // True after handleAssistant pushes ANY message since the last onMessageStart.
  // Unlike currentMessagePushed, NOT cleared by the mini-reset — used to detect
  // inner API calls where stale streaming state would otherwise leak.
  private turnHasAssistant = false;

  // Dedup & context
  private seenMessageIds = new Set<string>();
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private lastInputTokens = 0;
  private lastOutputTokens = 0;

  // Turn-level tool call accumulator — incremented per content_block_stop(tool_use),
  // reset on system:init (which fires once per turn). Fixes the bug where
  // getTurnMetrics only saw the LAST assistant message (usually text-only, 0 tools).
  private turnToolCallCount = 0;

  // Turn-level output token tracking — keyed by message ID so partial emissions
  // (same ID, increasing counts) overwrite rather than accumulate, while different
  // messages in the same turn sum correctly.
  private turnOutputTokensById = new Map<string, number>();

  constructor(sessionId: string, project: string) {
    this.state = {
      session: { id: sessionId, model: "", project, context_pct: 0 },
      messages: [],
      connection: "connected",
      status: "idle",
      slashCommands: null,
    };
  }

  getState(): BBState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Turn-level metrics for logging. */
  getTurnMetrics(): { inputTokens: number; outputTokens: number; toolCalls: number } {
    // Sum output tokens across all messages in the turn (partial emissions for the
    // same message ID overwrite in the map, so no double-counting).
    let outputTokens = 0;
    for (const v of this.turnOutputTokensById.values()) outputTokens += v;
    return {
      inputTokens: this.lastInputTokens,
      outputTokens: outputTokens || this.lastOutputTokens, // fallback for pre-init events
      toolCalls: this.turnToolCallCount,
    };
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
    this.replaying = true;
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
    this.replaying = false;
  }

  // -- Event handlers --

  private handleSystem(event: Record<string, unknown>): SSEDelta {
    if (event.subtype !== "init") return null;

    // Reset per-turn counters — init fires once per turn
    this.turnToolCallCount = 0;
    this.turnOutputTokensById.clear();

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
    this.textBlocks.clear();
    this.thinkingBlocks.clear();
    this.currentToolCalls = [];
    this.pendingToolJson.clear();
    this.blockTypes.clear();
    this.toolBlockToCallIndex.clear();
    this.askUserBlockIndices.clear();
    this.askUserBlockToolId.clear();
    this.currentMessagePushed = false;
    this.turnHasAssistant = false;
    return { type: "message_start" };
  }

  private onContentBlockStart(inner: Record<string, unknown>): SSEDelta {
    const index = inner.index as number;
    const block = inner.content_block as Record<string, unknown> | undefined;
    if (!block) return null;

    const blockType = block.type as string;

    // Detect new inner API call within the same CC turn. During multi-tool turns,
    // CC makes multiple API calls (think → tool → result → think again) but only
    // emits message_start for the FIRST call. Subsequent calls reuse block indices
    // starting from 0. If blockTypes already has this index, we're in a new API
    // call — clear streaming accumulation to prevent text/thinking/tool leakage.
    if (this.blockTypes.has(index)) {
      this.currentText = "";
      this.textBlocks.clear();
      this.thinkingBlocks.clear();
      this.currentToolCalls = [];
      this.pendingToolJson.clear();
      this.blockTypes.clear();
      this.toolBlockToCallIndex.clear();
      this.askUserBlockIndices.clear();
      this.askUserBlockToolId.clear();
      this.currentMessagePushed = false;
    }

    this.blockTypes.set(index, blockType);

    if (blockType === "text") {
      return { type: "activity", activity: "writing" };
    }

    if (blockType === "tool_use") {
      const name = (block.name as string) || "Unknown";
      const toolId = block.id as string;

      // AskUserQuestion: suppress from tool calls, track for ask_user delta
      if (name === "AskUserQuestion" && !this.replaying) {
        this.askUserBlockIndices.add(index);
        if (toolId) {
          this.askUserToolIds.add(toolId);
          this.askUserBlockToolId.set(index, toolId);
        }
        return null; // no tool activity — overlay handles it
      }

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
      const text = (delta.text as string) || "";
      // Accumulate per-block to avoid repeating text across blocks
      const existing = this.textBlocks.get(index) || "";
      this.textBlocks.set(index, existing + text);
      return null; // text aggregated, emitted at content_block_stop
    }

    if (delta.type === "input_json_delta") {
      const existing = this.pendingToolJson.get(index) || "";
      this.pendingToolJson.set(index, existing + ((delta.partial_json as string) || ""));
      return null; // accumulated, emitted at content_block_stop
    }

    if (delta.type === "thinking") {
      const text = (delta.thinking as string) || "";
      const existing = this.thinkingBlocks.get(index) || "";
      this.thinkingBlocks.set(index, existing + text);
      return null; // accumulated, emitted at content_block_stop
    }

    return null;
  }

  private onContentBlockStop(inner: Record<string, unknown>): SSEDelta {
    const index = inner.index as number;
    const blockType = this.blockTypes.get(index);

    if (blockType === "text") {
      // Rebuild currentText from all text blocks (avoids repeating earlier blocks)
      const blockText = this.textBlocks.get(index) || "";
      const allTexts: string[] = [];
      // Sort by block index to maintain order
      const sortedIndices = [...this.textBlocks.keys()].sort((a, b) => a - b);
      for (const idx of sortedIndices) {
        const t = this.textBlocks.get(idx);
        if (t) allTexts.push(t);
      }
      this.currentText = allTexts.join("\n\n");

      // Patch the committed assistant message — but only if handleAssistant
      // already pushed it. Without this guard, blocks from a new inner API call
      // (after mini-reset) would overwrite the PREVIOUS message's content.
      if (this.currentMessagePushed) {
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant") {
          lastMsg.content = this.currentText || lastMsg.content;
        }
      }
      return { type: "content", index, text: this.currentText };
    }

    if (blockType === "tool_use" && this.askUserBlockIndices.has(index)) {
      // AskUserQuestion: parse full input and emit ask_user delta
      const rawJson = this.pendingToolJson.get(index);
      if (!rawJson) return null;
      try {
        const args = JSON.parse(rawJson);
        const questions = (args.questions || []) as AskUserQuestion[];
        const toolId = this.askUserBlockToolId.get(index) || "";
        return { type: "ask_user" as const, questions, toolCallId: toolId };
      } catch {
        return null;
      }
    }

    if (blockType === "tool_use") {
      this.turnToolCallCount++;

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

      // Patch the committed assistant message's tool_calls — but only if
      // handleAssistant already pushed it (same guard as text patching).
      if (this.currentMessagePushed) {
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant") {
          lastMsg.tool_calls = [...this.currentToolCalls];
          this.lastCommittedToolCalls = lastMsg.tool_calls;
        }
      }

      return { type: "tool_start", index: callIndex, name: call.name, input: call.input };
    }

    if (blockType === "thinking") {
      const thinkingText = this.thinkingBlocks.get(index) || "";
      if (!thinkingText) return null;

      // Build combined thinking from all blocks
      const allThinking: string[] = [];
      const sortedIndices = [...this.thinkingBlocks.keys()].sort((a, b) => a - b);
      for (const idx of sortedIndices) {
        const t = this.thinkingBlocks.get(idx);
        if (t) allThinking.push(t);
      }
      const combined = allThinking.join("\n\n");

      // Patch committed assistant message (same guard as text/tool patching)
      if (this.currentMessagePushed) {
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant") {
          lastMsg.thinking = combined;
        }
      }

      return { type: "thinking_content", text: combined };
    }

    return null;
  }

  private handleAssistant(event: Record<string, unknown>): SSEDelta {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    // API error messages — CC emits isApiErrorMessage: true when the Anthropic
    // API returns an error (e.g. 400 "Could not process image"). No result event
    // follows, no streaming events fire. The error text is in the content blocks.
    // Without handling here, the user sees nothing — the turn silently fails.
    if (event.isApiErrorMessage) {
      const errorText = extractApiErrorText(message);
      this.state.status = "idle";
      this.state.messages.push({ role: "assistant", content: errorText });
      return { type: "api_error", error: errorText };
    }

    // Always extract usage — CC emits the same message ID multiple times with
    // --include-partial-messages, and later emissions have more complete token
    // counts (first emission often has output_tokens: 1).
    const usage = message.usage as Record<string, number> | undefined;
    const msgId = message.id as string;
    if (usage) {
      this.lastInputTokens =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
      this.lastOutputTokens = usage.output_tokens || 0;
      this.state.session.context_pct = Math.round(
        (this.lastInputTokens / this.contextWindow) * 100,
      );
      // Track per-message output tokens — partials overwrite (same ID),
      // different messages in the same turn accumulate (different IDs).
      if (msgId) {
        this.turnOutputTokensById.set(msgId, this.lastOutputTokens);
      }
    }

    // Deduplicate by message ID — but AFTER usage extraction above
    if (msgId) {
      if (this.seenMessageIds.has(msgId)) return null;
      this.seenMessageIds.add(msgId);
    }

    // Inner API call guard: if we've already pushed an assistant message in this
    // turn (since the last onMessageStart), the current streaming state is stale
    // — it belongs to the PREVIOUS message. Clear it so the new message builds
    // from its own content blocks, not the old accumulation. Uses turnHasAssistant
    // (not currentMessagePushed) because the mini-reset clears currentMessagePushed.
    if (this.turnHasAssistant && !this.replaying) {
      this.currentText = "";
      this.textBlocks.clear();
      this.thinkingBlocks.clear();
      this.currentToolCalls = [];
      this.pendingToolJson.clear();
    }

    // Build assistant message — prefer streaming accumulation, fall back to
    // content array from complete message (JSONL replay has no streaming events)
    let text = this.currentText || null;
    let toolCalls = this.currentToolCalls.length > 0 ? this.currentToolCalls : undefined;

    // Thinking text from streaming accumulation
    let thinking: string | undefined;
    if (this.thinkingBlocks.size > 0) {
      const sortedIndices = [...this.thinkingBlocks.keys()].sort((a, b) => a - b);
      const parts: string[] = [];
      for (const idx of sortedIndices) {
        const t = this.thinkingBlocks.get(idx);
        if (t) parts.push(t);
      }
      if (parts.length > 0) thinking = parts.join("\n\n");
    }

    if (!text && !toolCalls) {
      const contentBlocks = message.content as unknown[] | undefined;
      if (Array.isArray(contentBlocks)) {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const calls: BBToolCall[] = [];
        for (const block of contentBlocks) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && b.text) {
            textParts.push(b.text as string);
          } else if (b.type === "thinking" && b.thinking) {
            thinkingParts.push(b.thinking as string);
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
        if (thinkingParts.length > 0 && !thinking) thinking = thinkingParts.join("\n\n");
        if (calls.length > 0) {
          toolCalls = calls;
          this.currentToolCalls = calls; // so tool_result can find them
          this.turnToolCallCount += calls.length; // replay path — no content_block_stop
        }
      }
    }

    const msg: BBMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls && { tool_calls: toolCalls }),
      ...(thinking && { thinking }),
    };
    this.state.messages.push(msg);
    this.currentMessagePushed = true;
    this.turnHasAssistant = true;

    // Save this message's tool calls so handleUser can attach results to them.
    // toolIdToIndex is intentionally NOT cleared here — handleUser needs it next,
    // and tool_use_ids are unique per session so stale entries don't collide.
    this.lastCommittedToolCalls = msg.tool_calls || [];

    // Only reset during replay (where message_start never fires between
    // consecutive assistant messages). During live streaming, onMessageStart
    // handles the reset — and resetting here would clobber currentText before
    // content_block_stop can emit it (CC sends assistant BEFORE content_block_stop
    // on 2nd+ turns due to user replay event shifting ordering).
    if (this.replaying) {
      this.currentText = "";
      this.textBlocks.clear();
      this.thinkingBlocks.clear();
      this.currentToolCalls = [];
    }

    return null; // full state sent on result
  }

  private handleUser(event: Record<string, unknown>): SSEDelta {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const content = message.content;

    // String content = user text
    if (typeof content === "string") {
      // Detect bridge-injected synthetic messages by prefix convention.
      // Detect bridge-injected synthetic messages by [guéridon:*] prefix.
      // Exception: staged uploads contain deposit note(s) followed by user
      // text — these are real user messages rendered by the client.
      const syntheticMatch = content.match(/^\[guéridon:\w+\]\s*/);
      if (syntheticMatch) {
        const DEPOSIT_SUFFIX = "manifest.json has full metadata. Read the files if relevant to our conversation.";
        const suffixIdx = content.indexOf(DEPOSIT_SUFFIX);
        const hasUserText = suffixIdx !== -1 &&
          content.slice(suffixIdx + DEPOSIT_SUFFIX.length).trim().length > 0;
        if (hasUserText) {
          // Staged upload with user text — keep full content
          this.state.messages.push({ role: "user", content });
        } else {
          // Pure bridge-injected message — strip prefix, mark synthetic
          const stripped = content.slice(syntheticMatch[0].length);
          this.state.messages.push({ role: "user", content: stripped, synthetic: true });
        }
      } else {
        this.state.messages.push({ role: "user", content });
      }
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

        // Suppress AskUserQuestion error results — the overlay handles the UX
        if (this.askUserToolIds.has(toolUseId)) {
          this.askUserToolIds.delete(toolUseId);
          continue;
        }
        const idx = this.toolIdToIndex.get(toolUseId);
        if (idx === undefined) continue;

        const call = this.lastCommittedToolCalls[idx];
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
