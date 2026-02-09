import { describe, it, expect } from "vitest";
import {
  initial,
  transition,
  MAX_CONNECT_RETRIES,
  type FolderPhase,
  type FolderEvent,
  type FolderEffect,
} from "./folder-lifecycle.js";
import type { FolderInfo } from "./ws-transport.js";

// --- Helpers ---

const folder = (name: string, path = `/home/user/Repos/${name}`): FolderInfo => ({
  name,
  path,
  state: "fresh",
  sessionId: null,
  lastActive: null,
  handoffPurpose: null,
});

const folders = [folder("alpha"), folder("beta")];

function effectTypes(effects: FolderEffect[]): string[] {
  return effects.map((e) => e.type);
}

// --- Tests ---

describe("initial()", () => {
  it("returns idle phase", () => {
    expect(initial()).toEqual({ phase: "idle" });
  });
});

describe("idle phase", () => {
  const idle: FolderPhase = { phase: "idle" };

  it("open_requested → browsing, opens dialog + lists folders", () => {
    const { state, effects } = transition(idle, { type: "open_requested" });
    expect(state).toEqual({ phase: "browsing", folders: [] });
    expect(effectTypes(effects)).toEqual(["open_dialog", "list_folders"]);
    expect((effects[0] as any).folders).toEqual([]);
  });

  it("open_requested with cached folders → opens dialog with cache", () => {
    const { state, effects } = transition(idle, {
      type: "open_requested",
      cachedFolders: folders,
    });
    expect(state).toEqual({ phase: "browsing", folders });
    expect(effectTypes(effects)).toEqual(["open_dialog", "list_folders"]);
    expect((effects[0] as any).folders).toBe(folders);
  });

  it("lobby_entered → stays idle, lists folders", () => {
    const { state, effects } = transition(idle, { type: "lobby_entered" });
    expect(state.phase).toBe("idle");
    expect(effectTypes(effects)).toEqual(["list_folders"]);
  });

  it("folder_list → browsing, opens dialog", () => {
    const { state, effects } = transition(idle, {
      type: "folder_list",
      folders,
    });
    expect(state).toEqual({ phase: "browsing", folders });
    expect(effectTypes(effects)).toEqual(["open_dialog"]);
    expect((effects[0] as any).folders).toBe(folders);
  });

  it("session_started → no-op (reconnect after idle timeout)", () => {
    const { state, effects } = transition(idle, {
      type: "session_started",
      sessionId: "abc",
    });
    expect(state.phase).toBe("idle");
    expect(effects).toEqual([]);
  });

  it("dialog_cancelled → no-op", () => {
    const { state, effects } = transition(idle, { type: "dialog_cancelled" });
    expect(state.phase).toBe("idle");
    expect(effects).toEqual([]);
  });
});

