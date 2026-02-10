/**
 * WebSocket transport — implements CCTransport over WebSocket to the bridge server.
 *
 * Handles the bridge protocol (source discrimination), auto-reconnect with
 * exponential backoff, and promptReceived timeout (liveness proof that the
 * remote end got the message).
 */

import type { CCTransport, CCEvent } from "./claude-code-agent.js";

// --- Connection state ---

export type ConnectionState = "connecting" | "lobby" | "connected" | "disconnected" | "error";

// --- Folder types (mirrors server/folders.ts for typed API) ---

export type FolderState = "active" | "paused" | "closed" | "fresh";

export interface FolderInfo {
  name: string;
  path: string;
  state: FolderState;
  sessionId: string | null;
  lastActive: string | null;
  handoffPurpose: string | null;
}

export interface WSTransportOptions {
  /** Bridge WebSocket URL, e.g. "ws://localhost:3001" */
  url: string;
  /** Timeout (ms) waiting for promptReceived ack before treating as dead. Default 10000. */
  promptTimeout?: number;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  /** Called when session ID is assigned by bridge */
  onSessionId?: (id: string) => void;
  /** Called on bridge-level error */
  onBridgeError?: (error: string) => void;
  /** Called when lobby mode is entered (WS open, no session yet) */
  onLobbyConnected?: () => void;
  /** Called with folder list from bridge */
  onFolderList?: (folders: FolderInfo[]) => void;
  /** Called when CC process exits (code/signal) */
  onProcessExit?: (code: number | null, signal: string | null) => void;
  /** Called when bridge begins replaying history buffer */
  onHistoryStart?: () => void;
  /** Called when bridge finishes replaying history buffer */
  onHistoryEnd?: () => void;
}

