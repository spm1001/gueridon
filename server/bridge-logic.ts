/**
 * Pure functions extracted from bridge.ts for testability.
 *
 * Bridge.ts is hard to unit test because it creates a WebSocketServer at
 * module scope. This module contains the decision logic that doesn't need
 * IO — session resolution, path validation, arg construction.
 */

import { resolve } from "node:path";

// --- Configuration constants ---

export const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "", 10) || 5 * 60 * 1000; // 5 minutes
export const MAX_IDLE_MS = parseInt(process.env.MAX_IDLE_MS || "", 10) || 30 * 60 * 1000; // 30 minutes — absolute cap
export const STALE_OUTPUT_MS = parseInt(process.env.STALE_OUTPUT_MS || "", 10) || 10 * 60 * 1000; // 10 minutes — stdout silence → stuck
export const IDLE_RECHECK_MS = 30_000; // 30 seconds between guard rechecks
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
