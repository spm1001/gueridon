import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { readFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { scanFolders, getLatestSession, getLatestHandoff, getSessionJSONLPath, FolderInfo, SCAN_ROOT } from "./folders.js";
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
  parseSessionJSONL,
  resolveStaticFile,
  checkIdle,
  DEFAULT_IDLE_GUARDS,
  CONFLATION_INTERVAL_MS,
  MESSAGE_BUFFER_CAP,
  BACKPRESSURE_THRESHOLD,
  isStreamDelta,
  extractDeltaInfo,
  buildMergedDelta,
  isUserTextEcho,
  type IdleSessionState,
  type PendingDelta,
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
  folder: string; // Folder path — always set via connectFolder
  resumable: boolean; // True when CC has state for this session ID.
  // Used for both spawn strategy (--resume vs --session-id) and the `resumed`
  // field on the `connected` message to the client. These overlap today but are
  // conceptually distinct — if we need to distinguish "fresh WS to existing CC
  // session" from "WS reconnecting to active bridge session", split this field.
  process: ChildProcess | null;
  clients: Set<WebSocket>; // All browser tabs connected to this session
  messageBuffer: string[]; // Serialized CC events for replay on reconnect
  stderrBuffer: string[]; // Capture stderr for early-exit diagnostics
  spawnedAt: number | null; // Timestamp of last spawn, for early-exit detection
  // Idle guard state
  turnInProgress: boolean; // True between user prompt and result event
  lastOutputTime: number | null; // Updated on every parsed stdout line
  idleStart: number | null; // When last client disconnected (null = clients connected)
  idleCheckTimer: ReturnType<typeof setTimeout> | null; // Replaces old idleTimer
  guardWasDeferred: boolean; // For grace period detection
  // Conflation: batch content_block_delta events for fewer ws.send() calls
  pendingDeltas: Map<string, PendingDelta>; // Keyed by `${index}:${deltaType}`
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();

// --- Per-connection state ---
// Ping/pong is a connection concern (WS health), not a session concern (process lifecycle).

interface PingPongState {
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  pongHandler: (() => void) | null;
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

function spawnCC(sessionId: string, resume: boolean, cwd: string): ChildProcess {
  const args = buildCCArgs(sessionId, resume);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    cwd,
  });

  console.log(
    `[bridge] spawned CC pid=${proc.pid} session=${sessionId}${resume ? " (resume)" : ""} cwd=${cwd}`
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
  broadcastSerialized(session, JSON.stringify(msg), false);
}

/**
 * Send pre-serialized data to all connected clients.
 * When respectBackpressure is true, skips clients whose write buffer is saturated —
 * safe for delta events (client gets the next batch), unsafe for structural events.
 */
function broadcastSerialized(session: Session, data: string, respectBackpressure: boolean): void {
  for (const client of session.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (respectBackpressure && client.bufferedAmount >= BACKPRESSURE_THRESHOLD) continue;
    client.send(data);
  }
}

/**
 * Flush all pending content_block_delta events as merged deltas.
 * Called on timer tick (250ms) and before any non-delta event (to preserve ordering).
 */
function flushPendingDeltas(session: Session): void {
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }

  for (const pending of session.pendingDeltas.values()) {
    const merged = buildMergedDelta(pending);
    const serialized = JSON.stringify({ source: "cc", event: merged });
    broadcastSerialized(session, serialized, true);
    pushToBuffer(session, serialized);
  }
  session.pendingDeltas.clear();
}

/** Push to messageBuffer with cap to prevent unbounded memory on long sessions. */
function pushToBuffer(session: Session, serialized: string): void {
  session.messageBuffer.push(serialized);
  if (session.messageBuffer.length > MESSAGE_BUFFER_CAP) {
    // Drop oldest 10% to avoid doing this every push
    const dropCount = Math.floor(MESSAGE_BUFFER_CAP * 0.1);
    session.messageBuffer.splice(0, dropCount);
  }
}

// --- Idle check lifecycle ---

function startIdleCheck(session: Session): void {
  cancelIdleCheck(session);
  session.idleStart = Date.now();
  session.guardWasDeferred = false;
  scheduleIdleCheck(session, IDLE_TIMEOUT_MS);
}

function cancelIdleCheck(session: Session): void {
  if (session.idleCheckTimer) {
    clearTimeout(session.idleCheckTimer);
    session.idleCheckTimer = null;
  }
  session.idleStart = null;
  session.guardWasDeferred = false;
}

