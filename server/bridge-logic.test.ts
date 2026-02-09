import { describe, it, expect } from "vitest";
import {
  resolveSessionForFolder,
  validateFolderPath,
  buildCCArgs,
  getActiveProcesses,
  CC_FLAGS,
  type SessionProcessInfo,
} from "./bridge-logic.js";

// --- resolveSessionForFolder ---
// This is the critical decision tree. The resume bug from session 8 was
// caused by resuming closed sessions (handoff existed but was ignored).

describe("resolveSessionForFolder", () => {
  const fixedId = () => "fresh-uuid-123";

  describe("existing bridge session (multi-WS reconnect)", () => {
    it("reconnects to existing bridge session", () => {
      const result = resolveSessionForFolder(
        { id: "bridge-session-1", resumable: true },
        null,
        false,
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "bridge-session-1",
        resumable: true,
        isReconnect: true,
      });
    });

    it("preserves resumable state from bridge session", () => {
      const result = resolveSessionForFolder(
        { id: "bridge-session-2", resumable: false },
        null,
        false,
        fixedId,
      );
      expect(result.resumable).toBe(false);
      expect(result.isReconnect).toBe(true);
    });

    it("ignores session files when bridge session exists", () => {
      const result = resolveSessionForFolder(
        { id: "bridge-session-3", resumable: true },
        { id: "old-session-file" },
        true, // handoff exists — but bridge session takes priority
        fixedId,
      );
      expect(result.sessionId).toBe("bridge-session-3");
      expect(result.isReconnect).toBe(true);
    });
  });

  describe("paused folder (session files, no handoff)", () => {
    it("resumes paused session", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "paused-session-abc" },
        false, // no handoff
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "paused-session-abc",
        resumable: true,
        isReconnect: false,
      });
    });
  });

  describe("closed folder (handoff exists)", () => {
    it("creates fresh session when handoff exists", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "old-closed-session" },
        true, // handoff exists = was closed
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });

    it("does NOT reuse session ID from closed session — the resume bug", () => {
      // This is the exact bug from session 8: connectFolder was checking
      // for session files but not handoffs, so it resumed closed sessions.
      const result = resolveSessionForFolder(
        null,
        { id: "should-not-reuse-this" },
        true, // handoff exists
        fixedId,
      );
      expect(result.sessionId).not.toBe("should-not-reuse-this");
      expect(result.sessionId).toBe("fresh-uuid-123");
      expect(result.resumable).toBe(false);
    });
  });

  describe("fresh folder (no session files, no handoff)", () => {
    it("creates fresh session", () => {
      const result = resolveSessionForFolder(
        null,
        null,
        false,
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });
  });

  describe("edge: handoff but no session files", () => {
    it("creates fresh session (defensive — shouldn't happen in practice)", () => {
      // Handoff implies a session existed, but the files might have been
      // cleaned up. Should still create a fresh session.
      const result = resolveSessionForFolder(
        null,
        null,
        true,
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });
  });

  it("uses the provided ID generator", () => {
    let counter = 0;
    const gen = () => `gen-${++counter}`;

    const r1 = resolveSessionForFolder(null, null, false, gen);
    expect(r1.sessionId).toBe("gen-1");

    const r2 = resolveSessionForFolder(null, null, true, gen);
    expect(r2.sessionId).toBe("gen-2");
  });
});

// --- validateFolderPath ---

describe("validateFolderPath", () => {
  const scanRoot = "/Users/test/Repos";

  it("accepts path within scan root", () => {
    expect(validateFolderPath("/Users/test/Repos/myproject", scanRoot)).toBe(true);
  });

  it("accepts nested path within scan root", () => {
    expect(validateFolderPath("/Users/test/Repos/deep/nested/project", scanRoot)).toBe(true);
  });

  it("rejects path outside scan root", () => {
    expect(validateFolderPath("/Users/other/hacked", scanRoot)).toBe(false);
  });

  it("rejects path traversal attempt", () => {
    expect(validateFolderPath("/Users/test/Repos/../../../etc/passwd", scanRoot)).toBe(false);
  });

  it("rejects scan root itself (must be a subfolder)", () => {
    expect(validateFolderPath("/Users/test/Repos", scanRoot)).toBe(false);
  });

  it("rejects scan root with trailing slash", () => {
    expect(validateFolderPath("/Users/test/Repos/", scanRoot)).toBe(false);
  });

  it("rejects prefix match that isn't a real subfolder", () => {
    // "/Users/test/Repos-evil/hack" starts with "/Users/test/Repos" but
    // is not within the scan root — the "/" check prevents this.
    expect(validateFolderPath("/Users/test/Repos-evil/hack", scanRoot)).toBe(false);
  });
});

// --- buildCCArgs ---

describe("buildCCArgs", () => {
  it("uses --session-id for fresh sessions", () => {
    const args = buildCCArgs("my-uuid", false);
    expect(args).toContain("--session-id");
    expect(args).toContain("my-uuid");
    expect(args).not.toContain("--resume");
  });

  it("uses --resume for resumed sessions", () => {
    const args = buildCCArgs("my-uuid", true);
    expect(args).toContain("--resume");
    expect(args).toContain("my-uuid");
    expect(args).not.toContain("--session-id");
  });

  it("includes all required CC flags", () => {
    const args = buildCCArgs("x", false);
    expect(args).toContain("-p");
    expect(args).toContain("--verbose");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--replay-user-messages");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--allow-dangerously-skip-permissions");
    expect(args).toContain("--append-system-prompt");
  });

  it("includes the mobile system prompt", () => {
    const args = buildCCArgs("x", false);
    const promptIndex = args.indexOf("--append-system-prompt");
    expect(args[promptIndex + 1]).toContain("mobile device");
    expect(args[promptIndex + 1]).toContain("AskUserQuestion");
  });

  it("starts with CC_FLAGS and ends with session arg", () => {
    const args = buildCCArgs("abc", false);
    // Session args are always last
    expect(args[args.length - 2]).toBe("--session-id");
    expect(args[args.length - 1]).toBe("abc");
  });
});

// --- getActiveProcesses ---

describe("getActiveProcesses", () => {
  it("returns empty map for no sessions", () => {
    const sessions = new Map<string, SessionProcessInfo>();
    expect(getActiveProcesses(sessions).size).toBe(0);
  });

  it("includes session with running process", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: { exitCode: null } }],
    ]);
    const active = getActiveProcesses(sessions);
    expect(active.get("/repos/myproject")).toBe("sid-1");
  });

  it("excludes session with exited process", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: { exitCode: 0 } }],
    ]);
    expect(getActiveProcesses(sessions).size).toBe(0);
  });

  it("excludes session with null process (not yet spawned)", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: null }],
    ]);
    expect(getActiveProcesses(sessions).size).toBe(0);
  });

  it("excludes session without folder (legacy ?session= path)", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: null, process: { exitCode: null } }],
    ]);
    expect(getActiveProcesses(sessions).size).toBe(0);
  });

  it("handles mixed sessions correctly", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["active-1", { folder: "/repos/a", process: { exitCode: null } }],
      ["exited-2", { folder: "/repos/b", process: { exitCode: 1 } }],
      ["unspawned-3", { folder: "/repos/c", process: null }],
      ["active-4", { folder: "/repos/d", process: { exitCode: null } }],
      ["legacy-5", { folder: null, process: { exitCode: null } }],
    ]);
    const active = getActiveProcesses(sessions);
    expect(active.size).toBe(2);
    expect(active.get("/repos/a")).toBe("active-1");
    expect(active.get("/repos/d")).toBe("active-4");
  });
});
