/**
 * Guéridon bridge — SSE + POST HTTP server serving the BB frontend.
 *
 * Static files: GET / (index.html), /sw.js, /manifest.json, /icon-*.svg
 * SSE stream:   GET /events
 * Commands:     POST /session/:folder, /prompt/:folder, /abort/:folder, /exit/:folder
 * Queries:      GET /folders
 * Push:         POST /push/subscribe, /push/unsubscribe
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  buildCCArgs,
  KILL_ESCALATION_MS,
  CONFLATION_INTERVAL_MS,
  isUserTextEcho,
  isStreamDelta,
  extractDeltaInfo,
  buildMergedDelta,
  extractLocalCommandOutput,
  validateFolderPath,
  parseSessionJSONL,
  getActiveSessions,
  resolveSessionForFolder,
  type PendingDelta,
  type SessionProcessInfo,
} from "./bridge-logic.js";

import {
  scanFolders,
  getLatestSession,
  getLatestHandoff,
  hasExitMarker,
  writeExitMarker,
  getSessionJSONLPath,
  SCAN_ROOT,
} from "./folders.js";

import { StateBuilder } from "./state-builder.js";
import { getVapidPublicKey, pushTurnComplete, pushAskUser, addSubscription, removeSubscription } from "./push.js";
import { emit } from "./event-bus.js";
import { initLogger } from "./logger.js";
import { initStatusBuffer, getRecent } from "./status-buffer.js";

// -- Types --

/**
 * SSE Reconnect Contract
 *
 * EventSource auto-reconnects on transport failure. The bridge treats each
 * GET /events as a fresh connection (lobby mode, no session). The client
 * must restore session binding after reconnect:
 *
 * 1. Client opens EventSource with stable clientId: /events?clientId=X
 * 2. Bridge sends: hello (with clientId echo) → folders
 * 3. Client re-POSTs /session/:folder (from location.hash or JS state)
 * 4. Bridge sends: full state snapshot for that session
 * 5. Client is caught up — no gap, no replay needed
 *
 * Stale delta protection:
 * - Every broadcast event carries `session: folderName`
 * - Client MUST discard events where session !== current folder
 * - Session switch: old deltas may be in-flight; session field is the guard
 *
 * Manual reconnect fallback:
 * - If no events (including pings) for 60s, client should tear down
 *   EventSource and create a new one. Pings fire every 30s, so 60s
 *   silence means the connection is dead but TCP hasn't noticed.
 */

interface SSEClient {
  res: ServerResponse;
  folder: string | null; // null = lobby mode
  eventSeq: number;      // monotonic event counter for Last-Event-ID
}

interface Session {
  id: string;
  folder: string;
  folderName: string;
  stateBuilder: StateBuilder;
  process: ChildProcess | null;
  clients: Set<SSEClient>;
  resumable: boolean;
  stderrBuffer: string[];
  spawnedAt: number | null;
  turnInProgress: boolean;
  hadContentThisTurn: boolean;
  lastOutputTime: number | null;
  promptQueue: { text?: string; content?: unknown[] }[];
  lastPromptAt: number | null;
  pendingDeltas: Map<string, PendingDelta>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  initTimer: ReturnType<typeof setTimeout> | null;
  contextPct: number | null;
  turnStartedAt: number | null;
}

// -- State --

const sessions = new Map<string, Session>();       // keyed by folder path
const allClients = new Set<SSEClient>();
const clientsById = new Map<string, SSEClient>();

const PORT = parseInt(process.env.BRIDGE_PORT || "3001", 10);
const GRACE_MS = parseInt(process.env.GRACE_MS || "300000", 10);
const INIT_TIMEOUT_MS = 30_000;
let clientErrorTimestamps: number[] = [];

// -- Orphan reaping --

const SESSION_FILE = join(homedir(), ".config", "gueridon", "sse-sessions.json");

