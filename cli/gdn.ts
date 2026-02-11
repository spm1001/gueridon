#!/usr/bin/env npx tsx
/**
 * gdn — CLI bridge client for Guéridon
 *
 * Connects to the Guéridon bridge over WebSocket and provides a terminal
 * interface to Claude Code running on Kube. Same protocol as the web client,
 * different renderer.
 *
 * Architecture: bridge-client.ts handles protocol/state and emits semantic
 * callbacks. This file is purely rendering + input — replaceable by a TUI
 * without touching the protocol layer.
 *
 * Usage:
 *   npx tsx cli/gdn.ts [bridge-url]
 *   npx tsx cli/gdn.ts ws://kube:3001
 */

import * as readline from "node:readline";
import { BridgeClient, type FolderInfo, type AskUserOption, type UsageInfo } from "./bridge-client.js";

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// --- State (rendering only) ---

let currentText = "";
let promptLoopActive = false;
let pendingAskUser: { question: string; options: AskUserOption[] } | null = null;
let lastUsage: UsageInfo = { inputTokens: 0, contextWindow: 200_000, percent: 0 };

// --- Readline ---

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY ?? false,
});

// --- Bridge client ---

const client = new BridgeClient({
  url: BRIDGE_URL,
  callbacks: {
    // --- Connection lifecycle ---

    onFolderList(folders: FolderInfo[]) {
      showFolderPicker(folders);
    },

    onConnected(sessionId: string, resumed: boolean) {
      const mode = resumed ? "(resuming)" : "(fresh)";
      console.log(`\n${GREEN}Connected${RESET} ${mode} session ${DIM}${sessionId}${RESET}\n`);
      showPrompt();
    },

    onError(error: string) {
      console.error(`\n${RED}Bridge error:${RESET} ${error}`);
      if (!client.isStreaming) showPrompt();
    },

    onProcessExit(code: number) {
      console.log(`\n${DIM}CC process exited (code ${code})${RESET}`);
      showPrompt();
    },

    onDisconnect() {
      if (!client.connectedFolder) {
        console.log(`\n${RED}Disconnected from bridge${RESET}`);
        process.exit(1);
      }
      console.log(`\n${RED}Disconnected — gave up reconnecting${RESET}`);
      process.exit(1);
    },

    onReconnecting(attempt: number, delaySec: number) {
      console.log(`${YELLOW}Disconnected — reconnecting in ${delaySec}s…${RESET}`);
    },

    // --- Live streaming ---

    onStreamStart() {
      currentText = "";
    },

    onStreamEnd() {
      if (currentText.length > 0) {
        process.stdout.write("\n");
        currentText = "";
      }
      console.log("");

      if (pendingAskUser) {
        showAskUserQuestion();
      } else {
        showPrompt();
      }
    },

    onText(text: string) {
      process.stdout.write(text);
      currentText += text;
    },

    onThinking(text: string) {
      process.stdout.write(`${MAGENTA}${text}${RESET}`);
    },

    onToolStart(name: string) {
      if (currentText.length > 0) {
        process.stdout.write("\n");
        currentText = "";
      }
      process.stdout.write(`\n${DIM}┌ ${YELLOW}${name}${RESET}`);
    },

    onToolInput(name: string, args: Record<string, any>) {
      const summary = summarizeToolInput(name, args);
      process.stdout.write(`\n${DIM}│ ${summary}${RESET}\n`);
    },

    onToolResult(name: string, output: string, isError: boolean) {
      const icon = isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;

      if (output.length > 0) {
        const lines = output.split("\n");
        const maxLines = 6;
        const shown = lines.slice(0, maxLines);
        for (const line of shown) {
          process.stdout.write(`${DIM}│ ${truncate(line, 120)}${RESET}\n`);
        }
        if (lines.length > maxLines) {
          process.stdout.write(`${DIM}│ … (${lines.length - maxLines} more lines)${RESET}\n`);
        }
      }

      console.log(`${DIM}└ ${icon} ${name}${RESET}`);
    },

    onAskUser(question: string, options: AskUserOption[]) {
      pendingAskUser = { question, options };
    },

    // --- Replay ---

    onReplayStart() {
      console.log(`${DIM}─── session history ───${RESET}`);
    },

    onReplayEnd() {
      console.log(`${DIM}─── end history ───${RESET}\n`);
    },

    onReplayUser(text: string) {
      console.log(`${CYAN}> ${truncate(text, 120)}${RESET}`);
    },

    onReplayAssistant(text: string, toolCount: number) {
      if (text) {
        console.log(`${DIM}  ${truncate(text, 120)}${RESET}`);
      }
      if (toolCount > 0) {
        console.log(`${DIM}  [${toolCount} tool call${toolCount > 1 ? "s" : ""}]${RESET}`);
      }
    },

    // --- Status ---

    onUsageUpdate(usage: UsageInfo) {
      lastUsage = usage;
    },
  },
});