function scheduleIdleCheck(session: Session, delayMs: number): void {
  session.idleCheckTimer = setTimeout(() => {
    if (session.idleStart === null) return; // client reconnected — cancelled

    const state: IdleSessionState = {
      turnInProgress: session.turnInProgress,
      lastOutputTime: session.lastOutputTime,
    };

    const action = checkIdle(
      session.idleStart,
      session.guardWasDeferred,
      DEFAULT_IDLE_GUARDS,
      state,
    );

    if (action.action === "kill") {
      console.log(
        `[bridge] idle check: killing CC session=${session.id} (${action.reason})`,
      );
      // Clean up conflation timer before killing
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
        session.flushTimer = null;
      }
      session.pendingDeltas.clear();
      if (session.process) {
        killWithEscalation(session.process, session.id);
      }
      sessions.delete(session.id);
    } else {
      console.log(`[bridge] idle check: session=${session.id} — ${action.reason}`);
      session.guardWasDeferred = action.guardDeferred;
      scheduleIdleCheck(session, action.delayMs);
    }
  }, delayMs);
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
      // Track output time for idle guard staleness detection
      session.lastOutputTime = Date.now();
      // Detect turn completion: result event means CC finished its turn
      if (event.type === "result") {
        session.turnInProgress = false;
      }

      // Conflation: content_block_delta events are merged and flushed on a timer.
      // Everything else flushes pending deltas first (ordering) then sends immediately.
      const deltaInfo = extractDeltaInfo(event);
      if (deltaInfo) {
        const existing = session.pendingDeltas.get(deltaInfo.key);
        if (existing) {
          existing.accumulated += deltaInfo.payload;
        } else {
          session.pendingDeltas.set(deltaInfo.key, {
            index: deltaInfo.index,
            deltaType: deltaInfo.deltaType,
            field: deltaInfo.field,
            accumulated: deltaInfo.payload,
          });
        }
        if (!session.flushTimer) {
          session.flushTimer = setTimeout(() => flushPendingDeltas(session), CONFLATION_INTERVAL_MS);
        }
      } else {
        // Non-delta: flush pending deltas first to preserve event ordering
        flushPendingDeltas(session);
        const serialized = JSON.stringify({ source: "cc", event });
        broadcastSerialized(session, serialized, false);
        // Skip CC user text echoes from buffer — bridge already injected user
        // messages when receiving the prompt (handleSessionMessage). CC echoes
        // (from --replay-user-messages) are redundant in the buffer and would
        // cause duplicate user messages during replay. Tool results (array
        // content) are NOT echoes — they're CC's own output and must be buffered.
        if (!isUserTextEcho(event)) {
          pushToBuffer(session, serialized);
        }
      }
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

    // Flush any buffered deltas before exit events — clients see the last chunk
    flushPendingDeltas(session);

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
    session.turnInProgress = false;
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
    session.process = spawnCC(session.id, resume, session.folder);
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
  stopPingPong(ws, ping);

  ping.pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stopPingPong(ws, ping);
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

  const pongHandler = () => {
    if (ping.pongTimer) {
      clearTimeout(ping.pongTimer);
      ping.pongTimer = null;
    }
  };
  ping.pongHandler = pongHandler;
  ws.on("pong", pongHandler);
}

function stopPingPong(ws: WebSocket, ping: PingPongState): void {
  if (ping.pingTimer) {
    clearInterval(ping.pingTimer);
    ping.pingTimer = null;
  }
  if (ping.pongTimer) {
    clearTimeout(ping.pongTimer);
    ping.pongTimer = null;
  }
  if (ping.pongHandler) {
    ws.removeListener("pong", ping.pongHandler);
    ping.pongHandler = null;
  }
}

// --- Static file serving ---