describe("browsing phase", () => {
  const browsing: FolderPhase = { phase: "browsing", folders };

  it("folder_list → updates dialog", () => {
    const newFolders = [folder("gamma")];
    const { state, effects } = transition(browsing, {
      type: "folder_list",
      folders: newFolders,
    });
    expect(state).toEqual({ phase: "browsing", folders: newFolders });
    expect(effectTypes(effects)).toEqual(["update_dialog"]);
    expect((effects[0] as any).folders).toBe(newFolders);
  });

  it("folder_selected (not in session) → connecting, resets agent, sets cwd, connects, starts timeout", () => {
    const { state, effects } = transition(browsing, {
      type: "folder_selected",
      path: "/home/user/Repos/alpha",
      name: "alpha",
      inSession: false,
    });
    expect(state).toEqual({
      phase: "connecting",
      folderPath: "/home/user/Repos/alpha",
      folderName: "alpha",
      retries: 0,
    });
    expect(effectTypes(effects)).toEqual([
      "reset_agent",
      "set_cwd",
      "connect_folder",
      "start_timeout",
    ]);
    expect((effects[1] as any).name).toBe("alpha");
    expect((effects[2] as any).path).toBe("/home/user/Repos/alpha");
    expect((effects[3] as any).ms).toBe(30_000);
  });

  it("folder_selected (in session) → switching, resets agent, sets cwd, returns to lobby, starts timeout", () => {
    const { state, effects } = transition(browsing, {
      type: "folder_selected",
      path: "/home/user/Repos/beta",
      name: "beta",
      inSession: true,
    });
    expect(state).toEqual({
      phase: "switching",
      folderPath: "/home/user/Repos/beta",
      folderName: "beta",
    });
    expect(effectTypes(effects)).toEqual([
      "reset_agent",
      "set_cwd",
      "return_to_lobby",
      "start_timeout",
    ]);
  });

  it("dialog_cancelled → idle, closes dialog", () => {
    const { state, effects } = transition(browsing, {
      type: "dialog_cancelled",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["close_dialog"]);
  });

  it("open_requested → no-op (prevents double-open)", () => {
    const { state, effects } = transition(browsing, {
      type: "open_requested",
    });
    expect(state).toBe(browsing); // Same reference
    expect(effects).toEqual([]);
  });

  it("session_started → no-op (FLASH BUG PREVENTION)", () => {
    const { state, effects } = transition(browsing, {
      type: "session_started",
      sessionId: "stale-123",
    });
    expect(state).toBe(browsing);
    expect(effects).toEqual([]);
    // Critical: no close_dialog effect — this IS the flash bug fix
    expect(effects.some((e) => e.type === "close_dialog")).toBe(false);
  });

  it("lobby_entered → stays browsing, lists folders", () => {
    const { state, effects } = transition(browsing, {
      type: "lobby_entered",
    });
    expect(state.phase).toBe("browsing");
    expect(effectTypes(effects)).toEqual(["list_folders"]);
  });
});

describe("switching phase", () => {
  const switching: FolderPhase = {
    phase: "switching",
    folderPath: "/home/user/Repos/beta",
    folderName: "beta",
  };

  it("lobby_entered → connecting with retries=0, connects folder", () => {
    const { state, effects } = transition(switching, {
      type: "lobby_entered",
    });
    expect(state).toEqual({
      phase: "connecting",
      folderPath: "/home/user/Repos/beta",
      folderName: "beta",
      retries: 0,
    });
    expect(effectTypes(effects)).toEqual(["connect_folder"]);
    expect((effects[0] as any).path).toBe("/home/user/Repos/beta");
  });

  it("auto_connect → connecting (treated as lobby_entered — localStorage stored folder is ignored)", () => {
    const { state, effects } = transition(switching, {
      type: "auto_connect",
      path: "/home/user/Repos/WRONG",
      name: "WRONG",
    });
    expect(state).toEqual({
      phase: "connecting",
      folderPath: "/home/user/Repos/beta",
      folderName: "beta",
      retries: 0,
    });
    expect(effectTypes(effects)).toEqual(["connect_folder"]);
    expect((effects[0] as any).path).toBe("/home/user/Repos/beta");
  });

  it("folder_list → no-op (stale list during switch)", () => {
    const { state, effects } = transition(switching, {
      type: "folder_list",
      folders,
    });
    expect(state).toBe(switching);
    expect(effects).toEqual([]);
  });

  it("session_started → no-op (stale session during switch)", () => {
    const { state, effects } = transition(switching, {
      type: "session_started",
      sessionId: "stale",
    });
    expect(state).toBe(switching);
    expect(effects).toEqual([]);
  });

  it("dialog_cancelled → idle, clears timeout (user escaped mid-switch)", () => {
    const { state, effects } = transition(switching, {
      type: "dialog_cancelled",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout"]);
  });

  it("connection_failed → idle, shows error, lists folders", () => {
    const { state, effects } = transition(switching, {
      type: "connection_failed",
      reason: "Bridge died",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout", "show_error", "list_folders"]);
    expect((effects[1] as any).message).toBe("Bridge died");
  });
});

describe("connecting phase", () => {
  const connecting: FolderPhase = {
    phase: "connecting",
    folderPath: "/home/user/Repos/alpha",
    folderName: "alpha",
    retries: 0,
  };

  it("session_started → idle, clears timeout, closes dialog, focuses input", () => {
    const { state, effects } = transition(connecting, {
      type: "session_started",
      sessionId: "new-session-123",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout", "close_dialog", "store_folder", "focus_input"]);
  });

  it("folder_list → no-op (stale list during connect)", () => {
    const { state, effects } = transition(connecting, {
      type: "folder_list",
      folders,
    });
    expect(state).toBe(connecting);
    expect(effects).toEqual([]);
  });

  it("lobby_entered → retries connect_folder, increments retries", () => {
    const { state, effects } = transition(connecting, {
      type: "lobby_entered",
    });
    expect(state).toEqual({ ...connecting, retries: 1 });
    expect(effectTypes(effects)).toEqual(["connect_folder"]);
    expect((effects[0] as any).path).toBe("/home/user/Repos/alpha");
  });

  it("lobby_entered at max retries → idle, clears stored folder, shows error, lists folders", () => {
    const atMax: FolderPhase = { ...connecting, retries: MAX_CONNECT_RETRIES - 1 };
    const { state, effects } = transition(atMax, {
      type: "lobby_entered",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
    expect((effects[2] as any).message).toContain("Failed to connect");
    expect((effects[2] as any).message).toContain("alpha");
  });

  it("connection_failed → idle, clears stored folder, shows error, lists folders", () => {
    const { state, effects } = transition(connecting, {
      type: "connection_failed",
      reason: "Connection timed out",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
    expect((effects[2] as any).message).toBe("Connection timed out");
  });

  it("dialog_cancelled → idle, clears timeout (user escaped mid-connect)", () => {
    const { state, effects } = transition(connecting, {
      type: "dialog_cancelled",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["clear_timeout"]);
  });
});

describe("full paths", () => {
  it("fresh load: idle → lobby → folder_list → select → session", () => {
    let s: FolderPhase = initial();

    // WS connects in lobby
    let r = transition(s, { type: "lobby_entered" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["list_folders"]);

    // Folder list arrives
    r = transition(s, { type: "folder_list", folders });
    s = r.state;
    expect(s.phase).toBe("browsing");
    expect(effectTypes(r.effects)).toEqual(["open_dialog"]);

    // User selects (not in session)
    r = transition(s, {
      type: "folder_selected",
      path: folders[0].path,
      name: folders[0].name,
      inSession: false,
    });
    s = r.state;
    expect(s.phase).toBe("connecting");
    expect(effectTypes(r.effects)).toEqual([
      "reset_agent",
      "set_cwd",
      "connect_folder",
      "start_timeout",
    ]);

    // Session established
    r = transition(s, { type: "session_started", sessionId: "sess-1" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "close_dialog", "store_folder", "focus_input"]);
  });

  it("mid-session switch: idle → open → list → select(inSession) → lobby → session", () => {
    let s: FolderPhase = initial();

    // User opens folder selector while in a session
    let r = transition(s, { type: "open_requested", cachedFolders: folders });
    s = r.state;
    expect(s.phase).toBe("browsing");
    expect(effectTypes(r.effects)).toEqual(["open_dialog", "list_folders"]);

    // Fresh folder list arrives
    r = transition(s, { type: "folder_list", folders });
    s = r.state;
    expect(s.phase).toBe("browsing");
    expect(effectTypes(r.effects)).toEqual(["update_dialog"]);

    // User selects while in session
    r = transition(s, {
      type: "folder_selected",
      path: folders[1].path,
      name: folders[1].name,
      inSession: true,
    });
    s = r.state;
    expect(s.phase).toBe("switching");
    expect(effectTypes(r.effects)).toEqual([
      "reset_agent",
      "set_cwd",
      "return_to_lobby",
      "start_timeout",
    ]);

    // Lobby entered after returnToLobby
    r = transition(s, { type: "lobby_entered" });
    s = r.state;
    expect(s.phase).toBe("connecting");
    expect(effectTypes(r.effects)).toEqual(["connect_folder"]);

    // Session established
    r = transition(s, { type: "session_started", sessionId: "sess-2" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "close_dialog", "store_folder", "focus_input"]);
  });

  it("cancel during browsing: browsing → idle", () => {
    let s: FolderPhase = { phase: "browsing", folders };

    const r = transition(s, { type: "dialog_cancelled" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["close_dialog"]);
  });

  it("disconnect during connecting: lobby_entered retries then caps", () => {
    // Select folder → connecting → WS drops → retry → retry → cap
    let s: FolderPhase = {
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 0,
    };

    // First WS drop — retry 1
    let r = transition(s, { type: "lobby_entered" });
    s = r.state;
    expect(s.phase).toBe("connecting");
    expect((s as any).retries).toBe(1);
    expect(effectTypes(r.effects)).toEqual(["connect_folder"]);

    // Second WS drop — retry 2
    r = transition(s, { type: "lobby_entered" });
    s = r.state;
    expect(s.phase).toBe("connecting");
    expect((s as any).retries).toBe(2);
    expect(effectTypes(r.effects)).toEqual(["connect_folder"]);

    // Third WS drop — max reached, gives up
    r = transition(s, { type: "lobby_entered" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
  });

  it("disconnect during connecting: succeeds before max retries", () => {
    let s: FolderPhase = {
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 1,
    };

    // Succeeds on second try
    const r = transition(s, { type: "session_started", sessionId: "recovered" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "close_dialog", "store_folder", "focus_input"]);
  });

  it("timeout during connecting: returns to folder picker with error", () => {
    let s: FolderPhase = {
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 0,
    };

    const r = transition(s, { type: "connection_failed", reason: "Connection timed out" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
  });

  it("timeout during switching: returns to folder picker with error", () => {
    let s: FolderPhase = {
      phase: "switching",
      folderPath: folders[1].path,
      folderName: folders[1].name,
    };

    const r = transition(s, { type: "connection_failed", reason: "Connection timed out" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "show_error", "list_folders"]);
  });

  it("bridge error during connecting: returns to folder picker", () => {
    let s: FolderPhase = {
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 0,
    };

    const r = transition(s, {
      type: "connection_failed",
      reason: "CC process exited (signal SIGKILL)",
    });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
    expect((r.effects[2] as any).message).toContain("SIGKILL");
  });

  it("escape during connecting: user cancels, connection may succeed silently", () => {
    let s: FolderPhase = {
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 0,
    };

    // User escapes
    let r = transition(s, { type: "dialog_cancelled" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout"]);

    // session_started arrives later — no-op in idle
    r = transition(s, { type: "session_started", sessionId: "late" });
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
  });

  it("escape during switching: user cancels, returns to idle", () => {
    let s: FolderPhase = {
      phase: "switching",
      folderPath: folders[1].path,
      folderName: folders[1].name,
    };

    // User escapes
    let r = transition(s, { type: "dialog_cancelled" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout"]);

    // lobby_entered arrives — lists folders, user sees selector again
    r = transition(s, { type: "lobby_entered" });
    expect(effectTypes(r.effects)).toEqual(["list_folders"]);
  });

  it("auto_connect: idle → connecting, skips dialog, sets cwd", () => {
    let s = initial();
    const r = transition(s, {
      type: "auto_connect",
      path: folders[0].path,
      name: folders[0].name,
    });
    expect(r.state).toEqual({
      phase: "connecting",
      folderPath: folders[0].path,
      folderName: folders[0].name,
      retries: 0,
    });
    expect(effectTypes(r.effects)).toEqual(["set_cwd", "connect_folder", "start_timeout"]);
    expect((r.effects[0] as any).name).toBe(folders[0].name);
    expect((r.effects[1] as any).path).toBe(folders[0].path);
  });

  it("auto_connect → session_started: stores folder, focuses input", () => {
    let s = initial();
    let r = transition(s, { type: "auto_connect", path: folders[0].path, name: folders[0].name });
    r = transition(r.state, { type: "session_started", sessionId: "auto-123" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "close_dialog", "store_folder", "focus_input"]);
    expect((r.effects[2] as any).path).toBe(folders[0].path);
  });

  it("auto_connect → connection_failed: clears stored folder, opens picker", () => {
    let s = initial();
    let r = transition(s, { type: "auto_connect", path: "/gone", name: "gone" });
    r = transition(r.state, { type: "connection_failed", reason: "Folder not found" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["clear_timeout", "clear_stored_folder", "show_error", "list_folders"]);
  });

  it("auto_connect in non-idle phase is a no-op", () => {
    const browsing: FolderPhase = { phase: "browsing", folders };
    const r = transition(browsing, { type: "auto_connect", path: "/x", name: "x" });
    expect(r.state).toBe(browsing);
    expect(r.effects).toEqual([]);
  });

  it("flash bug scenario: session_started while browsing does NOT close dialog", () => {
    // This is THE test for gdn-jebudo
    let s: FolderPhase = { phase: "browsing", folders };

    const r = transition(s, {
      type: "session_started",
      sessionId: "reconnect-stale",
    });
    expect(r.state.phase).toBe("browsing");
    expect(r.effects).toEqual([]);
    // Absolutely no close_dialog
    expect(r.effects.find((e) => e.type === "close_dialog")).toBeUndefined();
  });
});
