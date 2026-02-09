import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WSTransport, type ConnectionState, type FolderInfo } from "./ws-transport.js";

// --- Mock WebSocket ---

let wsInstances: MockWebSocket[];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }

  // --- Test helpers ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  wsInstances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Create a transport in lobby mode (no sessionId) and connect. */
function createLobbyTransport(overrides?: Partial<Parameters<typeof WSTransport.prototype.connect>[0]>) {
  const callbacks = {
    onStateChange: vi.fn(),
    onSessionId: vi.fn(),
    onBridgeError: vi.fn(),
    onLobbyConnected: vi.fn(),
    onFolderList: vi.fn(),
  };
  const transport = new WSTransport({
    url: "ws://localhost:3001",
    ...callbacks,
    ...overrides,
  });
  return { transport, callbacks };
}

/** Create, connect, and open a transport. Returns latest WS instance. */
function connectAndOpen(transport: WSTransport): MockWebSocket {
  transport.connect();
  const ws = wsInstances[wsInstances.length - 1];
  ws.simulateOpen();
  return ws;
}

// --- Connection state ---

describe("connection lifecycle", () => {
  it("starts as disconnected", () => {
    const { transport } = createLobbyTransport();
    expect(transport.state).toBe("disconnected");
  });

  it("moves to connecting on connect()", () => {
    const { transport, callbacks } = createLobbyTransport();
    transport.connect();
    expect(transport.state).toBe("connecting");
    expect(callbacks.onStateChange).toHaveBeenCalledWith("connecting", undefined);
  });

  it("enters lobby when bridge sends lobbyConnected (no sessionId)", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    expect(transport.state).toBe("lobby");
    expect(callbacks.onLobbyConnected).toHaveBeenCalledOnce();
  });

  it("enters connected when bridge sends connected with sessionId", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    ws.simulateMessage({ source: "bridge", type: "connected", sessionId: "sess-123" });

    expect(transport.state).toBe("connected");
    expect(callbacks.onSessionId).toHaveBeenCalledWith("sess-123");
  });

  it("moves to disconnected on WS close", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    ws.simulateClose();

    expect(transport.state).toBe("disconnected");
  });

  it("close() prevents reconnect", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.close();

    expect(transport.state).toBe("disconnected");
    // Advance past any backoff — should NOT create new WS
    vi.advanceTimersByTime(60_000);
    expect(wsInstances).toHaveLength(1);
  });
});

// --- Message dispatch ---

describe("message dispatch", () => {
  it("forwards CC events to event handler", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);
    const received: any[] = [];
    transport.onEvent((e) => received.push(e));

    ws.simulateMessage({
      source: "cc",
      event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("assistant");
    expect(received[0].message.content[0].text).toBe("hi");
  });

  it("routes bridge errors to onBridgeError", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    ws.simulateMessage({ source: "bridge", type: "error", error: "Something broke" });

    expect(callbacks.onBridgeError).toHaveBeenCalledWith("Something broke");
  });

  it("delivers folder list to onFolderList", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    const folders: FolderInfo[] = [
      { name: "project-a", path: "/repos/project-a", state: "fresh", sessionId: null, lastActive: null, handoffPurpose: null },
    ];
    ws.simulateMessage({ source: "bridge", type: "folderList", folders });

    expect(callbacks.onFolderList).toHaveBeenCalledWith(folders);
  });

  it("ignores malformed (non-JSON) messages", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);
    const received: any[] = [];
    transport.onEvent((e) => received.push(e));

    // Manually fire non-JSON
    ws.onmessage?.({ data: "not json{" });

    expect(received).toHaveLength(0);
  });
});

// --- Send ---

describe("send", () => {
  it("sends prompt message as JSON", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.send("Hello Claude");

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "prompt", text: "Hello Claude" });
  });

  it("fires onBridgeError when not connected", () => {
    const { transport, callbacks } = createLobbyTransport();
    // Don't connect
    transport.send("test");
    expect(callbacks.onBridgeError).toHaveBeenCalledWith("Not connected to bridge");
  });

  it("sends abort message", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.abort();

    expect(JSON.parse(ws.sent[0])).toEqual({ type: "abort" });
  });

  it("sends listFolders request", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.listFolders();

    expect(JSON.parse(ws.sent[0])).toEqual({ type: "listFolders" });
  });

  it("sends connectFolder request", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.connectFolder("/repos/my-project");

    expect(JSON.parse(ws.sent[0])).toEqual({ type: "connectFolder", path: "/repos/my-project" });
  });
});

// --- URL construction ---

describe("URL construction", () => {
  it("connects without query param in lobby mode (no sessionId)", () => {
    const { transport } = createLobbyTransport();
    transport.connect();

    expect(wsInstances[0].url).toBe("ws://localhost:3001");
  });

  it("appends session query param when sessionId is set", () => {
    const transport = new WSTransport({
      url: "ws://localhost:3001",
      sessionId: "my-session",
    });
    transport.connect();

    expect(wsInstances[0].url).toBe("ws://localhost:3001?session=my-session");
  });
});