interface SessionRecord {
  sessionId: string;
  folder: string;
  pid: number;
  spawnedAt: number;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write of active sessions to disk. */
function persistSessions(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const records: SessionRecord[] = [];
    for (const s of sessions.values()) {
      if (s.process?.pid) {
        records.push({
          sessionId: s.id,
          folder: s.folder,
          pid: s.process.pid,
          spawnedAt: s.spawnedAt ?? Date.now(),
        });
      }
    }
    try {
      mkdirSync(join(homedir(), ".config", "gueridon"), { recursive: true });
      await writeFile(SESSION_FILE, JSON.stringify(records, null, 2), "utf-8");
    } catch (err) {
      emit({ type: "server:persist-error", error: String(err) });
    }
  }, 500);
}

/** Reap orphaned CC processes from a previous bridge instance. */
function reapOrphans(): void {
  if (!existsSync(SESSION_FILE)) return;

  let records: SessionRecord[];
  try {
    records = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return;
  }

  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  let reaped = 0;
  for (const rec of records) {
    if (rec.spawnedAt && Date.now() - rec.spawnedAt > MAX_AGE_MS) {
      emit({ type: "orphan:skip", pid: rec.pid, folder: basename(rec.folder), ageHours: Math.round((Date.now() - rec.spawnedAt) / 3600000) });
      continue;
    }
    try {
      process.kill(rec.pid, 0); // check alive
      emit({ type: "orphan:reap", pid: rec.pid, folder: basename(rec.folder), sessionId: rec.sessionId });
      process.kill(rec.pid, "SIGTERM");
      reaped++;
    } catch {
      // already dead
    }
  }

  try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }
  if (reaped > 0) {
    emit({ type: "orphan:summary", reaped });
  }
}

// -- SSE helpers --

