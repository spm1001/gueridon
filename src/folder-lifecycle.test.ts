import { describe, it, expect } from "vitest";
import {
  initial,
  transition,
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

  it("open_requested → browsing, lists folders", () => {
    const { state, effects } = transition(idle, { type: "open_requested" });
    expect(state).toEqual({ phase: "browsing", folders: [] });
    expect(effectTypes(effects)).toEqual(["list_folders"]);
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

  it("folder_selected (not in session) → connecting, resets agent, sets cwd, connects", () => {
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
    });
    expect(effectTypes(effects)).toEqual([
      "reset_agent",
      "set_cwd",
      "connect_folder",
    ]);
    expect((effects[1] as any).name).toBe("alpha");
    expect((effects[2] as any).path).toBe("/home/user/Repos/alpha");
  });

  it("folder_selected (in session) → switching, resets agent, sets cwd, returns to lobby", () => {
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

  it("lobby_entered → connecting, connects folder", () => {
    const { state, effects } = transition(switching, {
      type: "lobby_entered",
    });
    expect(state).toEqual({
      phase: "connecting",
      folderPath: "/home/user/Repos/beta",
      folderName: "beta",
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
});

describe("connecting phase", () => {
  const connecting: FolderPhase = {
    phase: "connecting",
    folderPath: "/home/user/Repos/alpha",
    folderName: "alpha",
  };

  it("session_started → idle, closes dialog, focuses input", () => {
    const { state, effects } = transition(connecting, {
      type: "session_started",
      sessionId: "new-session-123",
    });
    expect(state).toEqual({ phase: "idle" });
    expect(effectTypes(effects)).toEqual(["close_dialog", "focus_input"]);
  });

  it("folder_list → no-op (stale list during connect)", () => {
    const { state, effects } = transition(connecting, {
      type: "folder_list",
      folders,
    });
    expect(state).toBe(connecting);
    expect(effects).toEqual([]);
  });

  it("lobby_entered → no-op (unexpected, transport handles)", () => {
    const { state, effects } = transition(connecting, {
      type: "lobby_entered",
    });
    expect(state).toBe(connecting);
    expect(effects).toEqual([]);
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
    ]);

    // Session established
    r = transition(s, { type: "session_started", sessionId: "sess-1" });
    s = r.state;
    expect(s.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["close_dialog", "focus_input"]);
  });

  it("mid-session switch: idle → open → list → select(inSession) → lobby → session", () => {
    let s: FolderPhase = initial();

    // User opens folder selector while in a session
    let r = transition(s, { type: "open_requested" });
    s = r.state;
    expect(s.phase).toBe("browsing");

    // Folder list arrives
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
    expect(effectTypes(r.effects)).toEqual(["close_dialog", "focus_input"]);
  });

  it("cancel during browsing: browsing → idle", () => {
    let s: FolderPhase = { phase: "browsing", folders };

    const r = transition(s, { type: "dialog_cancelled" });
    expect(r.state.phase).toBe("idle");
    expect(effectTypes(r.effects)).toEqual(["close_dialog"]);
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
