/**
 * Pure functions extracted from bridge.ts for testability.
 *
 * This module contains the decision logic that doesn't need IO —
 * session resolution, path validation, arg construction, delta conflation.
 */

import { resolve, join } from "node:path";

// --- Configuration constants ---

export const KILL_ESCALATION_MS = 3_000; // SIGTERM → SIGKILL after 3 seconds

// Tools auto-approved via --allowed-tools. This is permissive by design —
// Task subagents bypass --allowed-tools entirely (CC #27099), so restricting
// the parent without restricting Task is security theater. We list everything
// explicitly instead of using --dangerously-skip-permissions so the posture
// is auditable and ready for upstream subagent propagation fixes (#20264).
const ALLOWED_TOOLS = [
  "Bash", "Read", "Edit", "Write", "Glob", "Grep",
  "WebSearch",
  "Task", "TaskOutput", "TaskStop",
  "Skill", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ToolSearch",
  "mcp__*",
];

// Tools hidden from the model entirely. WebFetch returns AI summaries not
// raw content (use curl via Bash instead). TodoWrite conflicts with bon.
const DISALLOWED_TOOLS = ["WebFetch", "TodoWrite", "NotebookEdit"];

export const CC_FLAGS = [
  "-p",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--replay-user-messages",
  "--allowed-tools",
  ALLOWED_TOOLS.join(","),
  "--disallowedTools",
  DISALLOWED_TOOLS.join(","),
  "--permission-mode",
  "default",
  "--append-system-prompt",
  "The user is on a mobile device using Guéridon. " +
    "When you use AskUserQuestion, it will return an error — this is expected. " +
    "The user sees your questions as tappable buttons and will respond with their selection " +
    "in their next message. Do not apologize for the error or retry the tool. " +
    "End your turn and wait for the user's response.",
];

// --- Session resolution ---

export interface SessionResolution {
  sessionId: string;
  resumable: boolean;
  /** True when reconnecting to an existing bridge session (multi-WS). */
  isReconnect: boolean;
}

/**
 * Decide how to connect a folder: reconnect to existing bridge session,
 * resume a paused CC session, or start fresh.
 *
 * Decision tree:
 * - Existing bridge session for folder → reconnect (multi-WS)
 * - CC session files + .exit marker for THAT session → fresh
 * - CC session files + handoff for THAT session → fresh (intentionally closed)
 * - CC session files (no matching close signal) → resume
 * - No session files → fresh
 *
 * Key: handoff/exit only block resume when they match the latest session.
 * A stale handoff from session N must not prevent resuming session N+1.
 */
export function resolveSessionForFolder(
  existingBridgeSession: { id: string; resumable: boolean } | null,
  latestSessionFile: { id: string } | null,
  handoffSessionId: string | null,
  hasExit: boolean,
  generateId: () => string,
): SessionResolution {
  // Multi-WS reconnect: another tab already connected this folder
  if (existingBridgeSession) {
    return {
      sessionId: existingBridgeSession.id,
      resumable: existingBridgeSession.resumable,
      isReconnect: true,
    };
  }

  // No session files on disk → fresh
  if (!latestSessionFile) {
    return {
      sessionId: generateId(),
      resumable: false,
      isReconnect: false,
    };
  }

  // .exit marker for this session → was deliberately closed
  if (hasExit) {
    return {
      sessionId: generateId(),
      resumable: false,
      isReconnect: false,
    };
  }

  // Handoff matches this session → was intentionally closed via /close
  if (handoffSessionId === latestSessionFile.id) {
    return {
      sessionId: generateId(),
      resumable: false,
      isReconnect: false,
    };
  }

  // Session exists, no matching close signal → resume
  return {
    sessionId: latestSessionFile.id,
    resumable: true,
    isReconnect: false,
  };
}

/**
 * Check if a handoff is stale: the session was resumed after the handoff was written.
 * Returns true if the handoff should be ignored (JSONL modified after handoff). (gdn-sekeca)
 */
export function isHandoffStale(
  handoffSessionId: string | null,
  handoffMtime: Date | null,
  sessionId: string | null,
  sessionMtime: Date | null,
): boolean {
  if (!handoffSessionId || !handoffMtime || !sessionId || !sessionMtime) return false;
  return handoffSessionId === sessionId && sessionMtime > handoffMtime;
}

// --- Path validation ---

/**
 * Validate that a folder path resolves to within the scan root.
 * Prevents directory traversal attacks.
 */
export function validateFolderPath(
  path: string,
  scanRoot: string,
): boolean {
  const normalized = resolve(path);
  return normalized.startsWith(scanRoot + "/");
}

// --- CC argument construction ---

/**
 * Build the CLI arguments for spawning a CC process.
 * Uses --resume for paused sessions, --session-id for fresh ones.
 */
