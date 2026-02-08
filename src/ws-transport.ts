/**
 * WebSocket transport — implements CCTransport over WebSocket to the bridge server.
 *
 * Handles the bridge protocol (source discrimination), auto-reconnect with
 * exponential backoff, and promptReceived timeout (liveness proof that the
 * remote end got the message).
 */

import type { CCTransport, CCEvent } from "./claude-code-agent.js";

// --- Connection state ---

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface WSTransportOptions {
  /** Bridge WebSocket URL, e.g. "ws://localhost:3001" */
  url: string;
  /** Session ID for reconnect. If provided, appended as ?session=<id> */
  sessionId?: string;
  /** Timeout (ms) waiting for promptReceived ack before treating as dead. Default 10000. */
  promptTimeout?: number;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  /** Called when session ID is assigned by bridge */
  onSessionId?: (id: string) => void;
  /** Called on bridge-level error */
  onBridgeError?: (error: string) => void;
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

  private sessionId: string | null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false; // True after explicit close() — stops reconnect
  private _state: ConnectionState = "disconnected";

  constructor(options: WSTransportOptions) {
    this.options = {
      promptTimeout: 10_000,
      ...options,
    };
    this.sessionId = options.sessionId ?? null;
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
    this.doConnect();
  }

  /** Send abort to bridge (kills CC process) */
  abort(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "abort" }));
  }

  // --- Internal ---

  private doConnect(): void {
    if (this.closed) return;

    const url = this.sessionId
      ? `${this.options.url}?session=${this.sessionId}`
      : this.options.url;

    this.setState("connecting");
    this.ws = new WebSocket(url);

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

        case "processExit":
          // CC process died — not a connection error, but the adapter
          // should know (it'll get this as a CC event if we forward it,
          // but processExit is bridge-level, not CC-level)
          // We could synthesize a CC event here, but the adapter's
          // result handler already covers normal exits. This handles
          // abnormal exits (crash, abort).
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

  // --- Cleanup ---

  private clearTimers(): void {
    this.clearPromptTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