function sendSSE(client: SSEClient, event: string, data: unknown): boolean {
  try {
    client.eventSeq++;
    return client.res.write(
      `id: ${client.eventSeq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  } catch {
    cleanupClient(client);
    return false;
  }
}

function cleanupClient(client: SSEClient): void {
  allClients.delete(client);
  // Remove from clientsById (iterate — no reverse map)
  for (const [id, c] of clientsById) {
    if (c === client) { clientsById.delete(id); break; }
  }
  if (client.folder) detachFromSession(client);
}

function broadcastToSession(session: Session, event: string, data: unknown): void {
  const payload = { folder: session.folderName, ...(data as Record<string, unknown>) };
  for (const client of session.clients) {
    sendSSE(client, event, payload);
  }
}

// -- SSE connection --

function setupSSE(req: IncomingMessage, res: ServerResponse, clientId: string): SSEClient {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.socket?.setKeepAlive(true, 10_000);

  // Last-Event-ID: sent by EventSource on auto-reconnect (SSE spec)
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  const reconnect = !!lastEventId;

  const client: SSEClient = { res, folder: null, eventSeq: 0 };
  allClients.add(client);
  clientsById.set(clientId, client);
  emit({ type: "sse:connect", clientId });

  const vapidPublicKey = getVapidPublicKey();
  sendSSE(client, "hello", { version: 1, clientId, reconnect, ...(vapidPublicKey ? { vapidPublicKey } : {}) });

  // Send folders asynchronously
  scanFolders(buildActiveSessionsMap()).then((folders) =>
    sendSSE(client, "folders", { folders }),
  );

  res.on("close", () => {
    emit({ type: "sse:disconnect", clientId, folder: client.folder });
    allClients.delete(client);
    clientsById.delete(clientId);
    if (client.folder) detachFromSession(client);
  });

  return client;
}

// -- Session attach/detach --

function attachToSession(client: SSEClient, session: Session): void {
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  client.folder = session.folder;
  session.clients.add(client);
}

function detachFromSession(client: SSEClient): void {
  const session = sessions.get(client.folder!);
  if (!session) return;
  session.clients.delete(client);
  client.folder = null;

  maybeStartGraceTimer(session);
}

/** Start grace timer only when idle with no audience and no recent prompt activity. */
function maybeStartGraceTimer(session: Session): void {
  if (session.clients.size === 0 && session.process && !session.turnInProgress) {
    // Don't start grace if a prompt arrived recently — the user is active,
    // just momentarily disconnected (iOS SSE drops during screen lock).
    const PROMPT_RECENCY_MS = 10 * 60 * 1000; // 10 minutes
    if (session.lastPromptAt && (Date.now() - session.lastPromptAt) < PROMPT_RECENCY_MS) {
      return;
    }
    startGraceTimer(session);
  }
}

function startGraceTimer(session: Session): void {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  emit({ type: "grace:start", folder: session.folderName, sessionId: session.id, graceMs: GRACE_MS });
  session.graceTimer = setTimeout(() => {
    emit({ type: "grace:expire", folder: session.folderName, sessionId: session.id });
    if (session.process) {
      killWithEscalation(session.process);
    }
    sessions.delete(session.folder);
  }, GRACE_MS);
}

// -- Active sessions map for folder scanner --

function buildActiveSessionsMap(): Map<string, { sessionId: string; activity: "working" | "waiting"; contextPct: number | null }> {
  const infos = new Map<string, SessionProcessInfo>();
  for (const [folder, session] of sessions) {
    infos.set(session.id, {
      folder,
      process: session.process ? { exitCode: session.process.exitCode } : null,
      turnInProgress: session.turnInProgress,
      clientCount: session.clients.size,
      contextPct: session.contextPct,
    });
  }
  return getActiveSessions(infos);
}

// -- CC process lifecycle --

function spawnCC(session: Session): void {
  const args = buildCCArgs(session.id, session.resumable);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== "CLAUDECODE" && k !== "CLAUDE_CODE_ENTRYPOINT",
      ),
    ),
    // Reset CWD after each Bash command — sessions must stay in their project folder
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
    // No TTY — background task management is meaningless
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    // No terminal to update
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
  session.process = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: session.folder,
  });
  session.resumable = true;
  session.spawnedAt = Date.now();
  session.stderrBuffer = [];
  wireProcess(session);
  emit({ type: "session:spawn", folder: session.folderName, sessionId: session.id, pid: session.process.pid! });
  persistSessions();

  // Init timeout: if CC doesn't emit an init event within 30s, kill it.
  // This catches hung resumes (observed: 90s stall on third concurrent resume).
  session.initTimer = setTimeout(() => {
    session.initTimer = null;
    if (session.process) {
      emit({ type: "init:timeout", folder: session.folderName, sessionId: session.id, pid: session.process.pid! });
      killWithEscalation(session.process);
      broadcastToSession(session, "delta", {
        type: "status",
        status: "error",
        error: "CC failed to initialise within 30s",
      });
    }
  }, INIT_TIMEOUT_MS);
}

function wireProcess(session: Session): void {
  const proc = session.process!;
  const rl = createInterface({ input: proc.stdout! });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      session.lastOutputTime = Date.now();
      if (isUserTextEcho(event)) return;
      handleCCEvent(session, event);
    } catch {
      emit({ type: "process:non-json", folder: session.folderName, line: trimmed.slice(0, 200) });
    }
  });

  // Stderr: keep last 20 lines for diagnostics
  const stderrRl = createInterface({ input: proc.stderr! });
  stderrRl.on("line", (line) => {
    session.stderrBuffer.push(line);
    if (session.stderrBuffer.length > 20) session.stderrBuffer.shift();
  });

  proc.on("exit", (code, signal) => {
    emit({ type: "session:exit", folder: session.folderName, sessionId: session.id, code, signal });
    if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }
    const wasMidTurn = session.turnInProgress;
    session.process = null;
    session.spawnedAt = null;
    session.turnInProgress = false;
    session.promptQueue = [];
    flushPendingDeltas(session);

    // Only synthesise result if CC died mid-turn (no result event was emitted).
    // Clean exit after a completed turn already broadcast state via onTurnComplete.
    if (wasMidTurn) {
      session.stateBuilder.handleEvent({
        type: "result",
        subtype: signal ? "aborted" : "success",
        is_error: !!signal,
        result: signal ? `Process killed (${signal})` : "",
      });
    }
    broadcastToSession(session, "state", {
      ...session.stateBuilder.getState(),
    });
    persistSessions();
  });
}

// -- Event handling + delta conflation --

function handleCCEvent(session: Session, event: Record<string, unknown>): void {
  // Clear init timeout on first system init event
  if (event.type === "system" && event.subtype === "init" && session.initTimer) {
    clearTimeout(session.initTimer);
    session.initTimer = null;
  }

  // Track content for local command recovery
  if (event.type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    if (inner?.type === "content_block_start") {
      session.hadContentThisTurn = true;
    }
  }

  // Content_block_delta → accumulate for conflation
  if (isStreamDelta(event)) {
    const info = extractDeltaInfo(event);
    if (info) {
      const existing = session.pendingDeltas.get(info.key);
      if (existing) {
        existing.accumulated += info.payload;
      } else {
        session.pendingDeltas.set(info.key, {
          index: info.index,
          deltaType: info.deltaType,
          field: info.field,
          accumulated: info.payload,
        });
      }
      if (!session.flushTimer) {
        session.flushTimer = setTimeout(
          () => flushPendingDeltas(session),
          CONFLATION_INTERVAL_MS,
        );
      }
      // Do NOT pass original deltas to state builder — the merged delta
      // from flushPendingDeltas handles it. Passing both would double the text.
      return;
    }
  }

  // Non-delta: flush pending deltas FIRST (ordering guarantee)
  flushPendingDeltas(session);

  // Route through state builder
  const delta = session.stateBuilder.handleEvent(event);
  if (delta) {
    broadcastToSession(session, "delta", delta);
    // Push notification when Claude asks a question and user isn't watching
    if (delta.type === "ask_user") {
      pushAskUser(session.folderName).catch((err) =>
        console.error("[push] ask_user notification failed:", err),
      );
    }
  }

  // Update context % on state builder
  if (event.type === "result") {
    const state = session.stateBuilder.getState();
    session.contextPct = state.session.context_pct;
    onTurnComplete(session);
  }
}

function flushPendingDeltas(session: Session): void {
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  for (const pending of session.pendingDeltas.values()) {
    const merged = buildMergedDelta(pending);
    const delta = session.stateBuilder.handleEvent(merged);
    if (delta) broadcastToSession(session, "delta", delta);
  }
  session.pendingDeltas.clear();
}

// -- Turn completion --

function onTurnComplete(session: Session): void {
  const durationMs = session.turnStartedAt ? Date.now() - session.turnStartedAt : 0;
  session.turnInProgress = false;
  session.turnStartedAt = null;

  // Recover local command output (CC writes to JSONL, not stdout)
  if (!session.hadContentThisTurn) {
    try {
      const jsonlPath = getSessionJSONLPath(session.folder, session.id);
      const content = readFileSync(jsonlPath, "utf-8");
      const localOutput = extractLocalCommandOutput(content);
      if (localOutput) {
        const wrapper = JSON.parse(localOutput);
        session.stateBuilder.handleEvent(wrapper.event);
      }
    } catch { /* JSONL may not exist yet */ }
  }
  session.hadContentThisTurn = false;

  // Broadcast full state snapshot
  broadcastToSession(session, "state", {
    ...session.stateBuilder.getState(),
  });

  // Emit turn metrics
  const state = session.stateBuilder.getState();
  const lastMsg = [...state.messages].reverse().find((m) => m.role === "assistant");
  emit({
    type: "turn:complete",
    folder: session.folderName,
    sessionId: session.id,
    durationMs,
    inputTokens: null,
    outputTokens: null,
    contextPct: session.contextPct,
    toolCalls: lastMsg?.tool_calls?.length ?? 0,
  });

  // Push notification when no SSE clients are watching (phone-in-pocket)
  if (session.clients.size === 0) {
    pushTurnComplete(session.folderName).catch((err) =>
      emit({ type: "push:send-fail", endpoint: "turn-complete", error: String(err) }),
    );
  }

  // Flush prompt queue (may start a new turn, so grace check must come after)
  if (session.promptQueue.length > 0) {
    const next = session.promptQueue.shift()!;
    deliverPrompt(session, next);
  }

  maybeStartGraceTimer(session);
}

// -- Prompt delivery --

function deliverPrompt(
  session: Session,
  msg: { text?: string; content?: unknown[] },
): void {
  if (!session.process || session.process.exitCode !== null) {
    spawnCC(session);
  }

  // A prompt means someone is active — cancel any grace countdown
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  session.lastPromptAt = Date.now();

  // Add user message to state immediately
  if (msg.text) {
    session.stateBuilder.handleEvent({
      type: "user",
      message: { role: "user", content: msg.text },
    });
  }

  // Write to CC stdin
  const ccContent = msg.content || msg.text || "";
  const envelope = JSON.stringify({
    type: "user",
    message: { role: "user", content: ccContent },
  });

  try {
    session.process!.stdin!.write(envelope + "\n");
    session.turnInProgress = true;
    session.turnStartedAt = Date.now();
    session.hadContentThisTurn = false;

    emit({ type: "prompt:deliver", folder: session.folderName, sessionId: session.id });
  } catch (err) {
    emit({ type: "process:stdin-error", folder: session.folderName, sessionId: session.id, error: String(err) });
    broadcastToSession(session, "delta", {
      type: "status",
      status: "error",
      error: "Failed to write to CC stdin",
    });
  }
}

// -- Kill with escalation --

function killWithEscalation(proc: ChildProcess): void {
  if (!proc.pid) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    try {
      process.kill(proc.pid!, 0); // check alive
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
  }, KILL_ESCALATION_MS);
  timer.unref();
}

// -- Session resolution --

async function resolveOrCreateSession(folderPath: string): Promise<Session> {
  const existing = sessions.get(folderPath);
  if (existing) return existing;

  const folderName = basename(folderPath);
  const latestSession = await getLatestSession(folderPath);
  const handoff = await getLatestHandoff(folderPath);
  const exited = latestSession ? await hasExitMarker(folderPath, latestSession.id) : false;

  const resolution = resolveSessionForFolder(
    null, // no existing bridge session for this folder
    latestSession,
    handoff?.sessionId ?? null,
    exited,
    randomUUID,
  );

  emit({ type: "session:resolve", folder: folderName, sessionId: resolution.sessionId, outcome: resolution.resumable ? "resume" : "fresh" });

  const session: Session = {
    id: resolution.sessionId,
    folder: folderPath,
    folderName,
    stateBuilder: new StateBuilder(resolution.sessionId, folderName),
    process: null,
    clients: new Set(),
    resumable: resolution.resumable,
    stderrBuffer: [],
    spawnedAt: null,
    turnInProgress: false,
    hadContentThisTurn: false,
    lastOutputTime: null,
    promptQueue: [],
    lastPromptAt: null,
    pendingDeltas: new Map(),
    flushTimer: null,
    graceTimer: null,
    initTimer: null,
    contextPct: null,
    turnStartedAt: null,
  };

  // Replay JSONL if resuming (async to avoid blocking on large files)
  if (resolution.resumable) {
    try {
      const jsonlPath = getSessionJSONLPath(folderPath, resolution.sessionId);
      const content = await readFile(jsonlPath, "utf-8");
      const events = parseSessionJSONL(content);
      session.stateBuilder.replayFromJSONL(events);
      emit({ type: "replay:ok", folder: folderName, eventCount: events.length });
    } catch (err) {
      emit({ type: "replay:fail", folder: folderName, error: String(err) });
    }
  }

  sessions.set(folderPath, session);
  return session;
}

// -- HTTP body reader --

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — plenty for prompts with images

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        emit({ type: "request:rejected", reason: "body-too-large", method: req.method || "?", url: req.url || "?" });
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// -- Folder path resolution --

function resolveFolder(folderParam: string): string | null {
  // Accept both full paths and folder names
  if (folderParam.startsWith("/")) {
    return validateFolderPath(folderParam, SCAN_ROOT) ? folderParam : null;
  }
  // Treat as basename under SCAN_ROOT
  const fullPath = `${SCAN_ROOT}/${folderParam}`;
  return validateFolderPath(fullPath, SCAN_ROOT) ? fullPath : null;
}

// -- Session tear-down and creation --

/**
 * Tear down an existing session: kill CC process, notify clients, remove from map.
 * Used when switching to a different session within the same folder.
 */
async function tearDownSession(session: Session): Promise<void> {
  emit({ type: "session:teardown", folder: session.folderName, sessionId: session.id });

  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }
  if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }

  if (session.process) {
    killWithEscalation(session.process);
    // Give it a moment to die so the exit handler fires
    await new Promise((r) => setTimeout(r, 100));
  }

  // Detach all clients (they'll be re-attached to the new session)
  for (const client of session.clients) {
    client.folder = null;
  }
  session.clients.clear();
  sessions.delete(session.folder);
  persistSessions();
}

/**
 * Create a session with a specific ID and replay JSONL if resumable.
 */
async function createSessionWithId(
  folderPath: string,
  sessionId: string,
  resumable: boolean,
): Promise<Session> {
  const folderName = basename(folderPath);
  const session: Session = {
    id: sessionId,
    folder: folderPath,
    folderName,
    stateBuilder: new StateBuilder(sessionId, folderName),
    process: null,
    clients: new Set(),
    resumable,
    stderrBuffer: [],
    spawnedAt: null,
    turnInProgress: false,
    hadContentThisTurn: false,
    lastOutputTime: null,
    promptQueue: [],
    lastPromptAt: null,
    pendingDeltas: new Map(),
    flushTimer: null,
    graceTimer: null,
    initTimer: null,
    contextPct: null,
    turnStartedAt: null,
  };

  if (resumable) {
    try {
      const jsonlPath = getSessionJSONLPath(folderPath, sessionId);
      const content = await readFile(jsonlPath, "utf-8");
      const events = parseSessionJSONL(content);
      session.stateBuilder.replayFromJSONL(events);
      emit({ type: "replay:ok", folder: folderName, eventCount: events.length, sessionId });
    } catch (err) {
      emit({ type: "replay:fail", folder: folderName, error: String(err), sessionId });
    }
  }

  sessions.set(folderPath, session);
  return session;
}

// -- Route handlers --

async function handleSession(
  folderPath: string,
  client: SSEClient | undefined,
  res: ServerResponse,
  requestedSessionId?: string,
): Promise<void> {
  // Detach from current session if switching
  if (client?.folder && client.folder !== folderPath) {
    detachFromSession(client);
  }

  // Three modes based on requestedSessionId:
  //   undefined → current behavior (resolve latest)
  //   "new"    → fresh session (no --resume)
  //   "<uuid>" → resume that specific session
  let session: Session;

  if (!requestedSessionId) {
    // Default: resolve latest session for folder
    session = await resolveOrCreateSession(folderPath);
  } else {
    const existing = sessions.get(folderPath);

    if (requestedSessionId === "new") {
      // Tear down existing session for this folder if present
      if (existing) {
        await tearDownSession(existing);
      }
      const newId = randomUUID();
      session = await createSessionWithId(folderPath, newId, false);
    } else {
      // Specific session UUID requested
      if (existing && existing.id === requestedSessionId) {
        // Already the active session — reuse
        session = existing;
      } else {
        // Different session — tear down existing, create for the requested UUID
        if (existing) {
          await tearDownSession(existing);
        }
        session = await createSessionWithId(folderPath, requestedSessionId, true);
      }
    }
  }

  if (client) {
    attachToSession(client, session);
    // Send current state snapshot
    sendSSE(client, "state", {
      folder: session.folderName,
      ...session.stateBuilder.getState(),
    });
  }

  // Lazy spawn: CC starts on first prompt, not on session connect.
  // This avoids cold starts when the user browses folders without sending.
  // deliverPrompt() handles spawn-if-needed.

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    sessionId: session.id,
    folder: session.folderName,
    resumable: session.resumable,
  }));
}

async function handlePrompt(
  folderPath: string,
  body: string,
  res: ServerResponse,
): Promise<void> {
  // Auto-create session if needed (cold path: prompt without prior POST /session)
  const session = sessions.get(folderPath) || await resolveOrCreateSession(folderPath);

  let parsed: { text?: string; content?: unknown[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (session.turnInProgress) {
    // Queue the prompt
    session.promptQueue.push(parsed);
    emit({ type: "prompt:queue", folder: session.folderName, sessionId: session.id, depth: session.promptQueue.length });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true, position: session.promptQueue.length }));
    return;
  }

  deliverPrompt(session, parsed);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ delivered: true }));
}

async function handleAbort(folderPath: string, res: ServerResponse): Promise<void> {
  const session = sessions.get(folderPath);
  if (!session?.process) {
    res.writeHead(404).end(JSON.stringify({ error: "No running process" }));
    return;
  }

  killWithEscalation(session.process);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ aborted: true }));
}

async function handleExit(folderPath: string, res: ServerResponse): Promise<void> {
  const session = sessions.get(folderPath);
  if (!session) {
    res.writeHead(404).end(JSON.stringify({ error: "No session for this folder" }));
    return;
  }

  // Write exit marker
  await writeExitMarker(session.folder, session.id);

  // Kill process if running
  if (session.process) {
    killWithEscalation(session.process);
  }

  // Notify clients
  broadcastToSession(session, "state", {
    ...session.stateBuilder.getState(),
    status: "idle",
  });

  // Clean up
  for (const client of session.clients) {
    client.folder = null;
  }
  session.clients.clear();
  sessions.delete(folderPath);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ exited: true }));
}

// -- Static file serving --

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STATIC_FILES: Record<string, { file: string; mime: string }> = {
  "/": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/sw.js": { file: "sw.js", mime: "application/javascript" },
  "/manifest.json": { file: "manifest.json", mime: "application/json" },
  "/icon-192.svg": { file: "icon-192.svg", mime: "image/svg+xml" },
  "/icon-512.svg": { file: "icon-512.svg", mime: "image/svg+xml" },
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  try {
    const content = readFileSync(join(PROJECT_ROOT, entry.file), "utf-8");
    res.writeHead(200, {
      "Content-Type": entry.mime,
      "Cache-Control": "no-cache",
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// -- HTTP server --

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-ID");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url!, `http://localhost`);

  // GET /events — SSE connection
  if (req.method === "GET" && url.pathname === "/events") {
    const clientId = url.searchParams.get("clientId") || randomUUID();
    setupSSE(req, res, clientId);
    return;
  }

  // GET /folders — list folders
  if (req.method === "GET" && url.pathname === "/folders") {
    const folders = await scanFolders(buildActiveSessionsMap());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ folders }));
    return;
  }

  // GET /status — debug endpoint
  if (req.method === "GET" && url.pathname === "/status") {
    const now = Date.now();
    const sessionList = [...sessions.values()].map((s) => ({
      folder: s.folderName,
      sessionId: s.id,
      pid: s.process?.pid ?? null,
      uptimeMs: s.spawnedAt ? now - s.spawnedAt : null,
      contextPct: s.contextPct,
      turnInProgress: s.turnInProgress,
      clients: s.clients.size,
      queueDepth: s.promptQueue.length,
    }));
    const mem = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      uptime: process.uptime(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      sessions: sessionList,
      sseClients: allClients.size,
      recentEvents: getRecent(50),
    }));
    return;
  }

  // POST routes: /session/:folder, /prompt/:folder, /abort/:folder, /exit/:folder
  const match = url.pathname.match(/^\/(session|prompt|abort|exit)\/(.+)$/);
  if (match && req.method === "POST") {
    const [, action, folderParam] = match;
    const folderPath = resolveFolder(decodeURIComponent(folderParam));

    if (!folderPath) {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid folder path" }));
      return;
    }

    const clientId = req.headers["x-client-id"] as string;
    const client = clientId ? clientsById.get(clientId) : undefined;

    try {
      switch (action) {
        case "session": {
          const sessionBody = await readBody(req);
          let requestedSessionId: string | undefined;
          if (sessionBody) {
            try {
              const parsed = JSON.parse(sessionBody);
              if (parsed.sessionId) requestedSessionId = parsed.sessionId;
            } catch { /* empty body or invalid JSON — use default */ }
          }
          await handleSession(folderPath, client, res, requestedSessionId);
          return;
        }
        case "prompt": {
          const body = await readBody(req);
          await handlePrompt(folderPath, body, res);
          return;
        }
        case "abort":
          await handleAbort(folderPath, res);
          return;
        case "exit":
          await handleExit(folderPath, res);
          return;
      }
    } catch (err) {
      emit({ type: "request:error", action, error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500).end(JSON.stringify({ error: "Internal error" }));
      }
      return;
    }
  }

  // POST /push/subscribe — store push subscription
  if (req.method === "POST" && url.pathname === "/push/subscribe") {
    try {
      const body = await readBody(req);
      const sub = JSON.parse(body);
      if (!sub.endpoint) {
        res.writeHead(400).end(JSON.stringify({ error: "Missing endpoint" }));
        return;
      }
      addSubscription(sub);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ subscribed: true }));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid subscription" }));
    }
    return;
  }

  // POST /push/unsubscribe — remove push subscription
  if (req.method === "POST" && url.pathname === "/push/unsubscribe") {
    try {
      const body = await readBody(req);
      const { endpoint } = JSON.parse(body);
      if (!endpoint) {
        res.writeHead(400).end(JSON.stringify({ error: "Missing endpoint" }));
        return;
      }
      removeSubscription(endpoint);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ unsubscribed: true }));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid body" }));
    }
    return;
  }

  // POST /client-error — mobile error reporting
  if (req.method === "POST" && url.pathname === "/client-error") {
    // Simple rate limit: track recent reports, cap at 10/min
    const now = Date.now();
    clientErrorTimestamps = clientErrorTimestamps.filter((t) => now - t < 60_000);
    if (clientErrorTimestamps.length >= 10) {
      res.writeHead(429).end(JSON.stringify({ error: "Rate limited" }));
      return;
    }
    clientErrorTimestamps.push(now);
    try {
      const body = await readBody(req);
      const { message, stack, userAgent, url: errorUrl } = JSON.parse(body);
      emit({ type: "client:error", message: String(message || ""), stack, userAgent, url: errorUrl });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid body" }));
    }
    return;
  }

  // Static files — index.html, sw.js, manifest.json, icons
  if (req.method === "GET" && serveStatic(url.pathname, res)) return;

  res.writeHead(404).end("Not found");
});

// -- Ping loop --

const pingTimer = setInterval(() => {
  for (const client of allClients) {
    sendSSE(client, "ping", {}); // sendSSE handles cleanup on failure
  }
}, 30_000);
pingTimer.unref(); // don't prevent clean shutdown

// -- Graceful shutdown --

function shutdown(signal: string): void {
  emit({ type: "server:shutdown", signal });

  // Stop accepting new connections
  server.close();

  // Stop pinging
  clearInterval(pingTimer);

  // Kill all child CC processes
  for (const session of sessions.values()) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.process) {
      emit({ type: "process:kill", folder: session.folderName, pid: session.process.pid!, reason: "shutdown" });
      killWithEscalation(session.process);
    }
  }

  // Close all SSE connections
  for (const client of allClients) {
    client.res.end();
  }
  allClients.clear();
  clientsById.clear();
  sessions.clear();

  // Clean session file — graceful shutdown means no orphans
  try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }

  // Give kill escalation time to fire if needed, then exit
  setTimeout(() => process.exit(0), KILL_ESCALATION_MS + 500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// -- Start --

initLogger();
initStatusBuffer();
reapOrphans();

server.listen(PORT, () => {
  emit({ type: "server:start", port: PORT, scanRoot: SCAN_ROOT });
});
