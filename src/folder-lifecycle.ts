/**
 * Folder lifecycle state machine — pure functions, no side effects.
 *
 * Replaces the pendingFolderConnect / deferredFolderPath flags in main.ts
 * with typed phases and explicit transitions. Effects are data (instructions),
 * not side effects — main.ts interprets them.
 *
 * The flash bug (gdn-jebudo) is structurally prevented: session_started
 * in the "browsing" phase is a no-op (no close_dialog effect emitted).
 */

import type { FolderInfo } from "./ws-transport.js";

// --- Phases ---

export type FolderPhase =
  | { phase: "idle" }
  | { phase: "browsing"; folders: FolderInfo[] }
  | { phase: "switching"; folderPath: string; folderName: string }
  | { phase: "connecting"; folderPath: string; folderName: string; retries: number };

// --- Events ---

export const MAX_CONNECT_RETRIES = 3;

export type FolderEvent =
  | { type: "open_requested"; cachedFolders?: FolderInfo[] }
  | { type: "folder_list"; folders: FolderInfo[] }
  | { type: "folder_selected"; path: string; name: string; inSession: boolean }
  | { type: "dialog_cancelled" }
  | { type: "lobby_entered" }
  | { type: "session_started"; sessionId: string }
  | { type: "connection_failed"; reason: string };

// --- Effects (instructions, not side effects) ---

export type FolderEffect =
  | { type: "open_dialog"; folders: FolderInfo[] }
  | { type: "update_dialog"; folders: FolderInfo[] }
  | { type: "close_dialog" }
  | { type: "list_folders" }
  | { type: "connect_folder"; path: string }
  | { type: "return_to_lobby" }
  | { type: "reset_agent" }
  | { type: "set_cwd"; name: string }
  | { type: "focus_input" }
  | { type: "show_error"; message: string }
  | { type: "start_timeout"; ms: number }
  | { type: "clear_timeout" };

// --- Transition result ---

export interface TransitionResult {
  state: FolderPhase;
  effects: FolderEffect[];
}

// --- Entry point ---

export function initial(): FolderPhase {
  return { phase: "idle" };
}

// --- Transition function ---

export function transition(
  state: FolderPhase,
  event: FolderEvent,
): TransitionResult {
  switch (state.phase) {
    case "idle":
      return transitionIdle(state, event);
    case "browsing":
      return transitionBrowsing(state, event);
    case "switching":
      return transitionSwitching(state, event);
    case "connecting":
      return transitionConnecting(state, event);
  }
}

// --- Phase-specific transitions ---

function transitionIdle(
  state: FolderPhase,
  event: FolderEvent,
): TransitionResult {
  switch (event.type) {
    case "open_requested": {
      // User clicked folder button — open dialog immediately (with cached data),
      // request fresh folder list in parallel
      const cached = event.cachedFolders || [];
      return {
        state: { phase: "browsing", folders: cached },
        effects: [
          { type: "open_dialog", folders: cached },
          { type: "list_folders" },
        ],
      };
    }

    case "lobby_entered":
      // WS connected in lobby mode (initial load or after returnToLobby without deferred)
      // Request folder list — the folder_list event will open the dialog
      return {
        state,
        effects: [{ type: "list_folders" }],
      };

    case "folder_list":
      // Folder list arrived while idle (e.g. initial lobby → list response)
      // Open the dialog automatically
      return {
        state: { phase: "browsing", folders: event.folders },
        effects: [{ type: "open_dialog", folders: event.folders }],
      };

    default:
      // session_started in idle (reconnect after idle timeout) — no-op
      // dialog_cancelled in idle — no-op
      return { state, effects: [] };
  }
}

