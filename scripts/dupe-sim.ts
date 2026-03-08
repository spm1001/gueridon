/**
 * Duplicate-message simulator.
 *
 * Mock SSE server that serves the real gueridon frontend and replays
 * controlled event sequences to reproduce suspected dupe scenarios.
 *
 * Uses the current SSE protocol: text (append), current (streaming message),
 * state (authoritative snapshot). No delta events.
 *
 * Usage:
 *   npx tsx scripts/dupe-sim.ts [--port 3333] [--scenario <name>]
 *
 * Scenarios:
 *   baseline        — normal turn: state → text/current → turn-end state (no dupe expected)
 *   mid-turn        — mid-turn state snapshot while streaming (hovolu pattern)
 *   reconnect       — SSE drops and reconnects during a turn
 *   upload-race     — user sends prompt, upload arrives mid-turn
 *   double-state    — two rapid state snapshots
 *   current-no-text — current event with no prior text (commit with empty streamingText)
 *   rapid-current   — multiple tool start/complete in quick succession
 *   text-after-reset — text events after state snapshot resets streaming
 *
 * After the scenario plays, the server stays up so passe can screenshot.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_FILES } from "../server/bridge-logic.js";

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

interface MockToolCall {
  name: string;
  status: string;
  input: string;
  output: string | null;
  collapsed: boolean;
}

interface MockMessage {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: MockToolCall[];
  synthetic?: boolean;
  thinking?: string;
}

interface CurrentMessage {
  text: string | null;
  tool_calls: MockToolCall[];
  thinking: string | null;
  activity: string | null;
}

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

/** Emit a text append event. */
function emitText(folder: string, append: string): void {
  broadcast("text", { folder, append });
}

/** Emit a current-message event (streaming overlay). */
function emitCurrent(folder: string, msg: CurrentMessage): void {
  broadcast("current", { folder, ...msg });
}

// -- State factory --

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

const FOLDER = "sim-project";

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

  // Streaming: thinking → writing → text
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "thinking" });
  await sleep(500);
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "Let me check the project files for you.");
  await sleep(300);

  // Tool call
  emitCurrent(FOLDER, {
    text: "Let me check the project files for you.",
    tool_calls: [{ name: "Bash", status: "running", input: "ls -la", output: null, collapsed: false }],
    thinking: null,
    activity: "tool",
  });
  await sleep(500);
  emitCurrent(FOLDER, {
    text: "Let me check the project files for you.",
    tool_calls: [{ name: "Bash", status: "completed", input: "ls -la", output: "total 42\ndrwxr-xr-x  5 user user  160 Feb 26 10:00 .\n-rw-r--r--  1 user user 1234 Feb 26 10:00 index.html", collapsed: true }],
    thinking: null,
    activity: null,
  });
  await sleep(300);

  // More text after tool
  emitText(FOLDER, "\n\nHere are the files in the project:\n\n- `index.html` — main frontend\n- `style.css` — styles\n- `server/bridge.ts` — SSE bridge server");
  await sleep(200);

  // Turn complete — full state snapshot
  history.push({
    role: "assistant",
    content: "Let me check the project files for you.\n\nHere are the files in the project:\n\n- `index.html` — main frontend\n- `style.css` — styles\n- `server/bridge.ts` — SSE bridge server",
    tool_calls: [{ name: "Bash", status: "completed", input: "ls -la", output: "total 42\ndrwxr-xr-x  5 user user  160 Feb 26 10:00 .\n-rw-r--r--  1 user user 1234 Feb 26 10:00 index.html", collapsed: true }],
  });
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
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "The architecture looks solid. Let me examine");
  await sleep(300);

  // *** MID-TURN: upload arrives, bridge broadcasts state snapshot ***
  const historyWithDeposit = [...history];
  historyWithDeposit.push({ role: "user", content: "Uploaded 1 file to mise/upload--screenshot--abc123", synthetic: true });
  broadcast("state", makeState(historyWithDeposit, "working"));
  await sleep(100);

  // Text continues for the original turn
  emitText(FOLDER, " the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns");
  await sleep(300);

  // Tool
  emitCurrent(FOLDER, {
    text: "The architecture looks solid. Let me examine the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns",
    tool_calls: [{ name: "Read", status: "running", input: "server/bridge.ts", output: null, collapsed: false }],
    thinking: null,
    activity: "tool",
  });
  await sleep(400);
  emitCurrent(FOLDER, {
    text: "The architecture looks solid. Let me examine the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns",
    tool_calls: [{ name: "Read", status: "completed", input: "server/bridge.ts", output: "/**\n * Guéridon bridge — SSE + POST HTTP server...", collapsed: true }],
    thinking: null,
    activity: null,
  });
  await sleep(300);

  // Turn complete
  historyWithDeposit.push({
    role: "assistant",
    content: "The architecture looks solid. Let me examine the key patterns:\n\n1. **SSE for real-time updates** — good choice for unidirectional streaming\n2. **State builder pattern** — clean separation of concerns",
    tool_calls: [{ name: "Read", status: "completed", input: "server/bridge.ts", output: "/**\n * Guéridon bridge — SSE + POST HTTP server...", collapsed: true }],
  });
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
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "Sure, show me what you're seeing.");
  await sleep(200);

  // Turn 1 completes
  history.push({ role: "assistant", content: "Sure, show me what you're seeing." });
  broadcast("state", makeState(history, "idle"));
  await sleep(500);

  // User sends text + upload arrives near-simultaneously
  history.push({ role: "user", content: "Here's a screenshot of the error" });
  history.push({ role: "user", content: "Uploaded 1 file to mise/upload--error-screenshot--xyz", synthetic: true });
  broadcast("state", makeState(history, "working"));
  await sleep(300);

  // CC processes both
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "I can see the error in your screenshot. The issue is a null reference in `handleSSEState`.");
  await sleep(400);

  // Turn complete
  history.push({
    role: "assistant",
    content: "I can see the error in your screenshot. The issue is a null reference in `handleSSEState`.",
  });
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
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "This function handles incoming SSE events. It has two main branches:");
  await sleep(400);

  // Two state snapshots in rapid succession
  history.push({
    role: "assistant",
    content: "This function handles incoming SSE events. It has two main branches:",
  });
  broadcast("state", makeState(history, "working"));
  await sleep(50);
  broadcast("state", makeState(history, "idle"));
}

