/**
 * bridge-client.ts — Protocol/state layer for Guéridon CLI
 *
 * Handles WebSocket connection to the bridge, CC event parsing,
 * tool JSON accumulation, AskUserQuestion detection, usage tracking,
 * reconnection, and replay mode. Emits semantic callbacks that any
 * rendering layer (raw ANSI, pi-tui, or future) can consume.
 */

import WebSocket from "ws";

// --- Types ---

export interface FolderInfo {
  name: string;
  path: string;
  state: "active" | "paused" | "closed" | "fresh";
  handoffPurpose?: string;
}

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface UsageInfo {
  inputTokens: number;
  contextWindow: number;
  percent: number;
}

export interface BridgeCallbacks {
  // Connection lifecycle
  onFolderList?(folders: FolderInfo[]): void;
  onConnected?(sessionId: string, resumed: boolean): void;
  onError?(error: string): void;
  onProcessExit?(code: number): void;
  onDisconnect?(): void;
  onReconnecting?(attempt: number, delaySec: number): void;
  onWsError?(message: string): void;

  // Live streaming
  onStreamStart?(): void;
  onStreamEnd?(): void;
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(name: string): void;
  onToolInput?(name: string, args: Record<string, any>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  onAskUser?(question: string, options: AskUserOption[]): void;

  // Replay
  onReplayStart?(): void;
  onReplayEnd?(): void;
  onReplayUser?(text: string): void;
  onReplayAssistant?(text: string, toolCount: number): void;

  // Status
  onUsageUpdate?(usage: UsageInfo): void;
}

export interface BridgeClientOptions {
  url: string;
  maxReconnectAttempts?: number;
  contextWindow?: number;
  callbacks: BridgeCallbacks;
}

// --- BridgeClient ---

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly maxReconnect: number;
  private readonly cb: BridgeCallbacks;

  // Connection state
  private _connectedFolder: string | null = null;
  private _sessionId: string | null = null;
  private reconnectAttempts = 0;

  // Streaming state
  private _isStreaming = false;
  private replayingHistory = false;

  // Usage
  private lastInputTokens = 0;
  private contextWindow: number;

  // Tool call tracking
  private toolJsonAccum = new Map<number, string>();
  private toolBlockNames = new Map<number, string>();
  private toolCallNames = new Map<string, string>();
  private askUserIndices = new Set<number>();

  constructor(options: BridgeClientOptions) {
    this.url = options.url;
    this.maxReconnect = options.maxReconnectAttempts ?? 5;
    this.contextWindow = options.contextWindow ?? 200_000;
    this.cb = options.callbacks;
  }

