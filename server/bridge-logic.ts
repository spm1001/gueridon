/**
 * Pure functions extracted from bridge.ts for testability.
 *
 * Bridge.ts is hard to unit test because it creates a WebSocketServer at
 * module scope. This module contains the decision logic that doesn't need
 * IO — session resolution, path validation, arg construction.
 */

import { resolve, join, extname } from "node:path";

// --- Configuration constants ---

export const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "", 10) || 5 * 60 * 1000; // 5 minutes
export const MAX_IDLE_MS = parseInt(process.env.MAX_IDLE_MS || "", 10) || 30 * 60 * 1000; // 30 minutes — absolute cap
export const STALE_OUTPUT_MS = parseInt(process.env.STALE_OUTPUT_MS || "", 10) || 10 * 60 * 1000; // 10 minutes — stdout silence → stuck
export const IDLE_RECHECK_MS = 30_000; // 30 seconds between guard rechecks
export const PING_INTERVAL_MS = 30_000; // 30 seconds
export const PONG_TIMEOUT_MS = 30_000; // 30 seconds — generous for DERP relay on cellular
export const KILL_ESCALATION_MS = 3_000; // SIGTERM → SIGKILL after 3 seconds
export const EARLY_EXIT_MS = 2_000; // Process dying within 2s = flag/version problem

export const CC_FLAGS = [
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
  "--append-system-prompt",
  "The user is on a mobile device using Guéridon. " +
    "When you use AskUserQuestion, it will return an error — this is expected. " +
    "The user sees your questions as tappable buttons and will respond with their selection " +
    "in their next message. Do not apologize for the error or retry the tool. " +
    "End your turn and wait for the user's response.",
];

// --- Static file serving ---

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

/** Result of resolving a static file request. */
export type StaticFileResult =
  | { ok: true; filePath: string; mime: string; cache: boolean }
  | { ok: false; status: 403 | 404 };

/**
 * Resolve a URL pathname to a static file path with security checks.
 *
 * Pure function — no IO. Caller handles readFile and HTTP response.
 *
 * - SPA fallback: extensionless paths (including "/") → index.html
 * - Path traversal guard: resolved path must be within distDir
 * - MIME lookup with fallback to application/octet-stream
 * - Cache flag for /assets/ paths (Vite hashed, immutable)
 */
export function resolveStaticFile(
  pathname: string,
  distDir: string,
): StaticFileResult {
  // SPA fallback: extensionless paths serve index.html
  if (pathname === "/" || !pathname.includes(".")) {
    pathname = "/index.html";
  }

  const filePath = join(distDir, pathname);
  // Path traversal guard
  if (!filePath.startsWith(distDir)) {
    return { ok: false, status: 403 };
  }

  const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  const cache = pathname.startsWith("/assets/");
  return { ok: true, filePath, mime, cache };
}

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
 * This encodes the critical decision tree:
 * - Existing bridge session for folder → reconnect (multi-WS)
 * - CC session files + no handoff → resume (was paused/abandoned)
 * - Handoff exists → fresh session (was intentionally closed)
 * - Neither → fresh session
 *
 * The resume bug from session 8: connectFolder was resuming closed sessions
 * because it only checked for session files, not handoffs. The `hasHandoff`
 * parameter fixes this.
 */
