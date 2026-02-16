import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { scanFolders, getLatestSession, getLatestHandoff, getSessionJSONLPath, hasExitMarker, writeExitMarker, FolderInfo, SCAN_ROOT } from "./folders.js";
import { generateFolderName } from "./fun-names.js";
import { getVapidPublicKey, addSubscription, removeSubscription, pushTurnComplete, pushAskUser } from "./push.js";
import {
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  KILL_ESCALATION_MS,
  EARLY_EXIT_MS,
  buildCCArgs,
  getActiveSessions as getActiveSessionsFromSessions,
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
  isExitCommand,
  type IdleSessionState,
  type PendingDelta,
} from "./bridge-logic.js";

// --- Configuration ---

const PORT = parseInt(process.env.BRIDGE_PORT || "3001", 10);

// --- Protocol types ---

// Browser → Bridge
interface ClientPrompt {
  type: "prompt";
  text?: string;
  content?: Array<{ type: string; [key: string]: unknown }>;
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
interface ClientCreateFolder {
  type: "createFolder";
}
interface ClientDeleteFolder {
  type: "deleteFolder";
  path: string;
}
interface ClientPushSubscribe {
  type: "pushSubscribe";
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}
interface ClientPushUnsubscribe {
  type: "pushUnsubscribe";
  endpoint: string;
}
type ClientMessage =
  | ClientPrompt
  | ClientAbort
  | ClientListFolders
  | ClientConnectFolder
  | ClientCreateFolder
  | ClientDeleteFolder
  | ClientPushSubscribe
  | ClientPushUnsubscribe;

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
interface BridgePromptQueued {
  source: "bridge";
  type: "promptQueued";
  position: number; // 1-based position in queue
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
  vapidPublicKey: string | null;
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
interface BridgeFolderCreated {
  source: "bridge";
  type: "folderCreated";
  folder: FolderInfo;
}
interface BridgeCCEvent {
  source: "cc";
  event: Record<string, unknown>;
}
interface BridgeSessionClosed {
  source: "bridge";
  type: "sessionClosed";
  deliberate: boolean;
}
interface BridgeFolderDeleted {
  source: "bridge";
  type: "folderDeleted";
  path: string;
}
interface BridgePushSubscribed {
  source: "bridge";
  type: "pushSubscribed";
}
type ServerMessage =
  | BridgeConnected
  | BridgePromptReceived
  | BridgePromptQueued
  | BridgeError
  | BridgeProcessExit
  | BridgeLobbyConnected
  | BridgeFolderList
  | BridgeFolderCreated
  | BridgeHistoryStart
  | BridgeHistoryEnd
  | BridgeCCEvent
  | BridgeSessionClosed
  | BridgeFolderDeleted
  | BridgePushSubscribed;

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
  // Message queueing: prompts sent while CC is mid-turn
  promptQueue: ClientPrompt[];
}

const sessions = new Map<string, Session>();

// --- Session persistence (survives bridge restart) ---
// Persists session→folder+PID mapping so the bridge can reap orphaned CC
// processes on startup. Without this, a bridge restart leaves CC processes
// running and the new bridge might spawn duplicates for the same session.

const SESSION_FILE = join(homedir(), ".config", "gueridon", "sessions.json");

interface SessionRecord {
  sessionId: string;
  folder: string;
  pid: number;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write of active sessions to disk. */
function persistSessions(): void {
  if (persistTimer) return; // already scheduled
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const records: SessionRecord[] = [];
    for (const s of sessions.values()) {
      if (s.process?.pid) {
        records.push({ sessionId: s.id, folder: s.folder, pid: s.process.pid });
      }
    }
    try {
      mkdirSync(join(homedir(), ".config", "gueridon"), { recursive: true });
      await writeFile(SESSION_FILE, JSON.stringify(records, null, 2), "utf-8");
    } catch (err) {
      console.error("[bridge] failed to persist sessions:", err);
    }
  }, 500);
}

/**
 * Reap orphaned CC processes from a previous bridge instance.
 * Called once at startup, before the server starts accepting connections.
 * Sends SIGTERM to any CC processes we previously spawned that are still alive.
 * They'll flush their state; the next connectFolder will --resume cleanly.
 */