function transitionBrowsing(
  state: FolderPhase & { phase: "browsing" },
  event: FolderEvent,
): TransitionResult {
  switch (event.type) {
    case "open_requested":
      // Already browsing — no-op (prevents double-open)
      return { state, effects: [] };

    case "folder_list":
      // Refresh the dialog with new folder data
      return {
        state: { ...state, folders: event.folders },
        effects: [{ type: "update_dialog", folders: event.folders }],
      };

    case "folder_selected":
      if (event.inSession) {
        // Mid-session switch: must return to lobby first
        return {
          state: {
            phase: "switching",
            folderPath: event.path,
            folderName: event.name,
          },
          effects: [
            { type: "reset_agent" },
            { type: "set_cwd", name: event.name },
            { type: "return_to_lobby" },
            { type: "start_timeout", ms: 30_000 },
          ],
        };
      } else {
        // Not in session: connect directly
        return {
          state: {
            phase: "connecting",
            folderPath: event.path,
            folderName: event.name,
            retries: 0,
          },
          effects: [
            { type: "reset_agent" },
            { type: "set_cwd", name: event.name },
            { type: "connect_folder", path: event.path },
            { type: "start_timeout", ms: 30_000 },
          ],
        };
      }

    case "dialog_cancelled":
      return {
        state: { phase: "idle" },
        effects: [{ type: "close_dialog" }],
      };

    case "session_started":
      // ** Flash bug prevention ** — session_started while browsing is a no-op.
      // This happens when a stale session reconnect fires while user is picking folders.
      return { state, effects: [] };

    case "lobby_entered":
      // Lobby entered while browsing — request fresh folder list
      return {
        state,
        effects: [{ type: "list_folders" }],
      };

    default:
      return { state, effects: [] };
  }
}

function transitionSwitching(
  state: FolderPhase & { phase: "switching" },
  event: FolderEvent,
): TransitionResult {
  switch (event.type) {
    case "lobby_entered":
      // We're back in lobby after returnToLobby — now connect to the deferred folder
      // Timeout continues from switching phase (not restarted)
      return {
        state: {
          phase: "connecting",
          folderPath: state.folderPath,
          folderName: state.folderName,
          retries: 0,
        },
        effects: [{ type: "connect_folder", path: state.folderPath }],
      };

    case "connection_failed":
      // Bridge error or timeout during switch — return to folder picker
      return {
        state: { phase: "idle" },
        effects: [
          { type: "clear_timeout" },
          { type: "show_error", message: event.reason },
          { type: "list_folders" },
        ],
      };

    case "dialog_cancelled":
      // User escaped during switch — abandon
      return {
        state: { phase: "idle" },
        effects: [{ type: "clear_timeout" }],
      };

    case "folder_list":
      // Stale folder list during switch — ignore
      return { state, effects: [] };

    case "session_started":
      // Stale session_started during switch — ignore
      return { state, effects: [] };

    default:
      return { state, effects: [] };
  }
}

function transitionConnecting(
  state: FolderPhase & { phase: "connecting" },
  event: FolderEvent,
): TransitionResult {
  switch (event.type) {
    case "session_started":
      // Session connected — close dialog, focus input, return to idle
      return {
        state: { phase: "idle" },
        effects: [{ type: "clear_timeout" }, { type: "close_dialog" }, { type: "focus_input" }],
      };

    case "lobby_entered": {
      // WS dropped and reconnected during connect — retry with counter
      const nextRetry = state.retries + 1;
      if (nextRetry >= MAX_CONNECT_RETRIES) {
        return {
          state: { phase: "idle" },
          effects: [
            { type: "clear_timeout" },
            { type: "show_error", message: `Failed to connect to ${state.folderName} after ${MAX_CONNECT_RETRIES} attempts` },
            { type: "list_folders" },
          ],
        };
      }
      return {
        state: { ...state, retries: nextRetry },
        effects: [{ type: "connect_folder", path: state.folderPath }],
      };
    }

    case "connection_failed":
      // Bridge error, processExit, or timeout during connect — return to folder picker
      return {
        state: { phase: "idle" },
        effects: [
          { type: "clear_timeout" },
          { type: "show_error", message: event.reason },
          { type: "list_folders" },
        ],
      };

    case "dialog_cancelled":
      // User escaped during connect — abandon
      return {
        state: { phase: "idle" },
        effects: [{ type: "clear_timeout" }],
      };

    case "folder_list":
      // Stale folder list during connect — ignore
      return { state, effects: [] };

    default:
      return { state, effects: [] };
  }
}