/** Reconnect scenario — SSE drops mid-turn, replay state + live streaming. */
async function scenarioReconnect(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Refactor the upload handler" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // Turn starts
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Read", status: "running", input: "server/bridge.ts", output: null, collapsed: false }],
    thinking: null,
    activity: "tool",
  });
  await sleep(400);
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Read", status: "completed", input: "server/bridge.ts", output: "// file content...", collapsed: true }],
    thinking: null,
    activity: null,
  });
  await sleep(200);
  emitText(FOLDER, "I'll refactor the upload handler to separate concerns.");
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

  // Streaming continues after reconnect
  emitCurrent(FOLDER, {
    text: "I'll refactor the upload handler to separate concerns.",
    tool_calls: [
      { name: "Read", status: "completed", input: "server/bridge.ts", output: "// file content...", collapsed: true },
      { name: "Edit", status: "running", input: "server/bridge.ts", output: null, collapsed: false },
    ],
    thinking: null,
    activity: "tool",
  });
  await sleep(500);
  emitCurrent(FOLDER, {
    text: "I'll refactor the upload handler to separate concerns.",
    tool_calls: [
      { name: "Read", status: "completed", input: "server/bridge.ts", output: "// file content...", collapsed: true },
      { name: "Edit", status: "completed", input: "server/bridge.ts", output: "Applied edit", collapsed: true },
    ],
    thinking: null,
    activity: null,
  });
  await sleep(200);
  emitText(FOLDER, "\n\n1. Extract `depositFiles` into its own module\n2. Move MIME validation to a shared utility\n\nDone!");
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
  broadcast("state", makeState(partialHistory, "idle"));
}

/** Current event with no prior text — tests commit logic with empty streamingText. */
async function scenarioCurrentNoPriorText(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Run the tests" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // Tool starts immediately — no text event before current
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Bash", status: "running", input: "npm test", output: null, collapsed: false }],
    thinking: null,
    activity: "tool",
  });
  await sleep(800);

  // Tool completes, text follows — current replaces current (commit check with empty streamingText)
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Bash", status: "completed", input: "npm test", output: "42 tests passed", collapsed: true }],
    thinking: null,
    activity: null,
  });
  await sleep(300);
  emitText(FOLDER, "All 42 tests passed.");
  await sleep(200);

  history.push({
    role: "assistant",
    content: "All 42 tests passed.",
    tool_calls: [{ name: "Bash", status: "completed", input: "npm test", output: "42 tests passed", collapsed: true }],
  });
  broadcast("state", makeState(history, "idle"));
}

