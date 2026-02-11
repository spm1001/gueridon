#!/usr/bin/env npx tsx
/**
 * gdn — CLI bridge client for Guéridon
 *
 * Connects to the Guéridon bridge over WebSocket and provides a terminal
 * interface to Claude Code running on Kube. Same protocol as the web client,
 * different renderer.
 *
 * Usage:
 *   npx tsx cli/gdn.ts [bridge-url]
 *   npx tsx cli/gdn.ts ws://kube:3001
 */

import WebSocket from "ws";
import * as readline from "node:readline";

// --- Config ---

const BRIDGE_URL = process.argv[2] || process.env.GDN_BRIDGE_URL || "ws://localhost:3001";

// --- ANSI helpers ---

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

// --- State ---

let sessionId: string | null = null;
let isStreaming = false;
let currentText = ""; // accumulates streamed text for the current response
let lastInputTokens = 0;
let contextWindow = 200_000; // CC default
let replayingHistory = false;
let rl: readline.Interface;
let ws: WebSocket;

// --- Context gauge ---

function updateUsage(usage: any) {
  if (!usage) return;
  // Total input context = input_tokens + cache_read + cache_creation
  const total =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  if (total > 0) lastInputTokens = total;
}

function gauge(): string {
  if (lastInputTokens === 0) return "";
  const pct = Math.round((lastInputTokens / contextWindow) * 100);
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  let color = GREEN;
  if (pct >= 90) color = RED;
  else if (pct >= 75) color = YELLOW;

  const bar = color + "█".repeat(filled) + DIM + "░".repeat(empty) + RESET;
  return ` ${bar} ${color}${pct}%${RESET}`;
}

// --- Prompt ---

function showPrompt() {
  const g = gauge();
  const status = g ? `${DIM}───${RESET}${g} ${DIM}───${RESET}\n` : "";
  process.stdout.write(`${status}${CYAN}>${RESET} `);
}

// --- Message handlers ---

function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "lobbyConnected":
      // Request folder list
      ws.send(JSON.stringify({ type: "listFolders" }));
      break;

    case "folderList":
      showFolderPicker(msg.folders);
      break;

    case "connected":
      sessionId = msg.sessionId;
      const mode = msg.resumed ? "(resuming)" : "(fresh)";
      console.log(`\n${GREEN}Connected${RESET} ${mode} session ${DIM}${sessionId}${RESET}\n`);
      showPrompt();
      break;

    case "promptReceived":
      // Bridge got our prompt, CC is thinking
      break;

    case "error":
      console.error(`\n${RED}Bridge error:${RESET} ${msg.error}`);
      if (!isStreaming) showPrompt();
      break;

    case "processExit":
      console.log(`\n${DIM}CC process exited (code ${msg.code})${RESET}`);
      isStreaming = false;
      showPrompt();
      break;

    case "historyStart":
      console.log(`${DIM}Replaying session history...${RESET}`);
      replayingHistory = true;
      break;

    case "historyEnd":
      replayingHistory = false;
      break;
  }
}

function handleCCEvent(event: any) {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        // Could extract model info, tools list etc
      }
      break;

    case "assistant": {
      updateUsage(event.message?.usage);
      break;
    }

    case "stream_event": {
      // CC stream events have the actual event data in event.event
      handleStreamEvent(event.event);
      break;
    }

    case "result": {
      isStreaming = false;
      updateUsage(event.usage);
      // End current streaming line
      if (currentText.length > 0) {
        process.stdout.write("\n");
        currentText = "";
      }
      console.log(""); // blank line after response
      showPrompt();
      break;
    }

    case "user": {
      // Replayed user message (from --replay-user-messages)
      break;
    }
  }
}

