import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { IncomingMessage } from "http";
import { scanFolders, getLatestSession, getLatestHandoff, FolderInfo, SCAN_ROOT } from "./folders.js";
import {
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  KILL_ESCALATION_MS,
  EARLY_EXIT_MS,
  buildCCArgs,
  getActiveProcesses as getActiveProcessesFromSessions,
  resolveSessionForFolder,
  validateFolderPath,
} from "./bridge-logic.js";

// --- Configuration ---

const PORT = parseInt(process.env.BRIDGE_PORT || "3001", 10);

// --- Protocol types ---

// Browser → Bridge
interface ClientPrompt {
  type: "prompt";
  text: string;
}
interface ClientAbort {
  type: "abort";
}
interface ClientListFolders {
  type: "listFolders";
}
interface ClientConnectFolder {
  type: "connectFolder";
  path: string;
}
type ClientMessage =
  | ClientPrompt
  | ClientAbort
  | ClientListFolders
  | ClientConnectFolder;

// Bridge → Browser
interface BridgeConnected {
  source: "bridge";
  type: "connected";
  sessionId: string;
  resumed: boolean;
}
interface BridgePromptReceived {
  source: "bridge";
  type: "promptReceived";
}
interface BridgeError {
  source: "bridge";
  type: "error";
  error: string;
}
interface BridgeProcessExit {
  source: "bridge";
  type: "processExit";
  code: number | null;
  signal: string | null;
}
interface BridgeLobbyConnected {
  source: "bridge";
  type: "lobbyConnected";
}
interface BridgeFolderList {
  source: "bridge";
  type: "folderList";
  folders: FolderInfo[];
}
interface BridgeHistoryStart {
  source: "bridge";
  type: "historyStart";
}
interface BridgeHistoryEnd {
  source: "bridge";
  type: "historyEnd";
}
interface BridgeCCEvent {
  source: "cc";
  event: Record<string, unknown>;
}
type ServerMessage =
  | BridgeConnected
  | BridgePromptReceived
  | BridgeError
  | BridgeProcessExit
  | BridgeLobbyConnected
  | BridgeFolderList
  | BridgeHistoryStart
  | BridgeHistoryEnd
  | BridgeCCEvent;

// --- Session state ---

interface Session {
  id: string;
  folder: string | null; // Folder path (null for legacy ?session= connections)
  resumable: boolean; // True when CC has state for this session ID.
  // Used for both spawn strategy (--resume vs --session-id) and the `resumed`
  // field on the `connected` message to the client. These overlap today but are
  // conceptually distinct — if we need to distinguish "fresh WS to existing CC
  // session" from "WS reconnecting to active bridge session", split this field.
  process: ChildProcess | null;
  clients: Set<WebSocket>; // All browser tabs connected to this session
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageBuffer: string[]; // Serialized CC events for replay on reconnect
  stderrBuffer: string[]; // Capture stderr for early-exit diagnostics
  spawnedAt: number | null; // Timestamp of last spawn, for early-exit detection
}

const sessions = new Map<string, Session>();

// --- Per-connection state ---
// Ping/pong is a connection concern (WS health), not a session concern (process lifecycle).

interface PingPongState {
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  ping: PingPongState;
  state:
    | { mode: "lobby" }
    | { mode: "session"; session: Session };
}

const connections = new Map<WebSocket, Connection>();

/** Build activeProcesses map from sessions for scanFolders. */
function getActiveProcesses(): Map<string, string> {
  return getActiveProcessesFromSessions(sessions);
}

// --- CC process management ---

function spawnCC(sessionId: string, resume: boolean, cwd?: string): ChildProcess {
  const args = buildCCArgs(sessionId, resume);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    ...(cwd && { cwd }),
  });

  console.log(
    `[bridge] spawned CC pid=${proc.pid} session=${sessionId}${resume ? " (resume)" : ""}${cwd ? ` cwd=${cwd}` : ""}`
  );
  return proc;
}

/** Kill a process with SIGTERM, escalate to SIGKILL after timeout */
function killWithEscalation(proc: ChildProcess, sessionId: string): void {
  if (!proc.pid) return;
  proc.kill("SIGTERM");
  const escalation = setTimeout(() => {
    try {
      // Check if process is still alive
      process.kill(proc.pid!, 0);
      console.log(
        `[bridge] SIGTERM didn't stop CC session=${sessionId}, escalating to SIGKILL`
      );
      proc.kill("SIGKILL");
    } catch {
      // Process already gone — good
    }
  }, KILL_ESCALATION_MS);
  // Don't let the timer keep the Node process alive
  escalation.unref();
}

