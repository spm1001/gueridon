/**
 * Mock Bridge — WebSocket server for UX testing.
 * Plays back fixture CC events with realistic timing.
 *
 * Usage: npx tsx scripts/mock-bridge.ts
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load fixtures ---

const textFixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/text-response.json"), "utf-8"),
);
const thinkingFixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/thinking-response.json"), "utf-8"),
);
const toolFixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/tool-use-response.json"), "utf-8"),
);

console.log(
  `[mock] Loaded fixtures: text(${textFixture.events.length}), thinking(${thinkingFixture.events.length}), tool(${toolFixture.events.length})`,
);

// --- Fake folder list ---

const FAKE_FOLDERS = [
  {
    name: "gueridon",
    path: "/home/modha/Repos/gueridon",
    state: "active" as const,
    activity: "working" as const,
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    lastActive: new Date().toISOString(),
    handoffPurpose: null,
  },
  {
    name: "my-cool-project",
    path: "/home/modha/Repos/my-cool-project",
    state: "paused" as const,
    activity: null,
    sessionId: "660e8400-e29b-41d4-a716-446655440001",
    lastActive: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    handoffPurpose: null,
  },
  {
    name: "api-service",
    path: "/home/modha/Repos/api-service",
    state: "closed" as const,
    activity: null,
    sessionId: null,
    lastActive: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    handoffPurpose: "Finished auth refactor",
  },
  {
    name: "fresh-start",
    path: "/home/modha/Repos/fresh-start",
    state: "fresh" as const,
    activity: null,
    sessionId: null,
    lastActive: null,
    handoffPurpose: null,
  },
  {
    name: "data-pipeline",
    path: "/home/modha/Repos/data-pipeline",
    state: "active" as const,
    activity: "waiting" as const,
    sessionId: "770e8400-e29b-41d4-a716-446655440002",
    lastActive: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    handoffPurpose: null,
  },
];

// --- Demo scenario: multi-message sequence ---

const DEMO_MARKDOWN =
  "## Summary\n\nI've analyzed the project structure. Here's what I found:\n\n- **Package type:** ES Module\n- **Framework:** Lit + Vite\n- **Tests:** 322 passing\n\n### Key Files\n\n| File | Purpose |\n|------|--------|\n| `src/main.ts` | Entry point |\n| `server/bridge.ts` | WebSocket bridge |\n\n```typescript\n// Example from main.ts\nconst agent = new ClaudeCodeAgent();\nconst gi = new GueridonInterface();\n```\n\nEverything looks solid. Ready to proceed with the next step.";

function buildDemoEvents(): unknown[] {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const events: unknown[] = [];

  // System init
  events.push({
    type: "system",
    subtype: "init",
    cwd: "/home/modha/Repos/gueridon",
    session_id: sessionId,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    model: "claude-opus-4-6",
    permissionMode: "bypassPermissions",
    claude_code_version: "2.1.37",
  });

  // 1. Thinking block
  events.push({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        model: "claude-opus-4-6",
        id: "msg_demo_01",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 500, output_tokens: 1 },
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking:
          "The user wants me to analyze this project. Let me start by listing the files ",
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking:
          "and then reading the package.json to understand the dependencies and structure.",
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "EqoBCkgIAhgCIkC8sIZMBLVPMaDY07OmB",
      },
    },
  });
  events.push({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });

  // 2. Tool call: Bash `ls -la`
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_demo_bash", name: "Bash" },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: '"ls -la"',
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: ',"description":"List project files"}',
      },
    },
  });
  events.push({
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      id: "msg_demo_01",
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            "The user wants me to analyze this project. Let me start by listing the files and then reading the package.json to understand the dependencies and structure.",
          signature: "EqoBCkgIAhgCIkC8sIZMBLVPMaDY07OmB",
        },
        {
          type: "tool_use",
          id: "toolu_demo_bash",
          name: "Bash",
          input: { command: "ls -la", description: "List project files" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 500, output_tokens: 60 },
    },
    session_id: sessionId,
  });
  events.push({
    type: "stream_event",
    event: { type: "content_block_stop", index: 1 },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 60 },
    },
  });
  events.push({
    type: "stream_event",
    event: { type: "message_stop" },
  });

  // 3. Tool result for Bash
  events.push({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_demo_bash",
          type: "tool_result",
          content:
            "total 120\ndrwxr-xr-x  12 modha  staff   384 Feb 15 10:00 .\n-rw-r--r--   1 modha  staff  1234 Feb 15 09:55 package.json\n-rw-r--r--   1 modha  staff   456 Feb 15 09:50 tsconfig.json\ndrwxr-xr-x   8 modha  staff   256 Feb 15 09:45 src\ndrwxr-xr-x   4 modha  staff   128 Feb 15 09:40 server\ndrwxr-xr-x   3 modha  staff    96 Feb 15 09:35 scripts",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout:
        "total 120\ndrwxr-xr-x  12 modha  staff   384 Feb 15 10:00 .\n-rw-r--r--   1 modha  staff  1234 Feb 15 09:55 package.json\n-rw-r--r--   1 modha  staff   456 Feb 15 09:50 tsconfig.json\ndrwxr-xr-x   8 modha  staff   256 Feb 15 09:45 src\ndrwxr-xr-x   4 modha  staff   128 Feb 15 09:40 server\ndrwxr-xr-x   3 modha  staff    96 Feb 15 09:35 scripts",
      stderr: "",
      interrupted: false,
      isImage: false,
    },
  });

  // Second system init (tool result turn)
  events.push({
    type: "system",
    subtype: "init",
    cwd: "/home/modha/Repos/gueridon",
    session_id: sessionId,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    model: "claude-opus-4-6",
  });

  // 4. Second tool call: Read `package.json`
  events.push({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        model: "claude-opus-4-6",
        id: "msg_demo_02",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 800, output_tokens: 1 },
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_demo_read", name: "Read" },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"file_path":"package.json"}',
      },
    },
  });
  events.push({
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      id: "msg_demo_02",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_demo_read",
          name: "Read",
          input: { file_path: "package.json" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 800, output_tokens: 25 },
    },
    session_id: sessionId,
  });
  events.push({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 25 },
    },
  });
  events.push({
    type: "stream_event",
    event: { type: "message_stop" },
  });

  // 5. Tool result for Read
  events.push({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_demo_read",
          type: "tool_result",
          content:
            '{\n  "name": "gueridon",\n  "version": "0.1.0",\n  "type": "module",\n  "description": "Mobile web UI for Claude Code",\n  "dependencies": {\n    "lit": "^3.3.2",\n    "ws": "^8.19.0"\n  }\n}',
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout:
        '{\n  "name": "gueridon",\n  "version": "0.1.0",\n  "type": "module",\n  "description": "Mobile web UI for Claude Code",\n  "dependencies": {\n    "lit": "^3.3.2",\n    "ws": "^8.19.0"\n  }\n}',
      stderr: "",
      interrupted: false,
      isImage: false,
    },
  });

  // Third system init
  events.push({
    type: "system",
    subtype: "init",
    cwd: "/home/modha/Repos/gueridon",
    session_id: sessionId,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    model: "claude-opus-4-6",
  });

  // 6. Final text response with markdown, streamed in chunks
  events.push({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        model: "claude-opus-4-6",
        id: "msg_demo_03",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1200, output_tokens: 1 },
      },
    },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });

  // Stream the markdown in small chunks
  const chunks = [
    "## Summary\n\n",
    "I've analyzed the project structure. ",
    "Here's what I found:\n\n",
    "- **Package type:** ES Module\n",
    "- **Framework:** Lit + Vite\n",
    "- **Tests:** 322 passing\n\n",
    "### Key Files\n\n",
    "| File | Purpose |\n|------|--------|\n",
    "| `src/main.ts` | Entry point |\n",
    "| `server/bridge.ts` | WebSocket bridge |\n\n",
    "```typescript\n// Example from main.ts\n",
    "const agent = new ClaudeCodeAgent();\n",
    "const gi = new GueridonInterface();\n```\n\n",
    "Everything looks solid. ",
    "Ready to proceed with the next step.",
  ];
  for (const chunk of chunks) {
    events.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      },
    });
  }

  // Complete assistant before content_block_stop (matches real CC behavior)
  events.push({
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      id: "msg_demo_03",
      role: "assistant",
      content: [{ type: "text", text: DEMO_MARKDOWN }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 150 },
    },
    session_id: sessionId,
  });
  events.push({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  events.push({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 150 },
    },
  });
  events.push({
    type: "stream_event",
    event: { type: "message_stop" },
  });

  // 7. Result
  events.push({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 32456,
    duration_api_ms: 18200,
    num_turns: 3,
    result: DEMO_MARKDOWN,
    session_id: sessionId,
    total_cost_usd: 0.342,
    usage: {
      input_tokens: 1200,
      output_tokens: 235,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

  return events;
}

const demoEvents = buildDemoEvents();
console.log(`[mock] Built demo scenario: ${demoEvents.length} events`);

// --- Helpers ---

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayForEvent(event: unknown): number {
  const e = event as { type?: string; event?: { type?: string } };
  if (e.type === "stream_event") {
    const inner = e.event?.type;
    if (
      inner === "content_block_delta" ||
      inner === "content_block_start" ||
      inner === "content_block_stop"
    ) {
      return 100;
    }
  }
  return 500;
}

// --- Playback ---

interface PlaybackHandle {
  abort: () => void;
}

function playFixture(
  ws: WebSocket,
  events: unknown[],
  label: string,
): PlaybackHandle {
  let aborted = false;

  const run = async () => {
    console.log(`[mock] Playing "${label}" (${events.length} events)`);
    send(ws, { source: "bridge", type: "promptReceived" });
    await delay(200);

    for (const event of events) {
      if (aborted) {
        console.log(`[mock] Playback aborted for "${label}"`);
        return;
      }
      send(ws, { source: "cc", event });
      await delay(delayForEvent(event));
    }
    console.log(`[mock] Finished playing "${label}"`);
  };

  run();

  return {
    abort: () => {
      aborted = true;
    },
  };
}

// --- Fun names for createFolder ---

const FUN_NAMES = [
  "quantum-kitten",
  "velvet-thunder",
  "cosmic-pancake",
  "turbo-narwhal",
  "fuzzy-phoenix",
  "neon-cactus",
  "astral-waffle",
  "pixel-dragon",
];

// --- HTTP server ---

const SCREENSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshots");

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Upload page
  if (req.url === "/upload" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upload Screenshot</title>
  <style>
    body { font-family: system-ui; padding: 1rem; background: #111; color: #eee; text-align: center; }
    .drop { border: 2px dashed #555; border-radius: 12px; padding: 2rem; margin: 1rem 0; }
    .drop.over { border-color: #4f8; background: #1a2a1a; }
    input[type=file] { display: none; }
    label { display: inline-block; padding: 12px 24px; background: #333; border-radius: 8px; font-size: 1.1em; cursor: pointer; }
    .status { margin-top: 1rem; min-height: 2em; }
    .ok { color: #4f8; } .err { color: #f44; }
  </style>
</head>
<body>
  <h2>📸 Upload Screenshot</h2>
  <div class="drop" id="drop">
    <label for="file">Tap to pick image</label>
    <input type="file" id="file" accept="image/*" multiple>
    <p style="color:#888; margin-top:0.5rem">or drag & drop</p>
  </div>
  <div class="status" id="status"></div>
  <script>
    const drop = document.getElementById('drop');
    const file = document.getElementById('file');
    const status = document.getElementById('status');
    async function upload(f) {
      status.textContent = 'Uploading ' + f.name + '...';
      status.className = 'status';
      const form = new FormData();
      form.append('file', f);
      try {
        const r = await fetch('/upload', { method: 'POST', body: form });
        const j = await r.json();
        status.innerHTML += '<br><span class="ok">✓ ' + j.path + '</span>';
      } catch(e) {
        status.innerHTML += '<br><span class="err">✗ ' + e.message + '</span>';
      }
    }
    file.onchange = () => { for (const f of file.files) upload(f); };
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); for (const f of e.dataTransfer.files) upload(f); };
  </script>
</body>
</html>`);
    return;
  }

  // Upload handler
  if (req.url === "/upload" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // Parse multipart boundary
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No boundary" }));
        return;
      }
      const boundary = boundaryMatch[1];
      const parts = body.toString("binary").split("--" + boundary);
      for (const part of parts) {
        const filenameMatch = part.match(/filename="([^"]+)"/);
        if (!filenameMatch) continue;
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const fileData = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ""), "binary");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const ext = filenameMatch[1].split(".").pop() || "png";
        const filename = `screenshot-${timestamp}.${ext}`;
        const filepath = join(SCREENSHOTS_DIR, filename);
        writeFileSync(filepath, fileData);
        console.log(`[mock] 📸 Screenshot saved: ${filepath} (${fileData.length} bytes)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: filename, size: fileData.length }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No file found in upload" }));
    });
    return;
  }

  // Default status page
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html>
<html>
<head><title>Mock Bridge</title></head>
<body style="font-family: system-ui; padding: 2rem; background: #111; color: #eee;">
  <h1>🎭 Mock Bridge Running</h1>
  <p>Port 3001 — WebSocket + HTTP</p>
  <p><a href="/upload" style="color:#4f8">📸 Upload Screenshot</a></p>
</body>
</html>`);
});

// --- WebSocket server ---

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws: WebSocket) => {
  console.log("[mock] Client connected");
  let inSession = false;
  let currentPlayback: PlaybackHandle | null = null;

  // Start in lobby mode
  send(ws, { source: "bridge", type: "lobbyConnected" });
  console.log("[mock] → lobbyConnected");

  ws.on("message", (data) => {
    let msg: { type: string; text?: string; path?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log("[mock] Bad JSON:", data.toString());
      return;
    }

    console.log(`[mock] ← ${msg.type}${msg.text ? ` "${msg.text}"` : ""}${msg.path ? ` path=${msg.path}` : ""}`);

    switch (msg.type) {
      case "listFolders": {
        send(ws, {
          source: "bridge",
          type: "folderList",
          folders: FAKE_FOLDERS,
        });
        console.log(`[mock] → folderList (${FAKE_FOLDERS.length} folders)`);
        break;
      }

      case "connectFolder": {
        inSession = true;
        send(ws, {
          source: "bridge",
          type: "connected",
          sessionId: "mock-session-id",
          resumed: false,
        });
        console.log(`[mock] → connected (session: mock-session-id)`);
        break;
      }

      case "createFolder": {
        const name = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
        send(ws, {
          source: "bridge",
          type: "folderCreated",
          folder: {
            name,
            path: `/home/modha/Repos/${name}`,
            state: "fresh",
            activity: null,
            sessionId: null,
            lastActive: null,
            handoffPurpose: null,
          },
        });
        console.log(`[mock] → folderCreated "${name}"`);
        break;
      }

      case "prompt": {
        if (!inSession) {
          // Auto-connect for convenience in mock mode
          inSession = true;
          send(ws, {
            source: "bridge",
            type: "connected",
            sessionId: "mock-session-id",
            resumed: false,
          });
          console.log("[mock] → auto-connected (prompt without connectFolder)");
        }

        // Stop any in-progress playback
        currentPlayback?.abort();

        const text = (msg.text ?? "").toLowerCase();

        if (text.includes("demo")) {
          currentPlayback = playFixture(ws, demoEvents, "demo");
        } else if (text.includes("tool")) {
          currentPlayback = playFixture(ws, toolFixture.events, "tool-use");
        } else if (text.includes("think")) {
          currentPlayback = playFixture(
            ws,
            thinkingFixture.events,
            "thinking",
          );
        } else {
          currentPlayback = playFixture(ws, textFixture.events, "text");
        }
        break;
      }

      case "abort": {
        if (currentPlayback) {
          currentPlayback.abort();
          currentPlayback = null;
          console.log("[mock] Playback aborted by client");
        }
        break;
      }

      default: {
        console.log(`[mock] Unknown message type: ${msg.type}`);
      }
    }
  });

  ws.on("close", () => {
    console.log("[mock] Client disconnected");
    currentPlayback?.abort();
  });
});

httpServer.listen(3001, () => {
  console.log("[mock] 🎭 Mock bridge running on http://localhost:3001");
  console.log("[mock] Prompt keywords: 'tool', 'think', 'demo', or anything else for plain text");
});
