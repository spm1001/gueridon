/**
 * WebSocket transport — implements CCTransport over WebSocket to the bridge server.
 *
 * Handles the bridge protocol (source discrimination), auto-reconnect with
 * exponential backoff, and promptReceived timeout (liveness proof that the
 * remote end got the message).
 */

import type { CCTransport, CCEvent, ContentBlock } from "./claude-code-agent.js";

// --- Connection state ---

export type ConnectionState = "connecting" | "lobby" | "connected" | "disconnected" | "error";

// --- Folder types (mirrors server/folders.ts for typed API) ---

export type FolderState = "active" | "paused" | "closed" | "fresh";
export type FolderActivity = "working" | "waiting" | null;

export interface FolderInfo {
  name: string;
  path: string;
  state: FolderState;
  activity: FolderActivity;
  sessionId: string | null;
  lastActive: string | null;
  handoffPurpose: string | null;
}

export interface WSTransportOptions {
  /** Bridge WebSocket URL, e.g. "ws://localhost:3001" */
  url: string;
  /** Timeout (ms) waiting for promptReceived ack before treating as dead. Default 10000. */
  promptTimeout?: number;
  /** Timeout (ms) for the entire connectToFolder operation. Default 30000. */
  connectTimeout?: number;
  /** Max retries for connectToFolder on bridge errors. Default 3. */
  maxConnectRetries?: number;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  /** Called when session ID is assigned by bridge (transparent reconnect) */
  onSessionId?: (id: string) => void;
  /** Called on bridge-level error */
  onBridgeError?: (error: string) => void;
  /** Called when lobby mode is entered (WS open, no pending connect operation) */
  onLobbyConnected?: () => void;
  /** Called with folder list from bridge */
  onFolderList?: (folders: FolderInfo[]) => void;
  /** Called when CC process exits (code/signal) */
  onProcessExit?: (code: number | null, signal: string | null) => void;
  /** Called when bridge begins replaying history buffer */
  onHistoryStart?: () => void;
  /** Called when bridge finishes replaying history buffer */
  onHistoryEnd?: () => void;
  /** Called when connectToFolder succeeds — session established for the requested folder */
  onFolderConnected?: (sessionId: string, path: string) => void;
  /** Called when connectToFolder fails after retries/timeout */
  onFolderConnectFailed?: (reason: string, path: string) => void;
  /** Called when bridge creates a new folder */
  onFolderCreated?: (folder: FolderInfo) => void;
  /** Called when bridge deliberately closes the session (/exit, /quit) */
  onSessionClosed?: (deliberate: boolean) => void;
  /** Called when bridge confirms folder deletion */
  onFolderDeleted?: (path: string) => void;
  /** Called when a prompt is queued (CC mid-turn) — position is 1-based */
  onPromptQueued?: (position: number) => void;
}