function reapOrphans(): void {
  if (!existsSync(SESSION_FILE)) return;

  let records: SessionRecord[];
  try {
    records = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return; // corrupt or empty file
  }

  let reaped = 0;
  for (const rec of records) {
    try {
      // Signal 0 = check if alive without killing
      process.kill(rec.pid, 0);
      // Still alive — send SIGTERM so it exits cleanly
      console.log(
        `[bridge] reaping orphan CC pid=${rec.pid} session=${rec.sessionId.slice(0, 8)} folder=${basename(rec.folder)}`
      );
      process.kill(rec.pid, "SIGTERM");
      reaped++;
    } catch {
      // Process already dead — normal after a crash
    }
  }

  // Clean up the file — we've handled all orphans
  try {
    unlinkSync(SESSION_FILE);
  } catch { /* ignore */ }

  if (reaped > 0) {
    console.log(`[bridge] reaped ${reaped} orphaned CC process(es)`);
  }
}

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
function getActiveSessions(): Map<string, import("./bridge-logic.js").ActiveSessionInfo> {
  const infos = new Map<string, import("./bridge-logic.js").SessionProcessInfo>();
  for (const [id, s] of sessions) {
    infos.set(id, {
      folder: s.folder,
      process: s.process,
      turnInProgress: s.turnInProgress,
      clientCount: s.clients.size,
    });
  }
  return getActiveSessionsFromSessions(infos);
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

/**
 * Destroy a session: flush deltas, cancel idle, kill process, remove from map.
 * Does NOT notify clients — caller handles that (different messages for
 * different contexts: sessionClosed for /exit, nothing for idle kill).
 */
function destroySession(session: Session): void {
  // Transition all connected clients back to lobby mode.
  // Prevents zombie: conn.state referencing a dead session would let
  // a late-arriving message spawn a new CC process for a /exit'd session.
  for (const client of session.clients) {
    const c = connections.get(client);
    if (c) c.state = { mode: "lobby" };
  }
  cancelIdleCheck(session);
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  session.pendingDeltas.clear();
  if (session.process) {
    killWithEscalation(session.process, session.id);
  }
  sessions.delete(session.id);
  persistSessions();
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
      destroySession(session);
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

/**
 * Deliver a prompt to CC stdin — handles lazy spawn, buffering, and broadcast.
 * Used for both immediate sends and queue flushes.
 */
function deliverPrompt(ws: WebSocket | null, session: Session, msg: ClientPrompt): void {
  // Lazy spawn: start CC process on first prompt (or respawn if dead)
  const needsResume = session.process === null && session.resumable;
  if (!ensureProcess(session, needsResume)) return;

  // Buffer the user message for replay BEFORE writing to stdin.
  const ccContent = msg.content ?? msg.text;
  const userEvent = JSON.stringify({
    source: "cc",
    event: { type: "user", message: { role: "user", content: ccContent } },
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
    message: { role: "user", content: ccContent },
  });
  if (writeToStdin(session, envelope + "\n")) {
    session.turnInProgress = true;
    if (ws) sendToClient(ws, { source: "bridge", type: "promptReceived" });
  }
}

/** Flush the next queued prompt after a turn completes. */
function flushPromptQueue(session: Session): void {
  const next = session.promptQueue.shift();
  if (!next) return;
  console.log(`[bridge] flushing queued prompt session=${session.id} (${session.promptQueue.length} remaining)`);
  // ws=null: queued prompt has no specific originator — ack was already sent as promptQueued
  deliverPrompt(null, session, next);
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
        // Flush next queued prompt (if any) now that CC is idle
        flushPromptQueue(session);
        // Push notification if no clients connected (phone-in-pocket)
        if (session.clients.size === 0) {
          pushTurnComplete(session.folder).catch(() => {});
        }
      }

      // Detect AskUserQuestion tool use — Claude needs input
      if (event.type === "content_block_start" &&
          event.content_block?.type === "tool_use" &&
          event.content_block?.name === "AskUserQuestion" &&
          session.clients.size === 0) {
        pushAskUser(session.folder).catch(() => {});
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
    persistSessions();
    // Discard queued prompts — CC is dead, context is gone.
    // User will see the processExit banner and can re-send.
    if (session.promptQueue.length > 0) {
      console.log(`[bridge] discarding ${session.promptQueue.length} queued prompt(s) after process exit`);
      session.promptQueue = [];
    }
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
    session.turnInProgress = false;
    session.promptQueue = [];
    persistSessions();
  });
}