function handleStreamEvent(se: any) {
  if (!se) return;

  switch (se.type) {
    case "message_start":
      isStreaming = true;
      currentText = "";
      break;

    case "content_block_start": {
      const block = se.content_block;
      if (block?.type === "tool_use") {
        if (currentText.length > 0) {
          process.stdout.write("\n");
          currentText = "";
        }
        process.stdout.write(`\n${DIM}┌ ${block.name}${RESET}`);
      } else if (block?.type === "thinking") {
        if (currentText.length > 0) {
          process.stdout.write("\n");
          currentText = "";
        }
        process.stdout.write(`${MAGENTA}`);
      }
      break;
    }

    case "content_block_delta": {
      const delta = se.delta;
      if (delta?.type === "text_delta" && delta.text) {
        process.stdout.write(delta.text);
        currentText += delta.text;
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        process.stdout.write(`${DIM}.${RESET}`);
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        process.stdout.write(`${MAGENTA}${delta.thinking}${RESET}`);
      }
      break;
    }

    case "content_block_stop":
      break;

    case "message_delta": {
      updateUsage(se.usage);
      break;
    }

    case "message_stop":
      break;
  }
}

// --- Folder picker ---

function showFolderPicker(folders: any[]) {
  console.log(`\n${BOLD}Pick a folder:${RESET}\n`);

  // Sort: active first, then paused, then fresh
  const order = { active: 0, paused: 1, closed: 2, fresh: 3 };
  const sorted = [...folders].sort(
    (a, b) => (order[a.state as keyof typeof order] ?? 3) - (order[b.state as keyof typeof order] ?? 3),
  );

  sorted.forEach((f, i) => {
    const stateIcon =
      f.state === "active" ? `${GREEN}●${RESET}` :
      f.state === "paused" ? `${YELLOW}●${RESET}` :
      f.state === "closed" ? `${BLUE}●${RESET}` :
      `${DIM}○${RESET}`;

    const purpose = f.handoffPurpose ? ` ${DIM}— ${f.handoffPurpose.slice(0, 60)}${RESET}` : "";
    console.log(`  ${DIM}${(i + 1).toString().padStart(2)}${RESET} ${stateIcon} ${f.name}${purpose}`);
  });

  console.log("");
  process.stdout.write(`${CYAN}#>${RESET} `);

  // Wait for number input
  const handler = (line: string) => {
    const choice = parseInt(line.trim(), 10);
    if (choice >= 1 && choice <= sorted.length) {
      const folder = sorted[choice - 1];
      console.log(`${DIM}Connecting to ${folder.path}...${RESET}`);
      ws.send(JSON.stringify({ type: "connectFolder", path: folder.path }));
      rl.removeListener("line", handler);
      setupPromptLoop();
    } else {
      console.log(`${RED}Pick 1-${sorted.length}${RESET}`);
      process.stdout.write(`${CYAN}#>${RESET} `);
    }
  };

  rl.on("line", handler);
}

// --- Prompt loop ---

function setupPromptLoop() {
  rl.on("line", (line: string) => {
    const text = line.trim();
    if (!text) {
      showPrompt();
      return;
    }

    if (text === "/quit" || text === "/exit") {
      console.log(`${DIM}Bye.${RESET}`);
      ws.close();
      process.exit(0);
    }

    if (isStreaming) {
      console.log(`${DIM}(CC is still responding — wait for it to finish)${RESET}`);
      return;
    }

    ws.send(JSON.stringify({ type: "prompt", text }));
  });
}

// --- Main ---

function connect() {
  console.log(`${DIM}Connecting to ${BRIDGE_URL}...${RESET}`);

  ws = new WebSocket(BRIDGE_URL);

  ws.on("open", () => {
    console.log(`${GREEN}Connected to bridge${RESET}`);
  });

  ws.on("message", (data: WebSocket.Data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.source === "bridge") {
      handleBridgeMessage(msg);
    } else if (msg.source === "cc") {
      if (!replayingHistory) {
        handleCCEvent(msg.event);
      } else {
        // During replay, just extract usage for gauge
        if (msg.event?.type === "result") {
          updateUsage(msg.event.usage);
        }
      }
    }
  });

  ws.on("close", () => {
    console.log(`\n${RED}Disconnected from bridge${RESET}`);
    process.exit(1);
  });

  ws.on("error", (err: Error) => {
    console.error(`${RED}WebSocket error:${RESET} ${err.message}`);
    process.exit(1);
  });
}

// --- Entry point ---

rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY ?? false,
});

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log(`\n${DIM}Interrupted${RESET}`);
  if (ws) ws.close();
  process.exit(0);
});

connect();
