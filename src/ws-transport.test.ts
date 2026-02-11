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

// --- Mock document for visibilitychange ---

let mockVisibilityState = "visible";
const visibilityListeners: Array<() => void> = [];

const mockDocument = {
  get visibilityState() { return mockVisibilityState; },
  addEventListener(type: string, handler: any) {
    if (type === "visibilitychange") visibilityListeners.push(handler);
  },
  removeEventListener(type: string, handler: any) {
    if (type === "visibilitychange") {
      const idx = visibilityListeners.indexOf(handler);
      if (idx >= 0) visibilityListeners.splice(idx, 1);
    }
  },
};

vi.stubGlobal("document", mockDocument);

function simulateVisibilityChange(state: "visible" | "hidden") {
  mockVisibilityState = state;
  for (const fn of [...visibilityListeners]) fn();
}

beforeEach(() => {
  wsInstances = [];
  mockVisibilityState = "visible";
  visibilityListeners.length = 0;
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
    onFolderConnected: vi.fn(),
    onFolderConnectFailed: vi.fn(),
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

/** Establish a session via connectToFolder. Returns the WS. */
function establishSession(transport: WSTransport, path: string, sessionId: string): MockWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  transport.connectToFolder(path);
  ws.simulateMessage({ source: "bridge", type: "connected", sessionId });
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

  it("sends connectFolder via connectToFolder", () => {
    const { transport } = createLobbyTransport();
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/my-project");

    const sent = ws.sent.map((s: string) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "connectFolder", path: "/repos/my-project" });
  });
});

// --- URL construction ---

