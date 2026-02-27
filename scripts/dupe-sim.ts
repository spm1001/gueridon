/**
 * Duplicate-message simulator.
 *
 * Mock SSE server that serves the real gueridon frontend and replays
 * controlled event sequences to reproduce suspected dupe scenarios.
 *
 * Usage:
 *   npx tsx scripts/dupe-sim.ts [--port 3333] [--scenario <name>]
 *
 * Scenarios:
 *   baseline     — normal turn: state → deltas → turn-end state (no dupe expected)
 *   mid-turn     — mid-turn state snapshot while deltas are streaming (hovolu pattern)
 *   reconnect    — SSE drops and reconnects during a turn
 *   upload-race  — user sends prompt, upload arrives mid-turn
 *   double-state — two rapid state snapshots
 *
 * After the scenario plays, the server stays up so passe can screenshot.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), "../..");

// -- Args --
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 3333;
const scenarioIdx = args.indexOf("--scenario");
const SCENARIO = scenarioIdx >= 0 ? args[scenarioIdx + 1] : "baseline";

// -- SSE helpers --

type SSEClient = {
  res: ServerResponse;
  id: string;
};

const clients: SSEClient[] = [];
let scenarioRunning = false;
let sessionBound: () => void;  // resolved when POST /session arrives
const sessionReady = new Promise<void>((r) => { sessionBound = r; });

function sendSSE(client: SSEClient, event: string, data: unknown): void {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  for (const c of clients) sendSSE(c, event, data);
}

// -- State factory --

interface MockMessage {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: { name: string; status: string; input: string; output: string | null; collapsed: boolean }[];
  synthetic?: boolean;
  thinking?: string;
}

function makeState(messages: MockMessage[], status: "idle" | "working" = "idle") {
  return {
    folder: "sim-project",
    session: { id: "sim-001", model: "claude-sonnet-4-20250514", project: "sim-project", context_pct: 12 },
    messages,
    connection: "connected",
    status,
    slashCommands: [
      { name: "compact", description: "Compact context", local: true },
      { name: "exit", description: "Exit session", local: true },
    ],
  };
}

// -- Scenario definitions --

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Baseline: normal turn lifecycle. Should produce no dupes. */
async function scenarioBaseline(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well! How can I help you today?" },
  ];

  // Initial state (idle)
  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // User sends a message
  history.push({ role: "user", content: "What files are in this project?" });
  broadcast("state", makeState(history, "working"));
  await sleep(300);

  // Streaming deltas
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "thinking" });
  await sleep(500);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "Let me check the project files for you." });
  await sleep(300);

  // Tool call
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "tool" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "tool_start", index: 0, name: "Bash", input: "ls -la" });
  await sleep(500);
  broadcast("delta", { folder: "sim-project", type: "tool_complete", index: 0, status: "completed", output: "total 42\ndrwxr-xr-x  5 user user  160 Feb 26 10:00 .\n-rw-r--r--  1 user user 1234 Feb 26 10:00 index.html" });
  await sleep(300);

  // More content
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "Here are the files in the project:\n\n- `index.html` — main frontend\n- `style.css` — styles\n- `server/bridge.ts` — SSE bridge server" });
  await sleep(200);

  // Turn complete — full state snapshot
  history.push({
    role: "assistant",
    content: "Here are the files in the project:\n\n- `index.html` — main frontend\n- `style.css` — styles\n- `server/bridge.ts` — SSE bridge server",
    tool_calls: [{ name: "Bash", status: "completed", input: "ls -la", output: "total 42\ndrwxr-xr-x  5 user user  160 Feb 26 10:00 .\n-rw-r--r--  1 user user 1234 Feb 26 10:00 index.html", collapsed: true }],
  });
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  await sleep(100);
  broadcast("state", makeState(history, "idle"));
}