// --- Reconnect backoff ---

describe("reconnect backoff", () => {
  it("reconnects with exponential backoff: 1s, 2s, 4s", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);

    // First disconnect — should reconnect after 1000ms
    ws1.simulateClose();
    expect(wsInstances).toHaveLength(1); // Not yet
    vi.advanceTimersByTime(1000);
    expect(wsInstances).toHaveLength(2); // Reconnected

    // ws2 fails (close without opening) — next backoff is 2000ms
    wsInstances[1].simulateClose();
    vi.advanceTimersByTime(1999);
    expect(wsInstances).toHaveLength(2); // Not yet
    vi.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(3); // Reconnected at 2000ms

    // ws3 fails — next backoff is 4000ms
    wsInstances[2].simulateClose();
    vi.advanceTimersByTime(3999);
    expect(wsInstances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(4);
  });

  it("caps backoff at 30 seconds", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);
    ws1.simulateClose();

    // Burn through 5 consecutive failures: delays 1s, 2s, 4s, 8s, 16s
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (const delay of delays) {
      vi.advanceTimersByTime(delay);
      wsInstances[wsInstances.length - 1].simulateClose();
    }

    // Next delay should be capped at 30000 (not 32000)
    const countBefore = wsInstances.length;
    vi.advanceTimersByTime(29_999);
    expect(wsInstances.length).toBe(countBefore);
    vi.advanceTimersByTime(1);
    expect(wsInstances.length).toBe(countBefore + 1);
  });

  it("resets backoff after successful connection", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);

    // First disconnect
    ws1.simulateClose();
    vi.advanceTimersByTime(1000);
    expect(wsInstances).toHaveLength(2);

    // Successful reconnect — resets backoff counter
    const ws2 = wsInstances[1];
    ws2.simulateOpen();

    // Second disconnect — should be back to 1000ms, not 2000ms
    ws2.simulateClose();
    vi.advanceTimersByTime(999);
    expect(wsInstances).toHaveLength(2); // Not yet
    vi.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(3); // At 1000ms
  });
});

// --- Prompt timeout ---

describe("prompt timeout", () => {
  it("fires onBridgeError after timeout when no promptReceived", () => {
    const { transport, callbacks } = createLobbyTransport({ promptTimeout: 10_000 });
    const ws = connectAndOpen(transport);

    transport.send("test");
    expect(callbacks.onBridgeError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(callbacks.onBridgeError).toHaveBeenCalledWith(
      "No response from bridge — message may not have reached Claude",
    );
  });

  it("clears timeout on promptReceived", () => {
    const { transport, callbacks } = createLobbyTransport({ promptTimeout: 10_000 });
    const ws = connectAndOpen(transport);

    transport.send("test");
    // Bridge acks promptReceived before timeout
    ws.simulateMessage({ source: "bridge", type: "promptReceived" });

    vi.advanceTimersByTime(10_000);
    // Should NOT have fired error
    expect(callbacks.onBridgeError).not.toHaveBeenCalled();
  });

  it("uses custom timeout value", () => {
    const { transport, callbacks } = createLobbyTransport({ promptTimeout: 5_000 });
    const ws = connectAndOpen(transport);

    transport.send("test");
    vi.advanceTimersByTime(4_999);
    expect(callbacks.onBridgeError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callbacks.onBridgeError).toHaveBeenCalled();
  });
});

// --- processExit → synthetic result (THE BUG from session 3) ---

describe("processExit", () => {
  it("synthesizes result event so adapter clears isStreaming", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);
    const received: any[] = [];
    transport.onEvent((e) => received.push(e));

    ws.simulateMessage({
      source: "bridge",
      type: "processExit",
      code: 1,
      signal: "SIGKILL",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("result");
    expect(received[0].subtype).toBe("error");
    expect(received[0].error).toContain("code=1");
    expect(received[0].error).toContain("signal=SIGKILL");
  });

  it("clears prompt timer on processExit", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.send("test"); // starts prompt timer
    ws.simulateMessage({ source: "bridge", type: "processExit", code: 0, signal: null });

    // Timer should be cleared — no error after timeout
    vi.advanceTimersByTime(10_000);
    expect(callbacks.onBridgeError).not.toHaveBeenCalled();
  });
});

// --- returnToLobby ---

describe("returnToLobby", () => {
  it("disconnects and reconnects without session param", () => {
    const transport = new WSTransport({
      url: "ws://localhost:3001",
      sessionId: "old-session",
    });
    transport.connect();
    const ws1 = wsInstances[0];
    expect(ws1.url).toContain("?session=old-session");
    ws1.simulateOpen();

    transport.returnToLobby();

    // Should create a new WS without session param
    const ws2 = wsInstances[wsInstances.length - 1];
    expect(ws2.url).toBe("ws://localhost:3001");
  });
});