export function resolveSessionForFolder(
  existingBridgeSession: { id: string; resumable: boolean } | null,
  latestSessionFile: { id: string } | null,
  hasHandoff: boolean,
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

  // Paused: CC session exists but wasn't deliberately closed → resume
  if (latestSessionFile && !hasHandoff && !hasExit) {
    return {
      sessionId: latestSessionFile.id,
      resumable: true,
      isReconnect: false,
    };
  }

  // Closed (handoff or .exit marker) or fresh (no session files) → new session
  return {
    sessionId: generateId(),
    resumable: false,
    isReconnect: false,
  };
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

/** Minimal session shape needed for getActiveProcesses. */
export interface SessionProcessInfo {
  folder: string;
  process: { exitCode: number | null } | null;
}

/**
 * Build a map of folder path → session ID for folders with running CC processes.
 * Used by scanFolders to mark active folders.
 */
export function getActiveProcesses(
  sessions: Map<string, SessionProcessInfo>,
): Map<string, string> {
  const active = new Map<string, string>();
  for (const [id, session] of sessions) {
    if (session.process && session.process.exitCode === null) {
      active.set(session.folder, id);
    }
  }
  return active;
}

// --- Idle guards ---

/** Session state visible to idle guards. */
export interface IdleSessionState {
  turnInProgress: boolean;
  lastOutputTime: number | null;
}

/** A guard that can keep a session alive during idle checks. */
export interface IdleGuard {
  name: string;
  shouldKeepAlive(
    state: IdleSessionState,
    now?: number,
  ): { keep: boolean; reason?: string; recheckMs?: number };
}

/** Action returned by checkIdle — pure, no side effects. */
export type IdleAction =
  | { action: "kill"; reason: string }
  | {
      action: "recheck";
      delayMs: number;
      guardDeferred: boolean;
      reason: string;
    };

/**
 * Decide whether to kill an idle session or recheck later.
 *
 * Pure function — takes state, returns an action. Caller handles side effects.
 *
 * Flow:
 * 1. Safety cap exceeded → kill (inviolable)
 * 2. Any guard says keepAlive → recheck (guard is deferred)
 * 3. Guard WAS deferred last check but isn't now → grace period (CC just finished)
 * 4. Nothing keeping alive, grace elapsed → kill
 */
export function checkIdle(
  idleStart: number,
  guardWasDeferred: boolean,
  guards: IdleGuard[],
  sessionState: IdleSessionState,
  now: number = Date.now(),
): IdleAction {
  // Safety cap — absolute maximum since client disconnect
  if (now - idleStart > MAX_IDLE_MS) {
    return { action: "kill", reason: "safety cap exceeded" };
  }

  // Consult guards
  for (const guard of guards) {
    const result = guard.shouldKeepAlive(sessionState, now);
    if (result.keep) {
      return {
        action: "recheck",
        delayMs: result.recheckMs ?? IDLE_RECHECK_MS,
        guardDeferred: true,
        reason: `kept alive by ${guard.name}: ${result.reason}`,
      };
    }
  }

  // No guard keeping alive. Did a guard JUST stop deferring?
  // If so, CC transitioned from working → idle. Grant a grace period
  // (full idle countdown) before killing.
  if (guardWasDeferred) {
    return {
      action: "recheck",
      delayMs: IDLE_TIMEOUT_MS,
      guardDeferred: false,
      reason: "grace period — CC finished working, restarting idle countdown",
    };
  }

  // Nothing keeping alive, no grace period pending — kill
  return { action: "kill", reason: "idle timeout" };
}

/**
 * Create an ActiveTurnGuard that keeps sessions alive when CC is mid-turn.
 *
 * Two signals:
 * - Protocol state: turnInProgress (prompt sent, no result yet)
 * - Staleness: stdout has produced output within staleThresholdMs
 *
 * If mid-turn but no output for staleThresholdMs, declines to keep alive
 * (CC is likely stuck). Safety cap provides the backstop.
 */
export function createActiveTurnGuard(
  staleThresholdMs: number = STALE_OUTPUT_MS,
): IdleGuard {
  return {
    name: "active-turn",
    shouldKeepAlive(
      state: IdleSessionState,
      now: number = Date.now(),
    ) {
      if (!state.turnInProgress) {
        return { keep: false };
      }

      // Mid-turn — but is CC actually making progress?
      if (
        state.lastOutputTime !== null &&
        now - state.lastOutputTime > staleThresholdMs
      ) {
        return { keep: false, reason: "mid-turn but stale — likely stuck" };
      }

      return {
        keep: true,
        reason: "CC is mid-turn",
        recheckMs: IDLE_RECHECK_MS,
      };
    },
  };
}

/** Default guard set. Extensible — add guards to this array. */
export const DEFAULT_IDLE_GUARDS: IdleGuard[] = [
  createActiveTurnGuard(),
];

// --- Conflation (tick-based coalescing of CC partial events) ---
//
// IMPORTANT ASSUMPTION: All three delta types (text_delta, input_json_delta,
// thinking) are APPEND-ONLY — each delta's payload is concatenated to the
// previous. The merge in buildMergedDelta relies on this: it produces one
// delta with the concatenated payload. If CC ever sends replacement or
// positional deltas, this merge would produce garbage. As of CC 2.1.37,
// all content_block_delta payloads are strictly additive.

export const CONFLATION_INTERVAL_MS = 250; // Flush merged deltas every 250ms (~4/sec)
export const MESSAGE_BUFFER_CAP = 10_000; // Max events in replay buffer
export const BACKPRESSURE_THRESHOLD = 64 * 1024; // Skip delta sends when ws.bufferedAmount exceeds 64KB

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

/** Exit commands that the bridge intercepts before forwarding to CC. */
const EXIT_COMMANDS = new Set(["/exit", "/quit"]);

/**
 * Check if a prompt is an exit command (/exit or /quit).
 * CC's /exit is REPL-only — in -p --stream-json mode it returns
 * "Unknown skill: exit". The bridge intercepts these and handles
 * session close at the protocol level.
 */
export function isExitCommand(text: string): boolean {
  return EXIT_COMMANDS.has(text.trim().toLowerCase());
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
  return typeof message?.content === "string";
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

/** Accumulated delta state for one content block index + delta type. */
export interface PendingDelta {
  index: number;
  deltaType: string;
  field: string;
  accumulated: string;
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