/** Rapid current transitions — multiple tool start/complete in quick succession. */
async function scenarioRapidCurrent(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "Read all three config files" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // Three tools in rapid succession — each current should commit the previous
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Read", status: "running", input: "tsconfig.json", output: null, collapsed: false }],
    thinking: null,
    activity: "tool",
  });
  await sleep(200);
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [{ name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true }],
    thinking: null,
    activity: null,
  });
  await sleep(100);
  // Second tool — previous current had tool_calls, should commit
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [
      { name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true },
      { name: "Read", status: "running", input: "package.json", output: null, collapsed: false },
    ],
    thinking: null,
    activity: "tool",
  });
  await sleep(200);
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [
      { name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "package.json", output: "{...}", collapsed: true },
    ],
    thinking: null,
    activity: null,
  });
  await sleep(100);
  // Third tool
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [
      { name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "package.json", output: "{...}", collapsed: true },
      { name: "Read", status: "running", input: "vitest.config.ts", output: null, collapsed: false },
    ],
    thinking: null,
    activity: "tool",
  });
  await sleep(200);
  emitCurrent(FOLDER, {
    text: null,
    tool_calls: [
      { name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "package.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "vitest.config.ts", output: "{...}", collapsed: true },
    ],
    thinking: null,
    activity: null,
  });
  await sleep(200);

  // Text after all tools
  emitText(FOLDER, "Here are your three config files. The TypeScript config targets ES2022...");
  await sleep(200);

  history.push({
    role: "assistant",
    content: "Here are your three config files. The TypeScript config targets ES2022...",
    tool_calls: [
      { name: "Read", status: "completed", input: "tsconfig.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "package.json", output: "{...}", collapsed: true },
      { name: "Read", status: "completed", input: "vitest.config.ts", output: "{...}", collapsed: true },
    ],
  });
  broadcast("state", makeState(history, "idle"));
}

/** Text after state reset — verifies streamingText doesn't carry over. */
async function scenarioTextAfterReset(): Promise<void> {
  const history: MockMessage[] = [
    { role: "user", content: "First question" },
  ];

  broadcast("state", makeState(history, "idle"));
  await sleep(1000);

  // Turn 1: stream some text
  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "Here's my answer to the first question.");
  await sleep(300);

  // Turn 1 complete — state resets streamingText
  history.push({ role: "assistant", content: "Here's my answer to the first question." });
  broadcast("state", makeState(history, "idle"));
  await sleep(500);

  // Turn 2: new text arrives — should not include turn 1's text
  history.push({ role: "user", content: "Second question" });
  broadcast("state", makeState(history, "working"));
  await sleep(300);

  emitCurrent(FOLDER, { text: null, tool_calls: [], thinking: null, activity: "writing" });
  await sleep(200);
  emitText(FOLDER, "And here's the answer to the second question.");
  await sleep(300);

  history.push({ role: "assistant", content: "And here's the answer to the second question." });
  broadcast("state", makeState(history, "idle"));
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  baseline: scenarioBaseline,
  "mid-turn": scenarioMidTurn,
  reconnect: scenarioReconnect,
  "upload-race": scenarioUploadRace,
  "double-state": scenarioDoubleState,
  "current-no-text": scenarioCurrentNoPriorText,
  "rapid-current": scenarioRapidCurrent,
  "text-after-reset": scenarioTextAfterReset,
};

// -- HTTP server --

function serveFile(res: ServerResponse, filePath: string, mime?: string): void {
  try {
    const content = readFileSync(join(PROJECT_ROOT, filePath));
    const FALLBACK_MIME: Record<string, string> = {
      ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
      ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    };
    const contentType = mime || FALLBACK_MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
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

  // Static files — route + mime from bridge-logic's STATIC_FILES
  const staticEntry = STATIC_FILES[path];
  if (staticEntry) { serveFile(res, staticEntry.file, staticEntry.mime); return; }
  if (path.startsWith("/icon-")) { serveFile(res, path.slice(1)); return; }

  res.writeHead(404).end("Not found");
});

server.listen(PORT, () => {
  console.log(`[sim] Dupe simulator on http://localhost:${PORT}`);
  console.log(`[sim] Scenario: ${SCENARIO}`);
  console.log(`[sim] Available: ${Object.keys(SCENARIOS).join(", ")}`);
});