// --- Reconnect backoff ---

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export class WSTransport implements CCTransport {
  private ws: WebSocket | null = null;
  private eventHandler: ((event: CCEvent) => void) | null = null;
  private options: Required<
    Pick<WSTransportOptions, "url" | "promptTimeout" | "connectTimeout" | "maxConnectRetries">
  > & WSTransportOptions;

  private sessionId: string | null = null;
  private folderPath: string | null = null; // Current folder — used to re-send connectFolder on reconnect
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false; // True after explicit close() — stops reconnect
  private _state: ConnectionState = "disconnected";
  private boundVisibilityHandler: (() => void) | null = null;
  vapidPublicKey: string | null = null; // Set by lobbyConnected, read by main.ts for push subscription

  // Active connectToFolder operation — null when no explicit connect is in flight.
  // Separate from folderPath (transparent reconnect) because connectToFolder has
  // retries, timeout, and distinct success/failure callbacks.
  private connectOp: {
    path: string;
    retries: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(options: WSTransportOptions) {
    this.options = {
      promptTimeout: 10_000,
      connectTimeout: 30_000,
      maxConnectRetries: 3,
      ...options,
    };
  }

  // --- CCTransport interface ---

  send(message: string | ContentBlock[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.options.onBridgeError?.("Not connected to bridge");
      return;
    }
    // Content arrays (text + images) use the content field; plain text uses text field.
    // Bridge passes content arrays directly to CC stdin as-is.
    const payload = Array.isArray(message)
      ? { type: "prompt", content: message }
      : { type: "prompt", text: message };
    this.ws.send(JSON.stringify(payload));
    this.startPromptTimer();
  }

  /** Send a raw message to the bridge (for non-prompt protocol messages). */
  sendRaw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onEvent(handler: (event: CCEvent) => void): void {
    this.eventHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.cancelConnectOp();
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

  createFolder(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "createFolder" }));
  }

  deleteFolder(path: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "deleteFolder", path }));
  }

  /**
   * High-level folder connect — handles lobby-teardown (if in session),
   * retry on bridge errors (up to maxConnectRetries), and overall timeout.
   *
   * Fires onFolderConnected on success, onFolderConnectFailed on failure.
   * The caller doesn't see intermediate states (lobby-teardown, retries).
   */
  connectToFolder(path: string): void {
    this.cancelConnectOp();

    this.connectOp = {
      path,
      retries: 0,
      timer: setTimeout(() => this.handleConnectOpTimeout(), this.options.connectTimeout),
    };

    if (this.folderPath) {
      // Currently in a session — tear down old connection, reconnect fresh.
      // When lobbyConnected arrives, connectOp handler sends connectFolder.
      this.sessionId = null;
      this.folderPath = null;
      this.clearPromptTimer();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.detachAndCloseWs("Switching folders");
      this.doConnect();
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      // Already in lobby with open WS — send connectFolder directly
      this.ws.send(JSON.stringify({ type: "connectFolder", path }));
    } else {
      // Disconnected or connecting — cancel any pending backoff, start fresh.
      // When lobbyConnected arrives, connectOp handler sends connectFolder.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.detachAndCloseWs("Connecting to folder");
      this.doConnect();
    }
  }

  /** Disconnect from current session and reconnect in lobby mode */
  returnToLobby(): void {
    this.cancelConnectOp();
    this.sessionId = null;
    this.folderPath = null;
    this.clearTimers();
    this.detachAndCloseWs("Returning to lobby");
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
          if (msg.vapidPublicKey) this.vapidPublicKey = msg.vapidPublicKey;
          if (this.connectOp) {
            // Active connectToFolder operation — send connectFolder for target
            this.ws!.send(JSON.stringify({ type: "connectFolder", path: this.connectOp.path }));
          } else if (this.folderPath) {
            // Transparent reconnect — re-send connectFolder for current folder
            this.ws!.send(JSON.stringify({ type: "connectFolder", path: this.folderPath }));
          } else {
            this.setState("lobby");
            this.options.onLobbyConnected?.();
          }
          break;

        case "folderList":
          this.options.onFolderList?.(msg.folders);
          break;
        case "folderCreated":
          this.options.onFolderCreated?.(msg.folder);
          break;
        case "folderDeleted":
          this.options.onFolderDeleted?.(msg.path);
          break;

        case "connected":
          this.sessionId = msg.sessionId;
          if (this.connectOp) {
            // connectToFolder succeeded — clear operation, fire dedicated callback
            this.folderPath = this.connectOp.path;
            const path = this.connectOp.path;
            clearTimeout(this.connectOp.timer);
            this.connectOp = null;
            this.options.onFolderConnected?.(msg.sessionId, path);
          } else {
            // Transparent reconnect — fire legacy callback
            this.options.onSessionId?.(msg.sessionId);
          }
          this.setState("connected");
          break;

        case "promptReceived":
          this.clearPromptTimer();
          break;

        case "promptQueued":
          this.clearPromptTimer();
          this.options.onPromptQueued?.(msg.position);
          break;

        case "error":
          if (this.connectOp) {
            // Error during connectToFolder — retry or fail.
            // Don't fire onBridgeError: onFolderConnectFailed handles user feedback.
            this.connectOp.retries++;
            if (this.connectOp.retries >= this.options.maxConnectRetries) {
              this.failConnectOp(msg.error);
            } else if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: "connectFolder", path: this.connectOp.path }));
            }
          } else if (this._state === "connecting") {
            // Auto-connectFolder on reconnect failed — fall back to lobby
            this.folderPath = null;
            this.setState("lobby");
            this.options.onBridgeError?.(msg.error);
            this.options.onLobbyConnected?.();
          } else {
            // Session-mode error — surface to user
            this.options.onBridgeError?.(msg.error);
          }
          break;

        case "historyStart":
          this.options.onHistoryStart?.();
          break;

        case "historyEnd":
          this.options.onHistoryEnd?.();
          break;

        case "processExit":
          // CC process died. Synthesize a result event so the adapter resets cleanly.
          this.clearPromptTimer();
          this.eventHandler?.({
            type: "result",
            subtype: "error",
            error: `CC process exited (code=${msg.code}, signal=${msg.signal})`,
          });
          if (this.connectOp) {
            // CC died during connect — immediate failure (retrying a crash is pointless)
            const detail = msg.signal ? `signal ${msg.signal}` : `code ${msg.code}`;
            this.failConnectOp(`CC process exited (${detail})`);
          }
          this.options.onProcessExit?.(msg.code ?? null, msg.signal ?? null);
          break;

        case "sessionClosed":
          // Session deliberately closed via /exit or /quit.
          // Synthesize a clean result so the adapter clears isStreaming.
          this.clearPromptTimer();
          this.eventHandler?.({
            type: "result",
            subtype: "success",
            result: "",
          });
          this.options.onSessionClosed?.(msg.deliberate ?? false);
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

  // --- Connect operation helpers ---

  private cancelConnectOp(): void {
    if (this.connectOp) {
      clearTimeout(this.connectOp.timer);
      this.connectOp = null;
    }
  }

  /** Connect operation timed out — fire failure callback, fall to lobby. */
  private handleConnectOpTimeout(): void {
    if (!this.connectOp) return;
    const path = this.connectOp.path;
    this.connectOp = null;
    this.folderPath = null;
    this.setState("lobby");
    // Fire failure only — NOT onLobbyConnected. The caller handles fallback
    // (e.g. showing folder picker) from onFolderConnectFailed. Firing both
    // would cause duplicate listFolders requests.
    this.options.onFolderConnectFailed?.("Connection timed out", path);
  }

  /** Connect operation failed (max retries or fatal error) — clean up and notify. */
  private failConnectOp(reason: string): void {
    if (!this.connectOp) return;
    const path = this.connectOp.path;
    clearTimeout(this.connectOp.timer);
    this.connectOp = null;
    this.folderPath = null;
    this.setState("lobby");
    this.options.onFolderConnectFailed?.(reason, path);
  }

  /** Detach handlers from current WS and close it. Prevents onclose races. */
  private detachAndCloseWs(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close(1000, reason);
    }
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