/** Mid-turn state snapshot — the hovolu pattern. */
async function scenarioMidTurn(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Hello, review this code" },
    { role: "assistant", content: "Sure, I'll take a look." },
  ];

  // Initial state
  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // User sends a prompt
  history.push({ role: "user", content: "What do you think about the architecture?" });
  broadcast("state", makeState(history, "working"));
  await sleep(300);

  // CC starts streaming
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "The architecture looks solid. Let me examine" });
  await sleep(300);

  // *** MID-TURN: upload arrives, bridge broadcasts state snapshot ***
  const historyWithDeposit = [...history];
  historyWithDeposit.push({ role: "user", content: "Uploaded 1 file to mise/upload--screenshot--abc123", synthetic: true });
  broadcast("state", makeState(historyWithDeposit, "working"));
  await sleep(100);

  // Deltas continue for the original turn
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "The architecture looks solid. Let me examine the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns" });
  await sleep(300);

  // Tool
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "tool" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "tool_start", index: 0, name: "Read", input: "server/bridge.ts" });
  await sleep(400);
  broadcast("delta", { folder: "sim-project", type: "tool_complete", index: 0, status: "completed", output: "/**\n * Guéridon bridge — SSE + POST HTTP server..." });
  await sleep(300);

  // Turn complete
  historyWithDeposit.push({
    role: "assistant",
    content: "The architecture looks solid. Let me examine the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns",
    tool_calls: [{ name: "Read", status: "completed", input: "server/bridge.ts", output: "/**\n * Guéridon bridge — SSE + POST HTTP server...", collapsed: true }],
  });
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  await sleep(100);
  broadcast("state", makeState(historyWithDeposit, "idle"));
}

/** Upload race — user prompt being processed, upload arrives mid-turn. */
async function scenarioUploadRace(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Let me show you the bug" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // CC starts responding
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "Sure, show me what you're seeing." });
  await sleep(200);

  // Turn 1 completes
  history.push({ role: "assistant", content: "Sure, show me what you're seeing." });
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  broadcast("state", makeState(history, "idle"));
  await sleep(500);

  // User sends text + upload arrives near-simultaneously
  history.push({ role: "user", content: "Here's a screenshot of the error" });
  history.push({ role: "user", content: "Uploaded 1 file to mise/upload--error-screenshot--xyz", synthetic: true });
  broadcast("state", makeState(history, "working"));
  await sleep(300);

  // CC processes both
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "I can see the error in your screenshot. The issue is a null reference in `handleSSEState`." });
  await sleep(400);

  // Turn complete
  history.push({
    role: "assistant",
    content: "I can see the error in your screenshot. The issue is a null reference in `handleSSEState`.",
  });
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  broadcast("state", makeState(history, "idle"));
}

/** Double state — two rapid snapshots. */
async function scenarioDoubleState(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Explain this function" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // CC responding
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "This function handles incoming SSE events. It has two main branches:" });
  await sleep(400);

  // Two state snapshots in rapid succession
  history.push({
    role: "assistant",
    content: "This function handles incoming SSE events. It has two main branches:",
  });
  broadcast("state", makeState(history, "working"));
  await sleep(50);
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  broadcast("state", makeState(history, "idle"));
}

