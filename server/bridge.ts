import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { IncomingMessage } from "http";

// --- Configuration ---

const PORT = parseInt(process.env.BRIDGE_PORT || "3001", 10);
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PING_INTERVAL_MS = 30_000; // 30 seconds
const PONG_TIMEOUT_MS = 10_000; // 10 seconds to respond
const KILL_ESCALATION_MS = 3_000; // SIGTERM → SIGKILL after 3 seconds
const EARLY_EXIT_MS = 2_000; // Process dying within 2s of spawn = flag/version problem

// --- Protocol types ---

// Browser → Bridge
interface ClientPrompt {
  type: "prompt";
  text: string;
}
interface ClientAbort {
  type: "abort";
}
type ClientMessage = ClientPrompt | ClientAbort;

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
interface BridgeCCEvent {
  source: "cc";
  event: Record<string, unknown>;
}
type ServerMessage =
  | BridgeConnected
  | BridgePromptReceived
  | BridgeError
  | BridgeProcessExit
  | BridgeCCEvent;

// --- Session state ---

interface Session {
  id: string;
  process: ChildProcess | null;
  ws: WebSocket | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  stderrBuffer: string[]; // Capture stderr for early-exit diagnostics
  spawnedAt: number | null; // Timestamp of last spawn, for early-exit detection
}

const sessions = new Map<string, Session>();

// --- CC process management ---

const CC_FLAGS = [
  "-p",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

function spawnCC(sessionId: string, resume: boolean): ChildProcess {
  const args = [
    ...CC_FLAGS,
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  console.log(
    `[bridge] spawned CC pid=${proc.pid} session=${sessionId}${resume ? " (resume)" : ""}`
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
    sendToClient(session.ws, {
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

  session.stderrBuffer = [];
  session.spawnedAt = Date.now();

  // Parse CC stdout line-by-line as JSONL
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      sendToClient(session.ws, { source: "cc", event });
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
      sendToClient(session.ws, {
        source: "bridge",
        type: "error",
        error: `CC process failed immediately (${uptime}ms). Likely a flag or version problem.\n${hint}`,
      });
    }

    sendToClient(session.ws, {
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
    sendToClient(session.ws, {
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
    session.process = spawnCC(session.id, resume);
    wireProcessToSession(session);
    return true;
  } catch (err) {
    console.error(
      `[bridge] failed to spawn CC session=${session.id}:`,
      (err as Error).message
    );
    sendToClient(session.ws, {
      source: "bridge",
      type: "error",
      error: `Failed to spawn CC: ${(err as Error).message}`,
    });
    return false;
  }
}

// --- Ping/pong ---

function startPingPong(ws: WebSocket, session: Session): void {
  // Clear any existing timers
  stopPingPong(session);

  session.pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stopPingPong(session);
      return;
    }
    ws.ping();
    session.pongTimer = setTimeout(() => {
      console.log(
        `[bridge] pong timeout, terminating connection session=${session.id}`
      );
      ws.terminate(); // Hard close — triggers 'close' event
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

  ws.on("pong", () => {
    if (session.pongTimer) {
      clearTimeout(session.pongTimer);
      session.pongTimer = null;
    }
  });
}

function stopPingPong(session: Session): void {
  if (session.pingTimer) {
    clearInterval(session.pingTimer);
    session.pingTimer = null;
  }
  if (session.pongTimer) {
    clearTimeout(session.pongTimer);
    session.pongTimer = null;
  }
}

// --- WebSocket server ---

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[bridge] WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const requestedSessionId = url.searchParams.get("session");

  let session: Session;
  let resumed = false;

  if (requestedSessionId && sessions.has(requestedSessionId)) {
    // Reconnect to existing session
    session = sessions.get(requestedSessionId)!;
    resumed = true;

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Close previous WebSocket if still open
    if (session.ws && session.ws !== ws) {
      session.ws.close(1000, "Replaced by new connection");
      stopPingPong(session);
    }
    session.ws = ws;

    // If CC process died while disconnected, it will be respawned on next prompt
    // (lazy spawn — don't respawn until user actually sends something)
  } else {
    // New session — no CC process yet (lazy spawn on first prompt)
    const id = requestedSessionId || randomUUID();
    session = {
      id,
      process: null,
      ws,
      idleTimer: null,
      pingTimer: null,
      pongTimer: null,
      stderrBuffer: [],
      spawnedAt: null,
    };
    sessions.set(id, session);
    resumed = !!requestedSessionId;
  }

  // Start ping/pong for this connection
  startPingPong(ws, session);

  // Announce connection
  sendToClient(ws, {
    source: "bridge",
    type: "connected",
    sessionId: session.id,
    resumed,
  });

  console.log(
    `[bridge] client connected session=${session.id} resumed=${resumed}`
  );

  // Handle incoming messages
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

    switch (msg.type) {
      case "prompt": {
        // Lazy spawn: start CC process on first prompt (or respawn if dead)
        const needsResume = session.process === null && resumed;
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

      default:
        sendToClient(ws, {
          source: "bridge",
          type: "error",
          error: `Unknown message type: ${(msg as any).type}`,
        });
    }
  });

  // Client disconnect → idle timer
  ws.on("close", (code, reason) => {
    console.log(
      `[bridge] client disconnected session=${session.id} code=${code}`
    );
    session.ws = null;
    stopPingPong(session);

    session.idleTimer = setTimeout(() => {
      console.log(
        `[bridge] idle timeout, killing CC session=${session.id}`
      );
      if (session.process) {
        killWithEscalation(session.process, session.id);
      }
      sessions.delete(session.id);
    }, IDLE_TIMEOUT_MS);
  });

  ws.on("error", (err) => {
    console.error(`[bridge] WS error session=${session.id}:`, err);
  });
});

// --- Graceful shutdown ---

function shutdown() {
  console.log("[bridge] shutting down...");
  for (const [id, session] of sessions) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    stopPingPong(session);
    if (session.process) killWithEscalation(session.process, id);
    if (session.ws) session.ws.close(1000, "Server shutting down");
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