  // --- Public API ---

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get connectedFolder(): string | null {
    return this._connectedFolder;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get usage(): UsageInfo {
    const pct = this.contextWindow > 0
      ? Math.round((this.lastInputTokens / this.contextWindow) * 100)
      : 0;
    return {
      inputTokens: this.lastInputTokens,
      contextWindow: this.contextWindow,
      percent: pct,
    };
  }

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.source === "bridge") {
        this.handleBridgeMessage(msg);
      } else if (msg.source === "cc") {
        this.handleCCEvent(msg.event);
      }
    });

    this.ws.on("close", () => {
      this.resetStreamState();

      if (!this._connectedFolder) {
        this.cb.onDisconnect?.();
        return;
      }

      if (this.reconnectAttempts >= this.maxReconnect) {
        this.cb.onDisconnect?.();
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.reconnectAttempts++;
      this.cb.onReconnecting?.(this.reconnectAttempts, delay / 1000);
      setTimeout(() => this.connect(), delay);
    });

    this.ws.on("error", (err: Error) => {
      this.cb.onWsError?.(err.message);
    });
  }

  sendPrompt(text: string): void {
    this.wsSend({ type: "prompt", text });
  }

  sendAbort(): void {
    this.wsSend({ type: "abort" });
  }

  selectFolder(path: string): void {
    this._connectedFolder = path;
    this.wsSend({ type: "connectFolder", path });
  }

  requestFolderList(): void {
    this.wsSend({ type: "listFolders" });
  }

  dispose(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }

  // --- Private: message routing ---

  private handleBridgeMessage(msg: any): void {
    switch (msg.type) {
      case "lobbyConnected":
        if (this._connectedFolder) {
          this.wsSend({ type: "connectFolder", path: this._connectedFolder });
        } else {
          this.wsSend({ type: "listFolders" });
        }
        break;

      case "folderList":
        this.cb.onFolderList?.(msg.folders);
        break;

      case "connected":
        this._sessionId = msg.sessionId;
        this.cb.onConnected?.(msg.sessionId, !!msg.resumed);
        break;

      case "promptReceived":
        break;

      case "error":
        this.cb.onError?.(msg.error);
        break;

      case "processExit":
        this._isStreaming = false;
        this.cb.onProcessExit?.(msg.code);
        break;

      case "historyStart":
        this.replayingHistory = true;
        this.cb.onReplayStart?.();
        break;

      case "historyEnd":
        this.replayingHistory = false;
        this.cb.onReplayEnd?.();
        break;
    }
  }

  private handleCCEvent(event: any): void {
    switch (event.type) {
      case "system":
        break;

      case "assistant": {
        this.updateUsage(event.message?.usage);
        if (this.replayingHistory && event.message?.content) {
          this.emitReplayAssistant(event.message.content);
        }
        break;
      }

      case "stream_event": {
        if (!this.replayingHistory) {
          this.handleStreamEvent(event.event);
        }
        break;
      }

      case "result": {
        this._isStreaming = false;
        this.updateUsage((event.result || event).usage);
        this.cb.onStreamEnd?.();
        break;
      }

      case "user": {
        const content = event.message?.content;
        if (!content) break;

        if (this.replayingHistory) {
          this.emitReplayUser(content);
          break;
        }

        // Tool results
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              this.emitToolResult(block);
            }
          }
        }
        break;
      }
    }
  }

  private handleStreamEvent(se: any): void {
    if (!se) return;
    const idx: number = se.index ?? 0;

    switch (se.type) {
      case "message_start":
        this._isStreaming = true;
        this.toolJsonAccum.clear();
        this.toolBlockNames.clear();
        this.askUserIndices.clear();
        this.cb.onStreamStart?.();
        break;

      case "content_block_start": {
        const block = se.content_block;
        if (block?.type === "tool_use") {
          this.toolBlockNames.set(idx, block.name);
          this.toolCallNames.set(block.id, block.name);
          this.toolJsonAccum.set(idx, "");

          if (block.name === "AskUserQuestion") {
            this.askUserIndices.add(idx);
          } else {
            this.cb.onToolStart?.(block.name);
          }
        } else if (block?.type === "thinking") {
          // Thinking block starts — no callback needed, text arrives via deltas
        }
        break;
      }

      case "content_block_delta": {
        const delta = se.delta;
        if (delta?.type === "text_delta" && delta.text) {
          this.cb.onText?.(delta.text);
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const prev = this.toolJsonAccum.get(idx) || "";
          this.toolJsonAccum.set(idx, prev + delta.partial_json);
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          this.cb.onThinking?.(delta.thinking);
        }
        break;
      }

      case "content_block_stop": {
        const json = this.toolJsonAccum.get(idx);
        if (json !== undefined) {
          try {
            const args = JSON.parse(json);

            if (this.askUserIndices.has(idx)) {
              const q = args.questions?.[0];
              if (q) {
                this.cb.onAskUser?.(
                  q.question || "Choose:",
                  q.options || [],
                );
              }
              this.askUserIndices.delete(idx);
            } else {
              const name = this.toolBlockNames.get(idx) || "tool";
              this.cb.onToolInput?.(name, args);
            }
          } catch {
            // Malformed JSON
          }
          this.toolJsonAccum.delete(idx);
        }
        break;
      }

      case "message_delta":
        this.updateUsage(se.usage);
        break;

      case "message_stop":
        break;
    }
  }

  // --- Private: helpers ---

  private wsSend(msg: object): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      // WS might be closed
    }
  }

  private resetStreamState(): void {
    this._isStreaming = false;
    this.toolJsonAccum.clear();
    this.toolBlockNames.clear();
    this.askUserIndices.clear();
  }

  private updateUsage(usage: any): void {
    if (!usage) return;
    const total =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    if (total > 0) {
      this.lastInputTokens = total;
      this.cb.onUsageUpdate?.(this.usage);
    }
  }

  private emitToolResult(block: any): void {
    const toolId = block.tool_use_id;
    const toolName = this.toolCallNames.get(toolId) || "tool";
    const isError = block.is_error || false;

    let text = "";
    if (typeof block.content === "string") {
      text = block.content;
    } else if (Array.isArray(block.content)) {
      text = block.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }

    this.cb.onToolResult?.(toolName, text, isError);
  }

  private emitReplayUser(content: any): void {
    if (typeof content === "string") {
      this.cb.onReplayUser?.(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          this.cb.onReplayUser?.(block.text);
        }
      }
    }
  }

  private emitReplayAssistant(content: any[]): void {
    let textParts: string[] = [];
    let toolCount = 0;

    for (const block of content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCount++;
      }
    }

    const text = textParts.join(" ").trim();
    this.cb.onReplayAssistant?.(text, toolCount);
  }
}