function sendToClient(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Send a message to all connected clients for a session. */
function broadcast(session: Session, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** Write to CC stdin with error handling (fixes TOCTOU race) */
function writeToStdin(session: Session, data: string): boolean {
  const stdin = session.process?.stdin;
  if (!stdin) return false;
  try {
    stdin.write(data);
    return true;
  } catch (err) {
    console.error(
      `[bridge] stdin write failed session=${session.id}:`,
      (err as Error).message
    );
    broadcast(session, {
      source: "bridge",
      type: "error",
      error: "CC process stdin closed unexpectedly",
    });
    return false;
  }
}

function wireProcessToSession(session: Session): void {
  const proc = session.process;
  if (!proc || !proc.stdout) return;

  session.resumable = true; // CC now has state for this session ID
  session.stderrBuffer = [];
  session.spawnedAt = Date.now();

  // Parse CC stdout line-by-line as JSONL
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      // Inline broadcast + buffer: serialize once, send to clients, push to buffer
      const serialized = JSON.stringify({ source: "cc", event });
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(serialized);
      }
      session.messageBuffer.push(serialized);
    } catch {
      // Non-JSON output from CC (startup banners, warnings)
      console.log(`[bridge] non-json stdout: ${trimmed.slice(0, 200)}`);
    }
  });

  // Capture stderr for diagnostics
  if (proc.stderr) {
    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      console.log(`[bridge] stderr: ${line}`);
      // Keep last 20 lines for early-exit diagnostics
      session.stderrBuffer.push(line);
      if (session.stderrBuffer.length > 20) session.stderrBuffer.shift();
    });
  }

  // Process exit
  proc.on("exit", (code, signal) => {
    const uptime = session.spawnedAt ? Date.now() - session.spawnedAt : null;
    console.log(
      `[bridge] CC exited session=${session.id} code=${code} signal=${signal} uptime=${uptime}ms`
    );

    // Early exit with non-zero code = likely flag/version problem
    if (
      code !== 0 &&
      signal === null &&
      uptime !== null &&
      uptime < EARLY_EXIT_MS
    ) {
      const stderr = session.stderrBuffer.join("\n");
      const hint = stderr || "No stderr output captured";
      broadcast(session, {
        source: "bridge",
        type: "error",
        error: `CC process failed immediately (${uptime}ms). Likely a flag or version problem.\n${hint}`,
      });
    }

    broadcast(session, {
      source: "bridge",
      type: "processExit",
      code,
      signal: signal ?? null,
    });
    session.process = null;
    session.spawnedAt = null;
  });

  proc.on("error", (err) => {
    console.error(`[bridge] CC spawn error session=${session.id}:`, err);
    broadcast(session, {
      source: "bridge",
      type: "error",
      error: `Process error: ${err.message}`,
    });
    session.process = null;
    session.spawnedAt = null;
  });
}

/** Ensure CC process is running for this session, spawning if needed. Returns true if ready. */
function ensureProcess(session: Session, resume: boolean): boolean {
  if (session.process && session.process.exitCode === null) return true;

  try {
    session.process = spawnCC(session.id, resume, session.folder ?? undefined);
    wireProcessToSession(session);
    return true;
  } catch (err) {
    console.error(
      `[bridge] failed to spawn CC session=${session.id}:`,
      (err as Error).message
    );
    broadcast(session, {
      source: "bridge",
      type: "error",
      error: `Failed to spawn CC: ${(err as Error).message}`,
    });
    return false;
  }
}

// --- Ping/pong ---

