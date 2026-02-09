/**
 * Pure functions extracted from bridge.ts for testability.
 *
 * Bridge.ts is hard to unit test because it creates a WebSocketServer at
 * module scope. This module contains the decision logic that doesn't need
 * IO — session resolution, path validation, arg construction.
 */

import { resolve } from "node:path";

// --- Configuration constants ---

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const PING_INTERVAL_MS = 30_000; // 30 seconds
export const PONG_TIMEOUT_MS = 10_000; // 10 seconds to respond
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

  // Paused: CC session exists but wasn't closed → resume
  if (latestSessionFile && !hasHandoff) {
    return {
      sessionId: latestSessionFile.id,
      resumable: true,
      isReconnect: false,
    };
  }

  // Closed (handoff exists) or fresh (no session files) → new session
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

// --- Active process map ---

/** Minimal session shape needed for getActiveProcesses. */
export interface SessionProcessInfo {
  folder: string | null;
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
    if (session.folder && session.process && session.process.exitCode === null) {
      active.set(session.folder, id);
    }
  }
  return active;
}
