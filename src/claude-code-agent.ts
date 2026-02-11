/**
 * ClaudeCodeAgent — Adapter that satisfies pi-web-ui's Agent interface
 * but gets its events from Claude Code's stream-json output via a transport
 * (WebSocket to bridge server), not from a direct LLM call.
 *
 * CC runs its own agent loop (tool execution, multi-turn). We don't use
 * pi-agent-core's agentLoop at all. We just translate CC's output events
 * into pi's AgentEvent format and manage AgentState accordingly.
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Model, Usage } from "@mariozechner/pi-ai";

// --- Transport interface (WebSocket later) ---

export interface CCTransport {
  send(message: string): void;
  onEvent(handler: (event: CCEvent) => void): void;
  close(): void;
}

// --- Claude Code stream-json event types ---

export interface CCEvent {
  type: string;
  [key: string]: any;
}

// --- AskUserQuestion types ---

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionData {
  questions: AskUserQuestionItem[];
  toolCallId: string;
}

// --- The Adapter ---

export class ClaudeCodeAgent {
  private _state: AgentState;
  private listeners = new Set<(e: AgentEvent) => void>();
  private transport: CCTransport | null = null;

  // Partial message being built from stream deltas
  private partialContent: any[] = [];
  private partialMessageId: string | null = null;
  private currentContentIndex = -1;

  // Replay mode — events are processed to rebuild state, but
  // subscribers and callbacks are suppressed (no UI animation, no AskUser popup)
  private _replayMode = false;

  // Track tool call IDs → names for tool_result mapping
  private toolCallNames = new Map<string, string>();

  // AskUserQuestion tool call IDs — suppress their error tool_results
  private askUserToolCallIds = new Set<string>();

  // Content block indices to suppress from stream message (AskUserQuestion tool calls)
  private suppressedStreamIndices = new Set<number>();

  // Context tracking (for fuel gauge)
  private _lastInputTokens = 0;
  private _contextWindow = 200_000; // default, updated from init event
  private _cwd = "";
  private _lastRemainingBand: "normal" | "amber" | "red" = "normal";

  // One-shot context note — prepended to next user prompt on threshold crossings
  private _contextNote: string | null = null;

  // Required public fields — AgentInterface checks these
  public streamFn: any = () => {};
  public getApiKey: any = () => "bridge";

  /** Fired when CC calls AskUserQuestion — render tappable UI, send answer as next prompt */
  public onAskUser?: (data: AskUserQuestionData) => void;

  /** Fired when context compaction detected (input tokens dropped significantly between turns) */
  public onCompaction?: (fromTokens: number, toTokens: number) => void;

  /** Fired when CWD is known (from init event) */
  public onCwdChange?: (cwd: string) => void;

  constructor() {
    this._state = {
      systemPrompt: "",
      model: { api: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" } as Model<any>,
      thinkingLevel: "off" as ThinkingLevel,
      tools: [],
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set<string>(),
      error: undefined,
    };
  }

  // --- Public API (matches Agent interface) ---

  /** Reset all session state — call on folder switch before starting new session */
  reset(): void {
    this._state = {
      systemPrompt: "",
      model: { api: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" } as Model<any>,
      thinkingLevel: "off" as ThinkingLevel,
      tools: [],
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set<string>(),
      error: undefined,
    };
    this.partialContent = [];
    this.partialMessageId = null;
    this.currentContentIndex = -1;
    this.toolCallNames.clear();
    this.askUserToolCallIds.clear();
    this.suppressedStreamIndices.clear();
    this._lastInputTokens = 0;
    this._contextWindow = 200_000;
    this._cwd = "";
    this._lastRemainingBand = "normal";
    this._contextNote = null;
    // Notify subscribers so UI clears stale messages.
    // Semantically this is a reset, not a turn ending, but AgentEvent (from
    // pi-agent-core) has no reset event. agent_end with empty messages is the
    // closest match — subscribers clear streaming state and sync from agent.
    this.emit({ type: "agent_end", messages: [] });
  }

  /** Begin replaying history — suppresses emit() and callbacks until endReplay() */
  startReplay(): void {
    this._replayMode = true;
    this.reset();
  }

  /** End replay — re-enables notifications and triggers a sync so UI renders all at once */
  endReplay(): void {
    this._replayMode = false;
    // If CC was mid-turn when we reconnected, the adapter has a partial
    // streamMessage but isStreaming may be false (it's set by prompt(), not
    // stream events). Mark streaming and emit the partial so the UI picks up.
    if (this._state.streamMessage) {
      this._state.isStreaming = true;
      this.emit({ type: "message_update", message: this._state.streamMessage } as any);
    }
    this.emit({ type: "agent_start" }); // triggers syncState in GueridonInterface
  }

  get state(): AgentState {
    return this._state;
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async prompt(input: string | AgentMessage): Promise<void> {
    if (!this.transport) {
      this._state.error = "Not connected";
      this.emit({ type: "agent_end", messages: this._state.messages });
      return;
    }

    if (this._state.isStreaming) {
      // CC queues mid-stream messages, so we can too
      // For now, just warn — bridge will handle queuing
      console.warn("Already streaming, message will be queued by bridge");
    }

    let text = typeof input === "string" ? input : this.extractText(input);
    if (!text) return;

    // Inject one-shot context note on threshold crossings
    if (this._contextNote) {
      text = `${this._contextNote}\n\n${text}`;
      this._contextNote = null;
    }

    // Add user message to local state
    const userMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    this._state.messages = [...this._state.messages, userMessage];

    // Mark streaming
    this._state.isStreaming = true;
    this._state.error = undefined;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });

    this.transport.send(text);
  }

  abort(): void {
    // Soft abort: stop updating UI. Bridge can optionally kill the CC process.
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this.emit({ type: "agent_end", messages: this._state.messages });
  }

  setModel(_m: Model<any>): void {
    // No-op — CC manages model selection
  }

  setThinkingLevel(_l: ThinkingLevel): void {
    // No-op — CC manages thinking
  }

  setTools(t: AgentTool<any>[]): void {
    this._state.tools = t;
  }

  // --- Transport ---

  connectTransport(transport: CCTransport): void {
    this.transport = transport;
    transport.onEvent((event) => this.handleCCEvent(event));
  }

  // --- Context tracking ---

  get contextPercent(): number {
    if (this._contextWindow <= 0) return 0;
    return (this._lastInputTokens / this._contextWindow) * 100;
  }

  get contextWindow(): number {
    return this._contextWindow;
  }

  get lastInputTokens(): number {
    return this._lastInputTokens;
  }

  get cwd(): string {
    return this._cwd;
  }

  // --- CC Event Handler (the core translation) ---

  handleCCEvent(event: CCEvent): void {
    switch (event.type) {
      case "system":
        this.handleInit(event);
        break;

      case "stream_event":
        this.handleStreamEvent(event);
        break;

      case "assistant":
        this.handleAssistantComplete(event);
        break;

      case "user":
        this.handleUserEvent(event);
        break;

      case "result":
        this.handleResult(event);
        break;

      default:
        console.debug(`[adapter] unknown CC event type: ${event.type}`, event);
    }
  }

  // --- Event handlers ---

  private handleInit(event: CCEvent): void {
    // Init fires on every user message — extract CWD on first
    if (event.cwd && !this._cwd) {
      this._cwd = event.cwd;
      if (!this._replayMode) this.onCwdChange?.(event.cwd);
    }
  }

  private handleStreamEvent(event: CCEvent): void {
    const streamEvent = event.event;
    if (!streamEvent) return;

    switch (streamEvent.type) {
      case "message_start":
        this.startStreamMessage(streamEvent.message);
        break;

      case "content_block_start":
        this.startContentBlock(streamEvent.index, streamEvent.content_block);
        break;

      case "content_block_delta":
        this.applyDelta(streamEvent.index, streamEvent.delta);
        break;

      case "content_block_stop":
        this.finalizeContentBlock(streamEvent.index);
        break;

      case "message_delta":
        // stop_reason updates — message-level delta
        break;

      case "message_stop":
        // The full assistant message follows as a separate event
        break;

      default:
        console.debug(`[adapter] unknown stream event type: ${streamEvent.type}`, streamEvent);
    }
  }

  private handleAssistantComplete(event: CCEvent): void {
    const msg = event.message;
    if (!msg) return;

    // Detect AskUserQuestion tool calls — during live operation, fire callback,
    // track IDs, and filter them from content (overlay handles display).
    // During replay, let them through as regular tool calls so history shows Q&A.
    const askUserIds = new Set<string>();
    if (!this._replayMode) {
      for (const block of msg.content || []) {
        if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          askUserIds.add(block.id);
          this.askUserToolCallIds.add(block.id);
          this.onAskUser?.({
            questions: block.input?.questions || [],
            toolCallId: block.id,
          });
        }
      }
    }

    const filteredContent = (msg.content || []).filter(
      (block: any) => !(block.type === "tool_use" && askUserIds.has(block.id)),
    );

    // Build final pi AssistantMessage from CC's complete message
    const piMessage: AgentMessage = {
      role: "assistant",
      content: this.mapContentBlocks(filteredContent),
      api: "anthropic",
      provider: "anthropic",
      model: msg.model || "claude-opus-4-6",
      usage: this.mapUsage(msg.usage),
      stopReason: this.mapStopReason(msg.stop_reason),
      timestamp: Date.now(),
    } as AgentMessage;

    // Track context usage
    if (msg.usage) {
      this._lastInputTokens =
        (msg.usage.input_tokens || 0) +
        (msg.usage.output_tokens || 0) +
        (msg.usage.cache_read_input_tokens || 0) +
        (msg.usage.cache_creation_input_tokens || 0);
    }

    // Clear stream state, append final message
    this._state.streamMessage = null;
    this._state.messages = [...this._state.messages, piMessage];
    this.emit({ type: "message_end", message: piMessage });

    // Track tool call IDs for tool_result mapping
    for (const block of piMessage.content) {
      if ((block as any).type === "toolCall") {
        const tc = block as any;
        this.toolCallNames.set(tc.id, tc.name);
        // Emit tool execution start
        const pending = new Set(this._state.pendingToolCalls);
        pending.add(tc.id);
        this._state.pendingToolCalls = pending;
        this.emit({
          type: "tool_execution_start",
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments,
        });
      }
    }
  }

  private handleUserEvent(event: CCEvent): void {
    const msg = event.message;
    if (!msg?.content) return;

    // During replay, CC echoes user text messages via --replay-user-messages.
    // Add them to state so the conversation shows both sides.
    // During normal operation, prompt() already added the user message — skip
    // the echo to avoid duplicates.
    // CC echoes content as a plain string, not an array of blocks.
    if (this._replayMode && typeof msg.content === "string") {
      const userMessage: AgentMessage = {
        role: "user",
        content: [{ type: "text" as const, text: msg.content }],
        timestamp: Date.now(),
      };
      this._state.messages = [...this._state.messages, userMessage];
    }

    // Tool results come as user messages with tool_result content
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const toolCallId = block.tool_use_id;

        // Suppress AskUserQuestion error results — the overlay handles this
        if (this.askUserToolCallIds.has(toolCallId)) {
          this.askUserToolCallIds.delete(toolCallId);
          // Still remove from pending tool calls
          const pending = new Set(this._state.pendingToolCalls);
          pending.delete(toolCallId);
          this._state.pendingToolCalls = pending;
          continue;
        }

        const toolName = this.toolCallNames.get(toolCallId) || "unknown";
        const isError = block.is_error || false;

        // Build pi ToolResultMessage
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              : "";

        const toolResultMessage: AgentMessage = {
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: resultText }],
          isError,
          timestamp: Date.now(),
        } as AgentMessage;

        this._state.messages = [...this._state.messages, toolResultMessage];

        // Remove from pending
        const pending = new Set(this._state.pendingToolCalls);
        pending.delete(toolCallId);
        this._state.pendingToolCalls = pending;

        this.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          result: resultText,
          isError,
        });
      }
    }
  }

  private handleResult(event: CCEvent): void {
    const result = event.result || event;

    // Update context tracking from result usage
    if (result.usage) {
      const prevTokens = this._lastInputTokens;
      this._lastInputTokens =
        (result.usage.input_tokens || 0) +
        (result.usage.output_tokens || 0) +
        (result.usage.cache_read_input_tokens || 0) +
        (result.usage.cache_creation_input_tokens || 0);

      // Detect compaction: significant drop (>15%) in token count between turns.
      // Minimum 20k drop avoids false positives on small sessions where token
      // accounting jitter (e.g. after /context) easily crosses the 15% threshold.
      const tokenDrop = prevTokens - this._lastInputTokens;
      if (prevTokens > 0 && tokenDrop > 20_000 && this._lastInputTokens < prevTokens * 0.85) {
        if (!this._replayMode) this.onCompaction?.(prevTokens, this._lastInputTokens);
      }

      // Track threshold crossings — inject context note for CC on band change
      const remaining = 100 - this.contextPercent;
      const newBand: "normal" | "amber" | "red" =
        remaining <= 10 ? "red" : remaining <= 20 ? "amber" : "normal";
      if (newBand !== this._lastRemainingBand) {
        this._lastRemainingBand = newBand;
        if (newBand === "amber") {
          this._contextNote =
            "[Context: ~20% remaining. Be concise. Consider suggesting a session close soon.]";
        } else if (newBand === "red") {
          this._contextNote =
            "[Context: ~10% remaining. Be very concise. Suggest wrapping up and writing a handoff.]";
        }
      }
    }

    // End streaming
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this._state.pendingToolCalls = new Set<string>();

    if (result.type === "result" && result.subtype === "error_max_turns") {
      this._state.error = "Max turns reached";
    }

    this.emit({
      type: "turn_end",
      message: this._state.messages[this._state.messages.length - 1],
      toolResults: [],
    });
    this.emit({ type: "agent_end", messages: this._state.messages });
  }

  // --- Stream message building ---

  private startStreamMessage(msg: any): void {
    this.partialContent = [];
    this.partialMessageId = msg?.id || null;
    this.currentContentIndex = -1;
    this.suppressedStreamIndices = new Set();

    const streamMessage: AgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic",
      provider: "anthropic",
      model: msg?.model || "claude-opus-4-6",
      usage: this.emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage;

    this._state.streamMessage = streamMessage;
    this.emit({ type: "message_start", message: streamMessage });
  }

  private startContentBlock(index: number, block: any): void {
    this.currentContentIndex = index;

    // Suppress AskUserQuestion tool calls from stream — overlay handles display
    if (block.type === "tool_use" && block.name === "AskUserQuestion") {
      this.suppressedStreamIndices.add(index);
      return;
    }

    if (block.type === "text") {
      this.partialContent[index] = { type: "text", text: "" };
    } else if (block.type === "tool_use") {
      this.partialContent[index] = {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: {},
      };
      this.emitToolCallStart(block);
    } else if (block.type === "thinking") {
      this.partialContent[index] = { type: "thinking", thinking: "" };
    }

    this.updateStreamMessage();
  }

  private applyDelta(index: number, delta: any): void {
    if (this.suppressedStreamIndices.has(index)) return;
    const block = this.partialContent[index];
    if (!block) return;

    if (delta.type === "text_delta" && block.type === "text") {
      block.text += delta.text;
      this.updateStreamMessage({
        type: "text_delta",
        contentIndex: index,
        delta: delta.text,
        partial: block.text,
      });
    } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
      // Accumulate JSON fragments — parse will happen at block_stop
      if (!block._jsonAccum) block._jsonAccum = "";
      block._jsonAccum += delta.partial_json;
      this.updateStreamMessage({
        type: "toolcall_delta",
        contentIndex: index,
      });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking;
      this.updateStreamMessage({
        type: "text_delta",
        contentIndex: index,
        delta: delta.thinking,
        partial: block.thinking,
      });
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = delta.signature;
    }
  }

  private finalizeContentBlock(index: number): void {
    if (this.suppressedStreamIndices.has(index)) return;
    const block = this.partialContent[index];
    if (!block) return;

    if (block.type === "toolCall" && block._jsonAccum) {
      try {
        block.arguments = JSON.parse(block._jsonAccum);
      } catch {
        block.arguments = {};
      }
      delete block._jsonAccum;
      this.emitToolCallEnd(block);
    }

    this.updateStreamMessage();
  }

  private updateStreamMessage(assistantMessageEvent?: any): void {
    if (!this._state.streamMessage) return;

    const streamMessage: AgentMessage = {
      ...this._state.streamMessage,
      content: this.partialContent.filter(Boolean),
    };

    this._state.streamMessage = streamMessage;

    const event: any = {
      type: "message_update",
      message: streamMessage,
    };
    if (assistantMessageEvent) {
      event.assistantMessageEvent = assistantMessageEvent;
    }
    this.emit(event);
  }

  private emitToolCallStart(block: any): void {
    this.updateStreamMessage({
      type: "toolcall_start",
      contentIndex: this.currentContentIndex,
      toolCallId: block.id,
      toolName: block.name,
    });
  }

  private emitToolCallEnd(block: any): void {
    this.updateStreamMessage({
      type: "toolcall_end",
      contentIndex: this.currentContentIndex,
      toolCallId: block.id,
      toolName: block.name,
      args: block.arguments,
    });
  }

  // --- Helpers ---

  private emit(e: AgentEvent): void {
    if (this._replayMode) return;
    for (const listener of this.listeners) {
      listener(e);
    }
  }

  private extractText(msg: AgentMessage): string {
    if (typeof msg.content === "string") return msg.content;
    const textBlocks = msg.content.filter((c: any) => c.type === "text");
    return textBlocks.map((c: any) => c.text || "").join("\n");
  }

  private mapContentBlocks(blocks: any[]): any[] {
    return blocks.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input || {},
        };
      }
      if (block.type === "thinking") {
        return {
          type: "thinking",
          thinking: block.thinking,
          thinkingSignature: block.signature,
        };
      }
      return block;
    });
  }

  private mapUsage(usage: any): Usage {
    if (!usage) return this.emptyUsage();
    return {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      totalTokens:
        (usage.input_tokens || 0) +
        (usage.output_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  private mapStopReason(
    reason: string | null,
  ): "stop" | "toolUse" | "error" | "aborted" {
    if (reason === "tool_use") return "toolUse";
    if (reason === "end_turn") return "stop";
    if (reason === "max_tokens") return "stop";
    return "stop";
  }

  private emptyUsage(): Usage {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
}