function startPingPong(ws: WebSocket, ping: PingPongState): void {
  stopPingPong(ping);

  ping.pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stopPingPong(ping);
      return;
    }
    ws.ping();
    ping.pongTimer = setTimeout(() => {
      // Resolve label at timeout time so it reflects current mode
      const conn = connections.get(ws);
      const label =
        conn?.state.mode === "session"
          ? `session=${conn.state.session.id}`
          : "lobby";
      console.log(`[bridge] pong timeout, terminating connection (${label})`);
      ws.terminate(); // Hard close — triggers 'close' event
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

  ws.on("pong", () => {
    if (ping.pongTimer) {
      clearTimeout(ping.pongTimer);
      ping.pongTimer = null;
    }
  });
}

function stopPingPong(ping: PingPongState): void {
  if (ping.pingTimer) {
    clearInterval(ping.pingTimer);
    ping.pingTimer = null;
  }
  if (ping.pongTimer) {
    clearTimeout(ping.pongTimer);
    ping.pongTimer = null;
  }
}

// --- WebSocket server ---

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[bridge] WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[bridge] Port ${PORT} is already in use. Is another bridge running?\n` +
        `  Kill it:  lsof -ti :${PORT} | xargs kill\n` +
        `  Or use:   BRIDGE_PORT=3002 npm run bridge`
    );
    process.exit(1);
  }
  throw err;
});

/** Attach a WebSocket to a session, clearing any idle timer. */
function attachWsToSession(ws: WebSocket, session: Session): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  // Replay history BEFORE adding to clients — synchronous within one event-loop
  // tick, so no readline callback can interleave live events with replay.
  if (session.messageBuffer.length > 0) {
    sendToClient(ws, { source: "bridge", type: "historyStart" });
    for (const serialized of session.messageBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(serialized);
    }
    sendToClient(ws, { source: "bridge", type: "historyEnd" });
  }
  session.clients.add(ws);
}

/** Handle messages on a session-mode connection. */
async function handleSessionMessage(
  ws: WebSocket,
  session: Session,
  msg: ClientMessage,
): Promise<void> {
  switch (msg.type) {
    case "prompt": {
      // Lazy spawn: start CC process on first prompt (or respawn if dead)
      const needsResume = session.process === null && session.resumable;
      if (!ensureProcess(session, needsResume)) return;

      // Write prompt to CC stdin
      const envelope = JSON.stringify({
        type: "user",
        message: { role: "user", content: msg.text },
      });
      if (writeToStdin(session, envelope + "\n")) {
        sendToClient(ws, { source: "bridge", type: "promptReceived" });
      }
      break;
    }

    case "abort": {
      if (session.process) {
        console.log(`[bridge] aborting CC session=${session.id}`);
        killWithEscalation(session.process, session.id);
      }
      break;
    }

    case "listFolders": {
      // Allow folder listing even in session mode — read-only, needed for
      // the folder picker to show accurate state (active dots, timestamps)
      const folders = await scanFolders(getActiveProcesses());
      sendToClient(ws, { source: "bridge", type: "folderList", folders });
      break;
    }

    case "connectFolder":
      sendToClient(ws, {
        source: "bridge",
        type: "error",
        error: `Cannot connectFolder on an active session`,
      });
      break;

    default:
      sendToClient(ws, {
        source: "bridge",
        type: "error",
        error: `Unknown message type: ${(msg as any).type}`,
      });
  }
}

/** Handle messages on a lobby-mode connection. */
async function handleLobbyMessage(
  ws: WebSocket,
  conn: Connection,
  msg: ClientMessage,
): Promise<void> {
  switch (msg.type) {
    case "listFolders": {
      const folders = await scanFolders(getActiveProcesses());
      sendToClient(ws, { source: "bridge", type: "folderList", folders });
      break;
    }

    case "connectFolder": {
      const folderPath = msg.path;
      if (!folderPath) {
        sendToClient(ws, {
          source: "bridge",
          type: "error",
          error: "connectFolder requires a path",
        });
        return;
      }

      if (!validateFolderPath(folderPath, SCAN_ROOT)) {
        sendToClient(ws, {
          source: "bridge",
          type: "error",
          error: "Folder path must be within scan root",
        });
        return;
      }

      // Find existing bridge session for this folder (multi-WS reconnect)
      let existingBridgeSession: { id: string; resumable: boolean } | null = null;
      for (const s of sessions.values()) {
        if (s.folder === folderPath) {
          existingBridgeSession = { id: s.id, resumable: s.resumable };
          break;
        }
      }

      // Resolve: reconnect, resume, or fresh?
      const latestSession = await getLatestSession(folderPath);
      const handoff = await getLatestHandoff(folderPath);
      const resolution = resolveSessionForFolder(
        existingBridgeSession,
        latestSession,
        !!handoff,
        randomUUID,
      );

      let session: Session;
      if (resolution.isReconnect) {
        session = [...sessions.values()].find(s => s.folder === folderPath)!;
        attachWsToSession(ws, session);
      } else {
        session = {
          id: resolution.sessionId,
          folder: folderPath,
          resumable: resolution.resumable,
          process: null,
          clients: new Set([ws]),
          idleTimer: null,
          messageBuffer: [],
          stderrBuffer: [],
          spawnedAt: null,
        };
        sessions.set(resolution.sessionId, session);
      }

      // Transition: lobby → session (no listener surgery — dispatcher reads mode)
      conn.state = { mode: "session", session };

      console.log(
        `[bridge] connectFolder folder=${folderPath} session=${session.id} resumable=${session.resumable}`
      );

      sendToClient(ws, {
        source: "bridge",
        type: "connected",
        sessionId: session.id,
        resumed: session.resumable,
      });
      break;
    }

    case "prompt":
    case "abort":
      sendToClient(ws, {
        source: "bridge",
        type: "error",
        error: `Cannot ${msg.type} in lobby — send connectFolder first`,
      });
      break;

    default:
      sendToClient(ws, {
        source: "bridge",
        type: "error",
        error: `Unknown message type: ${(msg as any).type}`,
      });
  }
}

// --- Connection handler ---

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const requestedSessionId = url.searchParams.get("session");

  // Every connection gets its own ping/pong state and a single set of handlers.
  const ping: PingPongState = { pingTimer: null, pongTimer: null };
  const conn: Connection = { ping, state: { mode: "lobby" } };
  connections.set(ws, conn);
  startPingPong(ws, ping);

  if (requestedSessionId) {
    // --- Legacy ?session= path (backwards compat) ---
    let session: Session;

    if (sessions.has(requestedSessionId)) {
      session = sessions.get(requestedSessionId)!;
      attachWsToSession(ws, session);
    } else {
      // Client provided ID implies existing CC session
      session = {
        id: requestedSessionId,
        folder: null,
        resumable: true,
        process: null,
        clients: new Set([ws]),
        idleTimer: null,
        stderrBuffer: [],
        spawnedAt: null,
      };
      sessions.set(requestedSessionId, session);
    }

    conn.state = { mode: "session", session };

    sendToClient(ws, {
      source: "bridge",
      type: "connected",
      sessionId: session.id,
      resumed: session.resumable,
    });

    console.log(
      `[bridge] client connected session=${session.id} (legacy ?session= path)`
    );
  } else {
    // --- Lobby mode ---
    sendToClient(ws, { source: "bridge", type: "lobbyConnected" });
    console.log("[bridge] client connected (lobby mode)");
  }

  // Single message handler — dispatches based on current mode.
  // Lobby messages are async (scanFolders, getLatestSession) so we chain them
  // to prevent interleaving. Session messages are sync — no queue needed.
  let lobbyQueue = Promise.resolve();

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendToClient(ws, {
        source: "bridge",
        type: "error",
        error: "Invalid JSON from client",
      });
      return;
    }

    if (conn.state.mode === "session") {
      handleSessionMessage(ws, conn.state.session, msg).catch((err) =>
        console.error(`[bridge] session message error:`, err),
      );
    } else {
      lobbyQueue = lobbyQueue.then(() => handleLobbyMessage(ws, conn, msg));
    }
  });

  // Single close handler — cleans up based on current mode.
  ws.on("close", (code) => {
    connections.delete(ws);
    stopPingPong(ping);

    if (conn.state.mode === "session") {
      const session = conn.state.session;
      session.clients.delete(ws);

      if (session.clients.size === 0) {
        console.log(
          `[bridge] last client disconnected session=${session.id} code=${code}`
        );
        session.idleTimer = setTimeout(() => {
          console.log(
            `[bridge] idle timeout, killing CC session=${session.id}`
          );
          if (session.process) {
            killWithEscalation(session.process, session.id);
          }
          sessions.delete(session.id);
        }, IDLE_TIMEOUT_MS);
      } else {
        console.log(
          `[bridge] client disconnected session=${session.id} code=${code} (${session.clients.size} remaining)`
        );
      }
    } else {
      console.log(`[bridge] lobby client disconnected code=${code}`);
    }
  });

  ws.on("error", (err) => {
    const label =
      conn.state.mode === "session"
        ? `session=${conn.state.session.id}`
        : "lobby";
    console.error(`[bridge] WS error (${label}):`, err);
  });
});

// --- Graceful shutdown ---

function shutdown() {
  console.log("[bridge] shutting down...");

  // Close all WebSocket connections and stop their ping/pong
  for (const [ws, conn] of connections) {
    stopPingPong(conn.ping);
    ws.close(1000, "Server shutting down");
  }
  connections.clear();

  // Kill all CC processes and clear idle timers
  for (const [id, session] of sessions) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.process) killWithEscalation(session.process, id);
  }
  sessions.clear();

  wss.close(() => {
    console.log("[bridge] closed");
    process.exit(0);
  });
  // Force exit if graceful close takes too long
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