// --- Reconnect backoff ---

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export class WSTransport implements CCTransport {
  private ws: WebSocket | null = null;
  private eventHandler: ((event: CCEvent) => void) | null = null;
  private options: Required<
    Pick<WSTransportOptions, "url" | "promptTimeout">
  > & WSTransportOptions;

  private sessionId: string | null = null;
  private folderPath: string | null = null; // Current folder — used to re-send connectFolder on reconnect
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false; // True after explicit close() — stops reconnect
  private _state: ConnectionState = "disconnected";
  private boundVisibilityHandler: (() => void) | null = null;

  constructor(options: WSTransportOptions) {
    this.options = {
      promptTimeout: 10_000,
      ...options,
    };
  }

  // --- CCTransport interface ---

  send(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.options.onBridgeError?.("Not connected to bridge");
      return;
    }
    this.ws.send(JSON.stringify({ type: "prompt", text: message }));
    this.startPromptTimer();
  }

  onEvent(handler: (event: CCEvent) => void): void {
    this.eventHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.unlistenVisibility();
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "Client closing");
      this.ws = null;
    }
    this.setState("disconnected");
  }

  // --- Public API beyond CCTransport ---

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    this.closed = false;
    this.listenVisibility();
    this.doConnect();
  }

  /** Send abort to bridge (kills CC process) */
  abort(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "abort" }));
  }

  /** Request folder list from bridge (lobby mode only) */
  listFolders(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "listFolders" }));
  }

  /** Connect to a folder — transitions from lobby to session mode */
  connectFolder(path: string): void {
    this.folderPath = path;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "connectFolder", path }));
  }

  /** Disconnect from current session and reconnect in lobby mode */
  returnToLobby(): void {
    this.sessionId = null;
    this.folderPath = null;
    this.clearTimers();
    // Close old WS — detach handlers first to prevent onclose race
    // (onclose would set this.ws = null and trigger scheduleReconnect,
    // clobbering the new WS we're about to create)
    const oldWs = this.ws;
    this.ws = null;
    if (oldWs) {
      oldWs.onclose = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.close(1000, "Returning to lobby");
    }
    this.doConnect(); // folderPath cleared above → arrives in lobby mode
  }

  // --- Internal ---

  private doConnect(): void {
    if (this.closed) return;

    this.setState("connecting");
    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // State moves to "connected" when we get bridge:connected, not on WS open
    };

    this.ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn("[ws-transport] non-JSON message from bridge");
        return;
      }
      this.handleMessage(msg);
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      if (!this.closed) {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onerror always fires before onclose — let onclose handle state/reconnect
    };
  }

  private handleMessage(msg: any): void {
    if (msg.source === "bridge") {
      switch (msg.type) {
        case "lobbyConnected":
          if (this.folderPath) {
            // Reconnecting to an existing session — re-send connectFolder
            // immediately so the bridge finds (or recreates) the session
            // with the correct folder path. No lobby UI flash needed.
            this.ws!.send(JSON.stringify({ type: "connectFolder", path: this.folderPath }));
          } else {
            this.setState("lobby");
            this.options.onLobbyConnected?.();
          }
          break;

        case "folderList":
          this.options.onFolderList?.(msg.folders);
          break;

        case "connected":
          this.sessionId = msg.sessionId;
          this.options.onSessionId?.(msg.sessionId);
          this.setState("connected");
          break;

        case "promptReceived":
          this.clearPromptTimer();
          break;

        case "error":
          this.options.onBridgeError?.(msg.error);
          break;

        case "historyStart":
          this.options.onHistoryStart?.();
          break;

        case "historyEnd":
          this.options.onHistoryEnd?.();
          break;

        case "processExit":
          // CC process died. Normal exits (result/success) are handled by
          // the adapter via CC events. But abnormal exits (crash, abort,
          // SIGKILL) never send a result event — the adapter's isStreaming
          // stays true and the UI shows an infinite pulsing cursor.
          // Synthesize a result event so the adapter resets cleanly.
          this.clearPromptTimer();
          this.eventHandler?.({
            type: "result",
            subtype: "error",
            error: `CC process exited (code=${msg.code}, signal=${msg.signal})`,
          });
          this.options.onProcessExit?.(msg.code ?? null, msg.signal ?? null);
          break;
      }
    } else if (msg.source === "cc") {
      // Forward the inner CC event to the adapter
      this.eventHandler?.(msg.event);
    }
  }

  // --- Prompt timeout ---

  private startPromptTimer(): void {
    this.clearPromptTimer();
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null;
      this.options.onBridgeError?.(
        "No response from bridge — message may not have reached Claude"
      );
    }, this.options.promptTimeout);
  }

  private clearPromptTimer(): void {
    if (this.promptTimer) {
      clearTimeout(this.promptTimer);
      this.promptTimer = null;
    }
  }

  // --- Reconnect ---

  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = Math.min(
      BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** this.reconnectAttempts,
      BACKOFF_MAX_MS,
    );
    this.reconnectAttempts++;

    console.log(
      `[ws-transport] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  // --- State ---

  private setState(state: ConnectionState, detail?: string): void {
    if (this._state === state) return;
    this._state = state;
    this.options.onStateChange?.(state, detail);
  }

  // --- Visibility (mobile tab resume) ---

  private listenVisibility(): void {
    if (this.boundVisibilityHandler) return; // already listening
    if (typeof document === "undefined") return; // SSR/test safety
    this.boundVisibilityHandler = () => this.handleVisibilityChange();
    document.addEventListener("visibilitychange", this.boundVisibilityHandler);
  }

  private unlistenVisibility(): void {
    if (!this.boundVisibilityHandler) return;
    if (typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.boundVisibilityHandler);
    this.boundVisibilityHandler = null;
  }

  private handleVisibilityChange(): void {
    if (document.visibilityState !== "visible") return;
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) return; // already healthy

    // Tab came back and WS is dead — reconnect immediately.
    // Cancel any pending backoff timer and reset attempts.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  // --- Cleanup ---

  private clearTimers(): void {
    this.clearPromptTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