const DIST_DIR = join(import.meta.dirname, "..", "dist");

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const resolved = resolveStaticFile(pathname, DIST_DIR);

  if (!resolved.ok) {
    res.writeHead(resolved.status).end(resolved.status === 403 ? "" : "Not found");
    return;
  }

  try {
    const data = await readFile(resolved.filePath);
    if (resolved.cache) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
    res.writeHead(200, { "Content-Type": resolved.mime }).end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// --- HTTP + WebSocket server ---

const httpServer = createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[bridge] HTTP + WebSocket server listening on http://localhost:${PORT}`);
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
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

/** Attach a WebSocket to a session, cancelling any idle check. */
function attachWsToSession(ws: WebSocket, session: Session): void {
  cancelIdleCheck(session);
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

      // Buffer the user message for replay BEFORE writing to stdin.
      // This ensures user messages appear in the replay buffer at the correct
      // position (before the assistant's response), regardless of when CC's
      // --replay-user-messages echo arrives on stdout.
      const userEvent = JSON.stringify({
        source: "cc",
        event: { type: "user", message: { role: "user", content: msg.text } },
      });
      pushToBuffer(session, userEvent);
      // Broadcast to other tabs so they see the user message immediately
      for (const client of session.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(userEvent);
        }
      }

      // Write prompt to CC stdin
      const envelope = JSON.stringify({
        type: "user",
        message: { role: "user", content: msg.text },
      });
      if (writeToStdin(session, envelope + "\n")) {
        session.turnInProgress = true;
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
      let existingSession: Session | null = null;
      for (const s of sessions.values()) {
        if (s.folder === folderPath) {
          existingSession = s;
          break;
        }
      }

      // Resolve: reconnect, resume, or fresh?
      const latestSession = await getLatestSession(folderPath);
      const handoff = await getLatestHandoff(folderPath);
      const resolution = resolveSessionForFolder(
        existingSession ? { id: existingSession.id, resumable: existingSession.resumable } : null,
        latestSession,
        !!handoff,
        randomUUID,
      );

      let session: Session;
      if (resolution.isReconnect) {
        session = existingSession!;
        attachWsToSession(ws, session);
      } else {
        session = {
          id: resolution.sessionId,
          folder: folderPath,
          resumable: resolution.resumable,
          process: null,
          clients: new Set(),
          messageBuffer: [],
          stderrBuffer: [],
          spawnedAt: null,
          turnInProgress: false,
          lastOutputTime: null,
          idleStart: null,
          idleCheckTimer: null,
          guardWasDeferred: false,
          pendingDeltas: new Map(),
          flushTimer: null,
        };

        // Pre-populate message buffer from JSONL for paused sessions
        // so the existing replay mechanism shows conversation history
        if (resolution.resumable) {
          try {
            const jsonlPath = getSessionJSONLPath(folderPath, resolution.sessionId);
            const jsonlContent = await readFile(jsonlPath, "utf-8");
            session.messageBuffer = parseSessionJSONL(jsonlContent);
            console.log(
              `[bridge] loaded ${session.messageBuffer.length} events from JSONL for session=${resolution.sessionId}`,
            );
          } catch {
            // No JSONL file or read error — not fatal, just no history
          }
        }

        sessions.set(resolution.sessionId, session);
        // Attach after buffer is populated so attachWsToSession replays history
        attachWsToSession(ws, session);
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

wss.on("connection", (ws: WebSocket) => {
  // Every connection gets its own ping/pong state and a single set of handlers.
  // All connections start in lobby mode — client sends connectFolder to join a session.
  const ping: PingPongState = { pingTimer: null, pongTimer: null, pongHandler: null };
  const conn: Connection = { ping, state: { mode: "lobby" } };
  connections.set(ws, conn);
  startPingPong(ws, ping);

  sendToClient(ws, { source: "bridge", type: "lobbyConnected" });
  console.log("[bridge] client connected (lobby mode)");

  // Single message handler — dispatches based on current mode.
  // Lobby messages are async (scanFolders, getLatestSession) so we chain them
  // to prevent interleaving. Session messages are mostly sync (prompt writes to
  // stdin, abort kills process) but listFolders is async — safe because read-only.
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
      lobbyQueue = lobbyQueue
        .then(() => handleLobbyMessage(ws, conn, msg))
        .catch((err) => console.error(`[bridge] lobby message error:`, err));
    }
  });

  // Single close handler — cleans up based on current mode.
  ws.on("close", (code) => {
    connections.delete(ws);
    stopPingPong(ws, ping);

    if (conn.state.mode === "session") {
      const session = conn.state.session;
      session.clients.delete(ws);

      if (session.clients.size === 0) {
        console.log(
          `[bridge] last client disconnected session=${session.id} code=${code}`
        );
        startIdleCheck(session);
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
    stopPingPong(ws, conn.ping);
    ws.close(1000, "Server shutting down");
  }
  connections.clear();

  // Kill all CC processes and clear timers
  for (const [id, session] of sessions) {
    cancelIdleCheck(session);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    session.pendingDeltas.clear();
    if (session.process) killWithEscalation(session.process, id);
  }
  sessions.clear();

  wss.close();
  httpServer.close(() => {
    console.log("[bridge] closed");
    process.exit(0);
  });
  // Force exit if graceful close takes too long
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