export function buildCCArgs(
  sessionId: string,
  resume: boolean,
): string[] {
  return [
    ...CC_FLAGS,
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
}

// --- Session JSONL parsing ---

/**
 * Parse a CC session JSONL file into bridge-format messages for replay.
 *
 * JSONL format (per line):
 * - `type: "user"` — user messages. `content` is a string (text) or array (tool_result).
 *   Lines with `isMeta: true` are internal and should be skipped.
 * - `type: "assistant"` — assistant messages. `content` is always an array of blocks.
 *   Multiple lines can share the same `message.id` when a response has multiple content
 *   blocks (e.g. text + tool_use). These must be grouped and their content arrays merged.
 * - `type: "queue-operation"`, `"progress"`, `"system"` — bookkeeping, skip these.
 *
 * Returns serialized `{source:"cc", event}` strings matching the wire format that
 * `attachWsToSession` replays into `messageBuffer`.
 *
 * Appends a synthetic `result` event with the last assistant's usage data so the
 * adapter's `handleResult()` sets `_lastInputTokens` and the gauge works after replay.
 */
export function parseSessionJSONL(content: string): string[] {
  const lines = content.split("\n");
  const result: string[] = [];

  // Group assistant lines by message.id to merge content blocks
  let currentAssistantId: string | null = null;
  let currentAssistantMsg: any = null;
  let lastUsage: any = null;

  function flushAssistant() {
    if (currentAssistantMsg) {
      result.push(
        JSON.stringify({ source: "cc", event: { type: "assistant", message: currentAssistantMsg } }),
      );
      currentAssistantId = null;
      currentAssistantMsg = null;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip corrupted lines
    }

    if (parsed.type === "user") {
      // Skip meta messages (internal CC bookkeeping)
      if (parsed.isMeta) continue;
      const msg = parsed.message;
      if (!msg) continue;

      // Flush any pending assistant group before user message
      flushAssistant();

      result.push(
        JSON.stringify({ source: "cc", event: { type: "user", message: msg } }),
      );
    } else if (parsed.type === "assistant") {
      const msg = parsed.message;
      if (!msg) continue;

      const msgId = msg.id;
      if (msgId && msgId === currentAssistantId && currentAssistantMsg) {
        // Same message.id — merge content blocks
        currentAssistantMsg.content = [
          ...(currentAssistantMsg.content || []),
          ...(msg.content || []),
        ];
        // Update usage to latest (later lines may have more complete data)
        if (msg.usage) {
          currentAssistantMsg.usage = msg.usage;
          lastUsage = msg.usage;
        }
      } else {
        // New assistant message — flush previous and start new group
        flushAssistant();
        currentAssistantId = msgId || null;
        currentAssistantMsg = { ...msg };
        if (msg.usage) lastUsage = msg.usage;
      }
    }
    // Skip queue-operation, progress, system, and anything else
  }

  // Flush final assistant group
  flushAssistant();

  // Append synthetic result event with last usage so gauge works after replay
  if (lastUsage) {
    result.push(
      JSON.stringify({
        source: "cc",
        event: { type: "result", subtype: "success", result: { usage: lastUsage } },
      }),
    );
  }

  return result;
}

// --- Active process map ---

/** Minimal session shape needed for getActiveSessions. */
export interface SessionProcessInfo {
  folder: string;
  process: { exitCode: number | null } | null;
  turnInProgress: boolean;
  clientCount: number;
  contextPct: number | null;
}

/** Runtime session info for folder scanner. */
export interface ActiveSessionInfo {
  sessionId: string;
  activity: "working" | "waiting";
  contextPct: number | null;
}

/**
 * Build a map of folder path → session info for folders with active sessions.
 * A session is active if it has a running CC process OR connected browser clients.
 * Used by scanFolders to mark active folders with activity state.
 */
export function getActiveSessions(
  sessions: Map<string, SessionProcessInfo>,
): Map<string, ActiveSessionInfo> {
  const active = new Map<string, ActiveSessionInfo>();
  for (const [id, session] of sessions) {
    const hasProcess = session.process && session.process.exitCode === null;
    if (hasProcess || session.clientCount > 0) {
      active.set(session.folder, {
        sessionId: id,
        activity: hasProcess && session.turnInProgress ? "working" : "waiting",
        contextPct: session.contextPct,
      });
    }
  }
  return active;
}

// --- Conflation (tick-based coalescing of CC partial events) ---
//
// IMPORTANT ASSUMPTION: All three delta types (text_delta, input_json_delta,
// thinking) are APPEND-ONLY — each delta's payload is concatenated to the
// previous. The merge in buildMergedDelta relies on this: it produces one
// delta with the concatenated payload. If CC ever sends replacement or
// positional deltas, this merge would produce garbage. As of CC 2.1.37,
// all content_block_delta payloads are strictly additive.

export const CONFLATION_INTERVAL_MS = 250; // Flush merged deltas every 250ms (~4/sec)

/** Delta accumulation field mapping: CC delta type → which field holds the text. */
const DELTA_FIELDS: Record<string, string> = {
  text_delta: "text",
  input_json_delta: "partial_json",
  thinking: "thinking",
};

/** Info extracted from a content_block_delta event for conflation. */
export interface DeltaInfo {
  /** Map key: `${index}:${deltaType}` */
  key: string;
  index: number;
  deltaType: string;
  /** Field name within the delta object that carries the text payload. */
  field: string;
  /** The actual text/json payload from this delta. */
  payload: string;
}

/**
 * Check if a CC event is a user text echo from --replay-user-messages.
 * These are CC's echo of what the user sent — the bridge already buffers
 * user messages when receiving prompts, so echoes are redundant in the
 * replay buffer. Tool results (array content) are NOT echoes.
 */
export function isUserTextEcho(event: Record<string, unknown>): boolean {
  if (event.type !== "user") return false;
  const message = event.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") return false;
  // Local command output (e.g. /context, /cost) arrives as a user message with
  // string content wrapped in <local-command-stdout>. Not an echo — must be
  // buffered and forwarded to clients.
  if ((message.content as string).startsWith("<local-command-stdout>")) return false;
  return true;
}

/**
 * Check if a CC event is a content_block_delta (the high-frequency token stream).
 * These are the only events worth conflating — everything else is structural.
 */
export function isStreamDelta(event: Record<string, unknown>): boolean {
  if (event.type !== "stream_event") return false;
  const inner = event.event as Record<string, unknown> | undefined;
  return inner?.type === "content_block_delta";
}

/**
 * Extract conflation info from a content_block_delta event.
 * Returns null for non-delta events or unknown delta subtypes.
 */
export function extractDeltaInfo(event: Record<string, unknown>): DeltaInfo | null {
  if (!isStreamDelta(event)) return null;

  const inner = event.event as Record<string, unknown>;
  const index = inner.index as number;
  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta.type !== "string") return null;

  const field = DELTA_FIELDS[delta.type];
  if (!field) return null; // Unknown delta subtype — pass through immediately

  const payload = (delta[field] as string) ?? "";
  return { key: `${index}:${delta.type}`, index, deltaType: delta.type, field, payload };
}