/** Reconnect scenario — SSE drops mid-turn, replay state + live deltas. */
async function scenarioReconnect(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Refactor the upload handler" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // Turn starts
  broadcast("delta", { folder: "sim-project", type: "status", status: "working" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "message_start" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "tool" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "tool_start", index: 0, name: "Read", input: "server/bridge.ts" });
  await sleep(400);
  broadcast("delta", { folder: "sim-project", type: "tool_complete", index: 0, status: "completed", output: "// file content..." });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "writing" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "I'll refactor the upload handler to separate concerns." });
  await sleep(300);

  // *** RECONNECT ***
  // Simulate: bridge sends a fresh hello (reconnect=true) + state snapshot with partial response
  broadcast("hello", { version: 1, clientId: "sim-reconnect", reconnect: true });
  await sleep(100);

  const partialHistory: MockMessage[] = [
    ...history,
    {
      role: "assistant",
      content: "I'll refactor the upload handler to separate concerns.",
      tool_calls: [{ name: "Read", status: "completed", input: "server/bridge.ts", output: "// file content...", collapsed: true }],
    },
  ];
  broadcast("state", makeState(partialHistory, "working"));
  await sleep(300);

  // Deltas continue
  broadcast("delta", { folder: "sim-project", type: "activity", activity: "tool" });
  await sleep(100);
  broadcast("delta", { folder: "sim-project", type: "tool_start", index: 1, name: "Edit", input: "server/bridge.ts" });
  await sleep(500);
  broadcast("delta", { folder: "sim-project", type: "tool_complete", index: 1, status: "completed", output: "Applied edit" });
  await sleep(200);
  broadcast("delta", { folder: "sim-project", type: "content", index: 0, text: "I'll refactor the upload handler to separate concerns.\n\n1. Extract `depositFiles` into its own module\n2. Move MIME validation to a shared utility\n\nDone!" });
  await sleep(200);

  // Turn complete
  partialHistory[partialHistory.length - 1] = {
    role: "assistant",
    content: "I'll refactor the upload handler to separate concerns.\n\n1. Extract `depositFiles` into its own module\n2. Move MIME validation to a shared utility\n\nDone!",
    tool_calls: [
      { name: "Read", status: "completed", input: "server/bridge.ts", output: "// file content...", collapsed: true },
      { name: "Edit", status: "completed", input: "server/bridge.ts", output: "Applied edit", collapsed: true },
    ],
  };
  broadcast("delta", { folder: "sim-project", type: "status", status: "idle" });
  broadcast("state", makeState(partialHistory, "idle"));
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  baseline: scenarioBaseline,
  "mid-turn": scenarioMidTurn,
  reconnect: scenarioReconnect,
  "upload-race": scenarioUploadRace,
  "double-state": scenarioDoubleState,
};

// -- HTTP server --

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function serveFile(res: ServerResponse, path: string): void {
  try {
    const content = readFileSync(join(PROJECT_ROOT, path));
    const ext = extname(path);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const path = url.pathname;

  // SSE endpoint
  if (path === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const clientId = url.searchParams.get("clientId") || "anon";
    const client: SSEClient = { res, id: clientId };
    clients.push(client);

    sendSSE(client, "hello", { version: 1, clientId, reconnect: false });
    sendSSE(client, "folders", {
      folders: [{ name: "sim-project", path: "/tmp/sim-project", state: "active", sessions: [] }],
    });

    // Scenario starts after POST /session (see session handler below)

    req.on("close", () => {
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);
    });
    return;
  }

  // Folders endpoint
  if (path === "/folders") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      folders: [{ name: "sim-project", path: "/tmp/sim-project", state: "active", sessions: [] }],
    }));
    return;
  }

  // Session endpoint — triggers scenario after responding
  if (path.startsWith("/session/") && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: "sim-001", folder: "sim-project", resumable: false }));

    if (!scenarioRunning) {
      scenarioRunning = true;
      // Small delay so the client processes the session response first
      setTimeout(async () => {
        sessionBound();
        const fn = SCENARIOS[SCENARIO];
        if (fn) {
          console.log(`[sim] Running scenario: ${SCENARIO}`);
          await fn();
          console.log(`[sim] Scenario complete. Server staying up for screenshots.`);
        } else {
          console.error(`[sim] Unknown scenario: ${SCENARIO}`);
          console.error(`[sim] Available: ${Object.keys(SCENARIOS).join(", ")}`);
        }
      }, 200);
    }
    return;
  }

  // Prompt endpoint
  if (path.startsWith("/prompt/") && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ delivered: true }));
    return;
  }

  // Static files
  if (path === "/" || path === "/index.html") { serveFile(res, "index.html"); return; }
  if (path === "/style.css") { serveFile(res, "style.css"); return; }
  if (path === "/sw.js") { serveFile(res, "sw.js"); return; }
  if (path === "/manifest.json") { serveFile(res, "manifest.json"); return; }
  if (path.startsWith("/icon-")) { serveFile(res, path.slice(1)); return; }
  if (path === "/marked.js") {
    serveFile(res, "node_modules/marked/lib/marked.umd.js");
    return;
  }

  res.writeHead(404).end("Not found");
});

server.listen(PORT, () => {
  console.log(`[sim] Dupe simulator on http://localhost:${PORT}`);
  console.log(`[sim] Scenario: ${SCENARIO}`);
  console.log(`[sim] Available: ${Object.keys(SCENARIOS).join(", ")}`);
});