/** Ensure CC process is running for this session, spawning if needed. Returns true if ready. */
function ensureProcess(session: Session, resume: boolean): boolean {
  if (session.process && session.process.exitCode === null) return true;

  try {
    session.process = spawnCC(session.id, resume, session.folder);
    wireProcessToSession(session);
    persistSessions();
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

(function checkDistBuild() {
  try {
    let versionJson: { short?: string; time?: string } | null = null;
    try {
      versionJson = JSON.parse(readFileSync(join(DIST_DIR, "version.json"), "utf-8"));
    } catch {
      console.log("[bridge] ⚠ No dist/version.json — run 'npm run build'");
    }

    try {
      const assets = readdirSync(join(DIST_DIR, "assets"));
      const indexBundle = assets.find((f) => f.startsWith("index-") && f.endsWith(".js"));
      if (indexBundle) {
        const content = readFileSync(join(DIST_DIR, "assets", indexBundle), "utf-8");
        if (content.includes("location.hostname}:3001")) {
          console.log("[bridge] ⚠ dist/ was built in dev mode — WS URL points to :3001. Rebuild with 'npm run build'");
        }
      }
    } catch {}

    if (versionJson) {
      console.log(`[bridge] serving dist/ built from ${versionJson.short} at ${versionJson.time}`);
    }
  } catch {}
})();

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/version") {
    try {
      const data = readFileSync(join(DIST_DIR, "version.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
    return;
  }

  const resolved = resolveStaticFile(pathname, DIST_DIR);

  if (!resolved.ok) {
    res.writeHead(resolved.status).end(resolved.status === 403 ? "" : "Not found");
    return;
  }

  try {
    const data = await readFile(resolved.filePath);
    if (resolved.cache) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    } else {
      // index.html must not be cached — stale HTML references old asset hashes
      res.setHeader("Cache-Control", "no-cache");
    }
    res.writeHead(200, { "Content-Type": resolved.mime }).end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// --- HTTP + WebSocket server ---

reapOrphans();

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

/** Create a new folder with a fun name, git init it, return FolderInfo. */
async function handleCreateFolder(ws: WebSocket): Promise<void> {
  try {
    const name = await generateFolderName(SCAN_ROOT);
    const folderPath = join(SCAN_ROOT, name);
    await mkdir(folderPath, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init"], { cwd: folderPath }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    console.log(`[bridge] created folder: ${folderPath}`);
    const folder: FolderInfo = {
      name,
      path: folderPath,
      state: "fresh",
      activity: null,
      sessionId: null,
      lastActive: null,
      handoffPurpose: null,
    };
    sendToClient(ws, { source: "bridge", type: "folderCreated", folder });
  } catch (err) {
    console.error(`[bridge] createFolder failed:`, err);
    sendToClient(ws, {
      source: "bridge",
      type: "error",
      error: `Failed to create folder: ${err}`,
    });
  }
}

/** Delete a folder: destroy session, remove directory if it's under SCAN_ROOT. */
async function handleDeleteFolder(ws: WebSocket, folderPath: string): Promise<void> {
  if (!folderPath || !validateFolderPath(folderPath, SCAN_ROOT)) {
    sendToClient(ws, {
      source: "bridge",
      type: "error",
      error: "Invalid folder path",
    });
    return;
  }

  // Destroy any active session for this folder
  for (const session of sessions.values()) {
    if (session.folder === folderPath) {
      // Notify connected clients before destroying
      broadcast(session, {
        source: "bridge",
        type: "sessionClosed",
        deliberate: true,
      });
      destroySession(session);
      break;
    }
  }

  // Delete the directory (recursive — removes CC session files too)
  try {
    await rm(folderPath, { recursive: true, force: true });
    console.log(`[bridge] deleted folder: ${folderPath}`);
  } catch (err) {
    console.error(`[bridge] deleteFolder failed:`, err);
    sendToClient(ws, {
      source: "bridge",
      type: "error",
      error: `Failed to delete folder: ${(err as Error).message}`,
    });
    return;
  }

  sendToClient(ws, { source: "bridge", type: "folderDeleted", path: folderPath });

  // Send updated folder list to all lobby clients
  const folders = await scanFolders(getActiveSessions());
  for (const [client, conn] of connections) {
    if (conn.state.mode === "lobby" && client.readyState === WebSocket.OPEN) {
      sendToClient(client, { source: "bridge", type: "folderList", folders });
    }
  }
}

/** Handle messages on a session-mode connection. */
async function handleSessionMessage(
  ws: WebSocket,
  session: Session,
  msg: ClientMessage,
): Promise<void> {
  switch (msg.type) {
    case "prompt": {
      // Intercept exit commands — CC doesn't handle these in -p mode
      // (content-array prompts with images have no text field)
      if (msg.text && isExitCommand(msg.text)) {
        console.log(`[bridge] exit command intercepted session=${session.id}`);
        broadcast(session, {
          source: "bridge",
          type: "sessionClosed",
          deliberate: true,
        });
        writeExitMarker(session.folder, session.id).catch((err) =>
          console.error(`[bridge] failed to write .exit marker:`, err),
        );
        destroySession(session);
        return;
      }

      // Queue if CC is mid-turn — flush when result event arrives
      if (session.turnInProgress) {
        session.promptQueue.push(msg);
        const pos = session.promptQueue.length;
        console.log(`[bridge] prompt queued (position ${pos}) session=${session.id}`);
        sendToClient(ws, { source: "bridge", type: "promptQueued", position: pos });
        break;
      }

      deliverPrompt(ws, session, msg);
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
      const folders = await scanFolders(getActiveSessions());
      sendToClient(ws, { source: "bridge", type: "folderList", folders });
      break;
    }

    case "createFolder": {
      await handleCreateFolder(ws);
      break;
    }

    case "deleteFolder": {
      await handleDeleteFolder(ws, msg.path);
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
      const folders = await scanFolders(getActiveSessions());
      sendToClient(ws, { source: "bridge", type: "folderList", folders });
      break;
    }

    case "createFolder": {
      await handleCreateFolder(ws);
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
      const exitMarker = latestSession ? await hasExitMarker(folderPath, latestSession.id) : false;
      const resolution = resolveSessionForFolder(
        existingSession ? { id: existingSession.id, resumable: existingSession.resumable } : null,
        latestSession,
        handoff?.sessionId ?? null,
        exitMarker,
        randomUUID,
      );

      const action = resolution.isReconnect ? "reconnect" : resolution.resumable ? "resume" : "fresh";
      console.log(`[bridge] session resolution for ${basename(folderPath)}: ${action} (id=${resolution.sessionId.slice(0, 8)}, handoff=${handoff?.sessionId?.slice(0, 8) ?? "none"}, latestSession=${latestSession?.id.slice(0, 8) ?? "none"}, exit=${exitMarker})`);

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
          promptQueue: [],
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

    case "deleteFolder": {
      await handleDeleteFolder(ws, msg.path);
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

  sendToClient(ws, { source: "bridge", type: "lobbyConnected", vapidPublicKey: getVapidPublicKey() });
  console.log("[bridge] client connected (lobby mode)");

  // Single message handler — dispatches based on current mode.
  // Both lobby and session messages use a queue chain to prevent interleaving.
  // Lobby: connectFolder is async (getLatestSession, resolveSession) and mutates state.
  // Session: listFolders is async (scanFolders). prompt/abort are sync but
  // queuing them is harmless and keeps error handling consistent.
  let lobbyQueue = Promise.resolve();
  let sessionQueue = Promise.resolve();

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

    // Push subscription management — works in any mode
    if (msg.type === "pushSubscribe") {
      addSubscription(msg.subscription);
      sendToClient(ws, { source: "bridge", type: "pushSubscribed" });
      return;
    }
    if (msg.type === "pushUnsubscribe") {
      removeSubscription(msg.endpoint);
      return;
    }

    if (conn.state.mode === "session") {
      // Capture session ref now — conn.state can change (e.g. destroySession
      // transitions to lobby) before the queued .then() callback fires.
      const session = conn.state.session;
      sessionQueue = sessionQueue
        .then(() => handleSessionMessage(ws, session, msg))
        .catch((err) => console.error(`[bridge] session message error:`, err));
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

  // Kill all CC processes and clear timers.
  // Snapshot first — destroySession mutates the map.
  const allSessions = [...sessions.values()];
  for (const session of allSessions) {
    destroySession(session);
  }

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