// --- Rendering helpers ---

function gauge(): string {
  if (lastUsage.inputTokens === 0) return "";
  const pct = lastUsage.percent;
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  let color = GREEN;
  if (pct >= 90) color = RED;
  else if (pct >= 75) color = YELLOW;

  const bar = color + "█".repeat(filled) + DIM + "░".repeat(empty) + RESET;
  return ` ${bar} ${color}${pct}%${RESET}`;
}

function showPrompt() {
  const g = gauge();
  const status = g ? `${DIM}───${RESET}${g} ${DIM}───${RESET}\n` : "";
  process.stdout.write(`${status}${CYAN}>${RESET} `);
}

function summarizeToolInput(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    case "Bash":
      return args.command ? truncate(args.command, 120) : "…";
    case "Read":
      return args.file_path || "…";
    case "Write":
      return args.file_path
        ? `${args.file_path} (${(args.content?.length || 0)} chars)`
        : "…";
    case "Edit":
      return args.file_path || "…";
    case "Grep":
      return args.pattern
        ? `/${args.pattern}/${args.path ? ` in ${args.path}` : ""}`
        : "…";
    case "Glob":
      return args.pattern || "…";
    case "Task":
      return args.description || "…";
    default: {
      const vals = Object.values(args).filter((v) => typeof v === "string") as string[];
      return vals.length > 0 ? truncate(vals[0], 80) : truncate(JSON.stringify(args), 80);
    }
  }
}

function showAskUserQuestion() {
  if (!pendingAskUser) return;
  const q = pendingAskUser;
  console.log(`\n${BOLD}${q.question}${RESET}\n`);
  q.options.forEach((opt, i) => {
    console.log(`  ${CYAN}${i + 1}${RESET} ${opt.label}`);
    if (opt.description) {
      console.log(`    ${DIM}${opt.description}${RESET}`);
    }
  });
  console.log("");
  process.stdout.write(`${CYAN}#>${RESET} `);
}

// --- Folder picker ---

function showFolderPicker(folders: FolderInfo[]) {
  console.log(`\n${BOLD}Pick a folder:${RESET}\n`);

  const order = { active: 0, paused: 1, closed: 2, fresh: 3 };
  const sorted = [...folders].sort(
    (a, b) =>
      (order[a.state as keyof typeof order] ?? 3) -
      (order[b.state as keyof typeof order] ?? 3),
  );

  sorted.forEach((f, i) => {
    const stateIcon =
      f.state === "active"
        ? `${GREEN}●${RESET}`
        : f.state === "paused"
          ? `${YELLOW}●${RESET}`
          : f.state === "closed"
            ? `${BLUE}●${RESET}`
            : `${DIM}○${RESET}`;

    const purpose = f.handoffPurpose
      ? ` ${DIM}— ${f.handoffPurpose.slice(0, 60)}${RESET}`
      : "";
    console.log(
      `  ${DIM}${(i + 1).toString().padStart(2)}${RESET} ${stateIcon} ${f.name}${purpose}`,
    );
  });

  console.log("");
  process.stdout.write(`${CYAN}#>${RESET} `);

  const handler = (line: string) => {
    const choice = parseInt(line.trim(), 10);
    if (choice >= 1 && choice <= sorted.length) {
      const folder = sorted[choice - 1];
      console.log(`${DIM}Connecting to ${folder.path}...${RESET}`);
      client.selectFolder(folder.path);
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
  if (promptLoopActive) return;
  promptLoopActive = true;

  rl.on("line", (line: string) => {
    const text = line.trim();
    if (!text) {
      showPrompt();
      return;
    }

    if (text === "/quit" || text === "/exit") {
      console.log(`${DIM}Bye.${RESET}`);
      client.dispose();
      process.exit(0);
    }

    if (client.isStreaming) {
      console.log(`${DIM}(CC is still responding — wait for it to finish)${RESET}`);
      return;
    }

    // Handle AskUserQuestion selection
    if (pendingAskUser) {
      const choice = parseInt(text, 10);
      if (choice >= 1 && choice <= pendingAskUser.options.length) {
        const selected = pendingAskUser.options[choice - 1];
        pendingAskUser = null;
        client.sendPrompt(selected.label);
      } else {
        // Freeform "Other" response
        pendingAskUser = null;
        client.sendPrompt(text);
      }
      return;
    }

    client.sendPrompt(text);
  });
}

// --- Signal handling ---

rl.on("close", () => {
  console.log(`\n${DIM}Bye.${RESET}`);
  client.dispose();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (client.isStreaming) {
    client.sendAbort();
    process.stdout.write(`\n${YELLOW}Aborting…${RESET}\n`);
  } else {
    console.log(`\n${DIM}Bye.${RESET}`);
    client.dispose();
    process.exit(0);
  }
});

// --- Start ---

console.log(`${DIM}Connecting to ${BRIDGE_URL}...${RESET}`);
client.connect();