describe("URL construction", () => {
  it("connects without query param in lobby mode (no sessionId)", () => {
    const { transport } = createLobbyTransport();
    transport.connect();

    expect(wsInstances[0].url).toBe("ws://localhost:3001");
  });

  it("always connects with plain URL (no ?session= param)", () => {
    const transport = new WSTransport({
      url: "ws://localhost:3001",
    });
    transport.connect();

    expect(wsInstances[0].url).toBe("ws://localhost:3001");
  });

  it("re-sends connectFolder on reconnect when folder is set", () => {
    const transport = new WSTransport({ url: "ws://localhost:3001", onFolderConnected: vi.fn() });
    transport.connect();
    const ws1 = wsInstances[0];
    ws1.simulateOpen();
    ws1.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // User picks a folder via high-level API
    transport.connectToFolder("/repos/my-project");
    ws1.simulateMessage({
      source: "bridge",
      type: "connected",
      sessionId: "session-123",
    });

    // WS drops and reconnects
    ws1.simulateClose();
    vi.advanceTimersByTime(1000);
    const ws2 = wsInstances[wsInstances.length - 1];
    expect(ws2.url).toBe("ws://localhost:3001"); // plain URL
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Should auto-send connectFolder for the stored folder
    const sent = ws2.sent.map((s: string) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "connectFolder", path: "/repos/my-project" });
  });

  it("falls back to lobby if auto-connectFolder fails on reconnect", () => {
    const callbacks = {
      onLobbyConnected: vi.fn(),
      onBridgeError: vi.fn(),
      onFolderConnected: vi.fn(),
    };
    const transport = new WSTransport({ url: "ws://localhost:3001", ...callbacks });
    transport.connect();
    const ws1 = wsInstances[0];
    ws1.simulateOpen();
    ws1.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Connect to a folder via high-level API
    transport.connectToFolder("/repos/my-project");
    ws1.simulateMessage({
      source: "bridge",
      type: "connected",
      sessionId: "session-123",
    });

    // WS drops and reconnects
    ws1.simulateClose();
    vi.advanceTimersByTime(1000);
    const ws2 = wsInstances[wsInstances.length - 1];
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Bridge rejects connectFolder (folder deleted, etc.)
    ws2.simulateMessage({
      source: "bridge",
      type: "error",
      error: "Folder path must be within scan root",
    });

    // Should fall back to lobby
    expect(callbacks.onBridgeError).toHaveBeenCalledWith("Folder path must be within scan root");
    expect(callbacks.onLobbyConnected).toHaveBeenCalled();
    expect(transport.state).toBe("lobby");
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

// --- sessionClosed ---

describe("sessionClosed", () => {
  it("synthesizes success result event and fires onSessionClosed callback", () => {
    const onSessionClosed = vi.fn();
    const { transport } = createLobbyTransport({ onSessionClosed });
    const ws = connectAndOpen(transport);
    const received: any[] = [];
    transport.onEvent((e) => received.push(e));

    ws.simulateMessage({
      source: "bridge",
      type: "sessionClosed",
      deliberate: true,
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("result");
    expect(received[0].subtype).toBe("success");
    expect(onSessionClosed).toHaveBeenCalledWith(true);
  });

  it("clears prompt timer on sessionClosed", () => {
    const { transport, callbacks } = createLobbyTransport();
    const ws = connectAndOpen(transport);

    transport.send("test"); // starts prompt timer
    ws.simulateMessage({ source: "bridge", type: "sessionClosed", deliberate: true });

    vi.advanceTimersByTime(10_000);
    expect(callbacks.onBridgeError).not.toHaveBeenCalled();
  });
});

// --- returnToLobby ---

describe("returnToLobby", () => {
  it("clears folder and reconnects in lobby mode", () => {
    const callbacks = { onLobbyConnected: vi.fn(), onFolderConnected: vi.fn() };
    const transport = new WSTransport({
      url: "ws://localhost:3001",
      ...callbacks,
    });
    transport.connect();
    const ws1 = wsInstances[0];
    ws1.simulateOpen();
    ws1.simulateMessage({ source: "bridge", type: "lobbyConnected" });
    transport.connectToFolder("/repos/old-project");
    ws1.simulateMessage({
      source: "bridge",
      type: "connected",
      sessionId: "old-session",
    });

    transport.returnToLobby();

    // Should create a new WS with plain URL
    const ws2 = wsInstances[wsInstances.length - 1];
    expect(ws2.url).toBe("ws://localhost:3001");
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Should NOT auto-send connectFolder (folderPath was cleared)
    const sent = ws2.sent.map((s: string) => JSON.parse(s));
    expect(sent.filter((m: any) => m.type === "connectFolder")).toHaveLength(0);
    // Should fire onLobbyConnected (user sees folder picker)
    expect(callbacks.onLobbyConnected).toHaveBeenCalled();
  });
});

// --- Visibility change (mobile tab resume) ---

describe("visibilitychange", () => {
  it("reconnects immediately when tab becomes visible and WS is dead", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);

    // WS dies, normal backoff would wait 1s
    ws1.simulateClose();
    expect(wsInstances).toHaveLength(1);

    // Tab comes back — should reconnect instantly, not wait for backoff
    simulateVisibilityChange("visible");
    expect(wsInstances).toHaveLength(2);
  });

  it("does not reconnect when WS is still open", () => {
    const { transport } = createLobbyTransport();
    connectAndOpen(transport);

    simulateVisibilityChange("visible");

    // No extra WS — the existing one is healthy
    expect(wsInstances).toHaveLength(1);
  });

  it("cancels pending backoff timer on visibility reconnect", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);

    // WS dies — backoff timer starts (1s)
    ws1.simulateClose();

    // Tab comes back before backoff fires
    simulateVisibilityChange("visible");
    expect(wsInstances).toHaveLength(2);

    // Advance past the original backoff — should NOT create a third WS
    vi.advanceTimersByTime(1000);
    expect(wsInstances).toHaveLength(2);
  });

  it("resets backoff counter so next failure uses base delay", () => {
    const { transport } = createLobbyTransport();
    const ws1 = connectAndOpen(transport);

    // Burn through two failures to escalate backoff: 1s, 2s
    ws1.simulateClose();
    vi.advanceTimersByTime(1000);
    wsInstances[1].simulateClose();
    vi.advanceTimersByTime(2000);
    // Now at attempt 2, next would be 4s

    // Tab resume reconnects and resets counter
    wsInstances[2].simulateClose();
    simulateVisibilityChange("visible");
    expect(wsInstances).toHaveLength(4);

    // This new connection fails — backoff should be 1s (reset), not 4s
    wsInstances[3].simulateClose();
    vi.advanceTimersByTime(999);
    expect(wsInstances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(5);
  });

  it("does nothing when page goes hidden", () => {
    const { transport } = createLobbyTransport();
    connectAndOpen(transport);

    simulateVisibilityChange("hidden");

    expect(wsInstances).toHaveLength(1);
  });

  it("does not reconnect after close()", () => {
    const { transport } = createLobbyTransport();
    connectAndOpen(transport);

    transport.close();

    simulateVisibilityChange("visible");
    // Only the original WS — no reconnect attempt
    expect(wsInstances).toHaveLength(1);
  });

  it("registers listener on connect(), not before", () => {
    const { transport } = createLobbyTransport();
    expect(visibilityListeners).toHaveLength(0);
    transport.connect();
    expect(visibilityListeners).toHaveLength(1);
  });
});

// --- History replay messages ---

describe("history replay", () => {
  it("fires onHistoryStart when bridge sends historyStart", () => {
    const onHistoryStart = vi.fn();
    const { transport } = createLobbyTransport({ onHistoryStart });
    const ws = connectAndOpen(transport);

    ws.simulateMessage({ source: "bridge", type: "historyStart" });
    expect(onHistoryStart).toHaveBeenCalledOnce();
  });

  it("fires onHistoryEnd when bridge sends historyEnd", () => {
    const onHistoryEnd = vi.fn();
    const { transport } = createLobbyTransport({ onHistoryEnd });
    const ws = connectAndOpen(transport);

    ws.simulateMessage({ source: "bridge", type: "historyEnd" });
    expect(onHistoryEnd).toHaveBeenCalledOnce();
  });

  it("forwards CC events between historyStart and historyEnd to eventHandler", () => {
    const onHistoryStart = vi.fn();
    const onHistoryEnd = vi.fn();
    const { transport } = createLobbyTransport({ onHistoryStart, onHistoryEnd });
    const ws = connectAndOpen(transport);
    const received: any[] = [];
    transport.onEvent((e) => received.push(e));

    ws.simulateMessage({ source: "bridge", type: "historyStart" });
    ws.simulateMessage({ source: "cc", event: { type: "system", cwd: "/test" } });
    ws.simulateMessage({ source: "cc", event: { type: "result", subtype: "success" } });
    ws.simulateMessage({ source: "bridge", type: "historyEnd" });

    expect(onHistoryStart).toHaveBeenCalledOnce();
    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("system");
    expect(received[1].type).toBe("result");
    expect(onHistoryEnd).toHaveBeenCalledOnce();
  });

  it("removes listener on close()", () => {
    const { transport } = createLobbyTransport();
    connectAndOpen(transport);

    expect(visibilityListeners).toHaveLength(1);
    transport.close();
    expect(visibilityListeners).toHaveLength(0);
  });
});

// --- connectToFolder (high-level folder connect) ---

describe("connectToFolder", () => {
  it("sends connectFolder when already in lobby with open WS", () => {
    const onFolderConnected = vi.fn();
    const { transport } = createLobbyTransport({ onFolderConnected });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");

    const sent = ws.sent.map((s: string) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "connectFolder", path: "/repos/alpha" });
  });

  it("fires onFolderConnected on success", () => {
    const onFolderConnected = vi.fn();
    const onSessionId = vi.fn();
    const { transport } = createLobbyTransport({ onFolderConnected, onSessionId });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");
    ws.simulateMessage({ source: "bridge", type: "connected", sessionId: "sess-1" });

    expect(onFolderConnected).toHaveBeenCalledWith("sess-1", "/repos/alpha");
    // onSessionId should NOT fire — this is an explicit connect, not a transparent reconnect
    expect(onSessionId).not.toHaveBeenCalled();
    expect(transport.state).toBe("connected");
  });

  it("tears down session and reconnects when called mid-session", () => {
    const onFolderConnected = vi.fn();
    const { transport } = createLobbyTransport({ onFolderConnected });
    const ws1 = connectAndOpen(transport);
    ws1.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Establish a session
    transport.connectToFolder("/repos/old");
    ws1.simulateMessage({ source: "bridge", type: "connected", sessionId: "old-sess" });

    // Now switch to new folder via high-level API
    transport.connectToFolder("/repos/new");

    // Should have created a new WS (torn down old one)
    const ws2 = wsInstances[wsInstances.length - 1];
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Should have sent connectFolder for the NEW folder, not the old one
    const sent = ws2.sent.map((s: string) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "connectFolder", path: "/repos/new" });
    expect(sent.filter((m: any) => m.path === "/repos/old")).toHaveLength(0);

    // Complete the connection
    ws2.simulateMessage({ source: "bridge", type: "connected", sessionId: "new-sess" });
    expect(onFolderConnected).toHaveBeenCalledWith("new-sess", "/repos/new");
  });

  it("retries on bridge error up to maxConnectRetries", () => {
    const onFolderConnectFailed = vi.fn();
    const onBridgeError = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      onBridgeError,
      maxConnectRetries: 3,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");

    // First error — retry 1
    ws.simulateMessage({ source: "bridge", type: "error", error: "spawn failed" });
    expect(onFolderConnectFailed).not.toHaveBeenCalled();
    expect(onBridgeError).toHaveBeenCalledWith("spawn failed");

    // Second error — retry 2
    ws.simulateMessage({ source: "bridge", type: "error", error: "spawn failed" });
    expect(onFolderConnectFailed).not.toHaveBeenCalled();

    // Third error — max reached, fires failure
    ws.simulateMessage({ source: "bridge", type: "error", error: "spawn failed" });
    expect(onFolderConnectFailed).toHaveBeenCalledWith("spawn failed", "/repos/alpha");
    expect(transport.state).toBe("lobby");
  });

  it("succeeds after partial retries", () => {
    const onFolderConnected = vi.fn();
    const onFolderConnectFailed = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnected,
      onFolderConnectFailed,
      maxConnectRetries: 3,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");

    // First error — retry
    ws.simulateMessage({ source: "bridge", type: "error", error: "transient" });
    // Second attempt succeeds
    ws.simulateMessage({ source: "bridge", type: "connected", sessionId: "recovered" });

    expect(onFolderConnected).toHaveBeenCalledWith("recovered", "/repos/alpha");
    expect(onFolderConnectFailed).not.toHaveBeenCalled();
  });

  it("times out after connectTimeout", () => {
    const onFolderConnectFailed = vi.fn();
    const onLobbyConnected = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      onLobbyConnected,
      connectTimeout: 30_000,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });
    onLobbyConnected.mockClear(); // Clear the initial lobby call

    transport.connectToFolder("/repos/alpha");

    vi.advanceTimersByTime(29_999);
    expect(onFolderConnectFailed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFolderConnectFailed).toHaveBeenCalledWith("Connection timed out", "/repos/alpha");
    // onLobbyConnected NOT fired — caller handles fallback from onFolderConnectFailed
    expect(onLobbyConnected).not.toHaveBeenCalled();
    expect(transport.state).toBe("lobby");
  });

  it("clears timeout on success", () => {
    const onFolderConnectFailed = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      connectTimeout: 30_000,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");
    ws.simulateMessage({ source: "bridge", type: "connected", sessionId: "s1" });

    // Timeout should be cleared — no failure after 30s
    vi.advanceTimersByTime(30_000);
    expect(onFolderConnectFailed).not.toHaveBeenCalled();
  });

  it("cancels previous connect operation when called again", () => {
    const onFolderConnected = vi.fn();
    const onFolderConnectFailed = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnected,
      onFolderConnectFailed,
      connectTimeout: 30_000,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // First connect
    transport.connectToFolder("/repos/first");
    // Second connect cancels first
    transport.connectToFolder("/repos/second");

    // First connect's timeout should NOT fire
    vi.advanceTimersByTime(30_000);
    expect(onFolderConnectFailed).toHaveBeenCalledTimes(1); // Only second times out
    expect(onFolderConnectFailed).toHaveBeenCalledWith("Connection timed out", "/repos/second");
  });

  it("fails immediately on processExit (no retry)", () => {
    const onFolderConnectFailed = vi.fn();
    const onProcessExit = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      onProcessExit,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");
    ws.simulateMessage({
      source: "bridge",
      type: "processExit",
      code: 1,
      signal: null,
    });

    expect(onFolderConnectFailed).toHaveBeenCalledWith(
      "CC process exited (code 1)",
      "/repos/alpha",
    );
    expect(onProcessExit).toHaveBeenCalled();
    expect(transport.state).toBe("lobby");
  });

  it("sends connectFolder on lobby entry when WS was disconnected", () => {
    const onFolderConnected = vi.fn();
    const { transport } = createLobbyTransport({ onFolderConnected });
    // Don't connect yet — transport is disconnected

    transport.connect();
    transport.connectToFolder("/repos/alpha");

    // WS connects
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Should have sent connectFolder
    const sent = ws.sent.map((s: string) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "connectFolder", path: "/repos/alpha" });
  });

  it("close() cancels active connect operation", () => {
    const onFolderConnectFailed = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      connectTimeout: 30_000,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    transport.connectToFolder("/repos/alpha");
    transport.close();

    // Timeout should NOT fire
    vi.advanceTimersByTime(30_000);
    expect(onFolderConnectFailed).not.toHaveBeenCalled();
  });

  it("returnToLobby() cancels active connect operation", () => {
    const onFolderConnectFailed = vi.fn();
    const onLobbyConnected = vi.fn();
    const { transport } = createLobbyTransport({
      onFolderConnectFailed,
      onLobbyConnected,
      connectTimeout: 30_000,
    });
    const ws = connectAndOpen(transport);
    ws.simulateMessage({ source: "bridge", type: "lobbyConnected" });
    onLobbyConnected.mockClear();

    transport.connectToFolder("/repos/alpha");
    transport.returnToLobby();

    // New WS reconnects in lobby
    const ws2 = wsInstances[wsInstances.length - 1];
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Should fire onLobbyConnected (not try to connectFolder)
    expect(onLobbyConnected).toHaveBeenCalledOnce();
    // Timeout should NOT fire
    vi.advanceTimersByTime(30_000);
    expect(onFolderConnectFailed).not.toHaveBeenCalled();
  });

  it("transparent reconnect still uses onSessionId (not onFolderConnected)", () => {
    const onFolderConnected = vi.fn();
    const onSessionId = vi.fn();
    const { transport } = createLobbyTransport({ onFolderConnected, onSessionId });
    const ws1 = connectAndOpen(transport);
    ws1.simulateMessage({ source: "bridge", type: "lobbyConnected" });

    // Establish session (sets folderPath for reconnect)
    transport.connectToFolder("/repos/project");
    ws1.simulateMessage({ source: "bridge", type: "connected", sessionId: "s1" });
    onFolderConnected.mockClear(); // Clear setup call

    // WS drops
    ws1.simulateClose();
    vi.advanceTimersByTime(1000);
    const ws2 = wsInstances[wsInstances.length - 1];
    ws2.simulateOpen();
    ws2.simulateMessage({ source: "bridge", type: "lobbyConnected" });
    ws2.simulateMessage({ source: "bridge", type: "connected", sessionId: "s1-restored" });

    // Should use onSessionId (transparent reconnect), NOT onFolderConnected
    expect(onSessionId).toHaveBeenCalledWith("s1-restored");
    expect(onFolderConnected).not.toHaveBeenCalled();
  });
});