// --- Local command recovery ---

/** Max lines from end of JSONL to search for local command output. */
export const LOCAL_CMD_TAIL_LINES = 5;

/**
 * Extract local command output from JSONL content.
 *
 * Searches the last LOCAL_CMD_TAIL_LINES lines for a user message containing
 * <local-command-stdout>. Returns the serialized bridge event, or null.
 *
 * Pure function — no IO. Caller reads the file and broadcasts the result.
 */
export function extractLocalCommandOutput(jsonlContent: string): string | null {
  const lines = jsonlContent.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - LOCAL_CMD_TAIL_LINES); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type !== "user") continue;
      const mc = parsed.message?.content;
      if (typeof mc !== "string" || !mc.includes("<local-command-stdout>")) continue;
      return JSON.stringify({
        source: "cc",
        event: { type: "user", message: parsed.message },
      });
    } catch {
      continue;
    }
  }
  return null;
}

/** Accumulated delta state for one content block index + delta type. */
export interface PendingDelta {
  index: number;
  deltaType: string;
  field: string;
  accumulated: string;
}

// -- Prompt coalescing --

export interface QueuedPrompt {
  text?: string;
  content?: unknown[];
}

/**
 * Coalesce multiple queued prompts into a single delivery.
 * Returns null if the queue is empty.
 *
 * Single message: passed through unchanged.
 * Multiple messages: concatenated with numbered markers so CC can distinguish them.
 */
export function coalescePrompts(queue: QueuedPrompt[]): QueuedPrompt | null {
  if (queue.length === 0) return null;
  if (queue.length === 1) return queue[0];

  // Extract text from each prompt (content arrays not yet supported for coalescing)
  const texts = queue.map((p) => p.text || "");
  const numbered = texts.map((t, i) => `[${i + 1}/${texts.length}] ${t}`);
  return { text: numbered.join("\n\n") };
}

/**
 * Build a merged content_block_delta event from accumulated delta text.
 * The adapter sees one delta with a larger chunk instead of many tiny ones.
 */
export function buildMergedDelta(pending: PendingDelta): Record<string, unknown> {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: pending.index,
      delta: { type: pending.deltaType, [pending.field]: pending.accumulated },
    },
  };
}
