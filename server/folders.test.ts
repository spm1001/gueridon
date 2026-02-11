import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { join } from "node:path";

// Mock node:os before folders.ts imports it (vitest hoists vi.mock)
vi.mock("node:os", () => ({ homedir: () => "/test-home" }));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  writeFile: vi.fn(),
}));

import { readdir, stat, readFile, access } from "node:fs/promises";
import {
  encodePath,
  getLatestSession,
  getLatestHandoff,
  getSessionJSONLPath,
  scanFolders,
} from "./folders.js";

// --- Virtual filesystem ---

type VEntry = { type: "file" | "dir"; mtime: Date; content: string };
let vfs: Map<string, VEntry>;
let vfsDirs: Map<string, string[]>;

const PROJECTS = "/test-home/.claude/projects";
const HANDOFFS = "/test-home/.claude/handoffs";
const REPOS = "/test-home/Repos";

function enoent() {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function addDir(path: string, entries: string[] = []) {
  vfs.set(path, { type: "dir", mtime: new Date("2026-01-15"), content: "" });
  vfsDirs.set(path, entries);
}

function addFile(path: string, opts?: { mtime?: Date; content?: string }) {
  vfs.set(path, {
    type: "file",
    mtime: opts?.mtime ?? new Date("2026-01-15"),
    content: opts?.content ?? "",
  });
}

function wireVfs() {
  (readdir as unknown as Mock).mockImplementation(async (p: string) => {
    const entries = vfsDirs.get(p);
    if (!entries) throw enoent();
    return entries;
  });
  (stat as unknown as Mock).mockImplementation(async (p: string) => {
    const entry = vfs.get(p);
    if (!entry) throw enoent();
    return {
      isFile: () => entry.type === "file",
      isDirectory: () => entry.type === "dir",
      mtime: entry.mtime,
    };
  });
  (readFile as unknown as Mock).mockImplementation(async (p: string) => {
    const entry = vfs.get(p);
    if (!entry || entry.type !== "file") throw enoent();
    return entry.content;
  });
  (access as unknown as Mock).mockImplementation(async (p: string) => {
    if (!vfs.has(p)) throw enoent();
  });
}

function makeHandoff(sessionId: string, purpose: string): string {
  return [
    "# Handoff — 2026-02-09",
    "",
    `session_id: ${sessionId}`,
    `purpose: ${purpose}`,
    "",
    "## Done",
  ].join("\n");
}

beforeEach(() => {
  vfs = new Map();
  vfsDirs = new Map();
  vi.clearAllMocks();
  wireVfs();
});

// --- encodePath ---

describe("encodePath", () => {
  it("replaces slashes with dashes", () => {
    expect(encodePath("/Users/modha/Repos/gueridon")).toBe(
      "-Users-modha-Repos-gueridon",
    );
  });

  it("preserves alphanumeric characters and dashes", () => {
    expect(encodePath("abc-123")).toBe("abc-123");
  });

  it("replaces dots and spaces", () => {
    expect(encodePath("/home/user/my.project name")).toBe(
      "-home-user-my-project-name",
    );
  });

  it("handles root path", () => {
    expect(encodePath("/")).toBe("-");
  });

  it("handles empty string", () => {
    expect(encodePath("")).toBe("");
  });
});

// --- getSessionJSONLPath ---

describe("getSessionJSONLPath", () => {
  it("builds correct path from folder and session ID", () => {
    const result = getSessionJSONLPath("/test-home/Repos/gueridon", "abc-123-uuid");
    expect(result).toBe("/test-home/.claude/projects/-test-home-Repos-gueridon/abc-123-uuid.jsonl");
  });
});

// --- getLatestSession ---

describe("getLatestSession", () => {
  const FOLDER = "/test-home/Repos/alpha";
  const SESSION_DIR = join(PROJECTS, encodePath(FOLDER));

  it("returns null when directory doesn't exist", async () => {
    expect(await getLatestSession(FOLDER)).toBeNull();
  });

  it("returns null for empty directory", async () => {
    addDir(SESSION_DIR, []);
    expect(await getLatestSession(FOLDER)).toBeNull();
  });

  it("returns null when only non-jsonl files exist", async () => {
    addDir(SESSION_DIR, ["README.md", "notes.txt"]);
    expect(await getLatestSession(FOLDER)).toBeNull();
  });

  it("picks the newest .jsonl by mtime", async () => {
    const older = new Date("2026-01-10");
    const newer = new Date("2026-01-20");
    addDir(SESSION_DIR, ["old-session.jsonl", "new-session.jsonl"]);
    addFile(join(SESSION_DIR, "old-session.jsonl"), { mtime: older });
    addFile(join(SESSION_DIR, "new-session.jsonl"), { mtime: newer });

    const result = await getLatestSession(FOLDER);
    expect(result).toEqual({ id: "new-session", lastActive: newer });
  });

  it("ignores directory entries even if named .jsonl", async () => {
    addDir(SESSION_DIR, ["real.jsonl", "fake.jsonl"]);
    addFile(join(SESSION_DIR, "real.jsonl"), { mtime: new Date("2026-01-15") });
    addDir(join(SESSION_DIR, "fake.jsonl")); // directory, not file

    const result = await getLatestSession(FOLDER);
    expect(result?.id).toBe("real");
  });

  it("extracts full UUID from filename", async () => {
    const uuid = "f7a6478d-a28b-42ee-9d4a-853f1ebe9b5e";
    addDir(SESSION_DIR, [`${uuid}.jsonl`]);
    addFile(join(SESSION_DIR, `${uuid}.jsonl`));

    const result = await getLatestSession(FOLDER);
    expect(result?.id).toBe(uuid);
  });
});

// --- getLatestHandoff ---

describe("getLatestHandoff", () => {
  const FOLDER = "/test-home/Repos/alpha";
  const HANDOFF_DIR = join(HANDOFFS, encodePath(FOLDER));

  it("returns null when directory doesn't exist", async () => {
    expect(await getLatestHandoff(FOLDER)).toBeNull();
  });

  it("returns null for empty directory", async () => {
    addDir(HANDOFF_DIR, []);
    expect(await getLatestHandoff(FOLDER)).toBeNull();
  });

  it("parses well-formed handoff", async () => {
    const mtime = new Date("2026-02-09");
    addDir(HANDOFF_DIR, ["abc.md"]);
    addFile(join(HANDOFF_DIR, "abc.md"), {
      mtime,
      content: makeHandoff("sess-uuid-123", "Test purpose here"),
    });

    const result = await getLatestHandoff(FOLDER);
    expect(result).toEqual({
      sessionId: "sess-uuid-123",
      purpose: "Test purpose here",
      mtime,
    });
  });

  it("returns null when session_id line is missing", async () => {
    addDir(HANDOFF_DIR, ["bad.md"]);
    addFile(join(HANDOFF_DIR, "bad.md"), {
      content: "# Handoff\n\nno session id here\npurpose: something\n",
    });
    expect(await getLatestHandoff(FOLDER)).toBeNull();
  });

  it("returns null when purpose line is missing", async () => {
    addDir(HANDOFF_DIR, ["bad.md"]);
    addFile(join(HANDOFF_DIR, "bad.md"), {
      content: "# Handoff\n\nsession_id: abc\nno purpose here\n",
    });
    expect(await getLatestHandoff(FOLDER)).toBeNull();
  });

  it("picks newest .md by mtime", async () => {
    const older = new Date("2026-01-10");
    const newer = new Date("2026-02-01");
    addDir(HANDOFF_DIR, ["old.md", "new.md"]);
    addFile(join(HANDOFF_DIR, "old.md"), {
      mtime: older,
      content: makeHandoff("old-session", "Old purpose"),
    });
    addFile(join(HANDOFF_DIR, "new.md"), {
      mtime: newer,
      content: makeHandoff("new-session", "New purpose"),
    });

    const result = await getLatestHandoff(FOLDER);
    expect(result?.sessionId).toBe("new-session");
    expect(result?.purpose).toBe("New purpose");
  });

  it("ignores non-.md files", async () => {
    addDir(HANDOFF_DIR, ["notes.txt", "real.md"]);
    addFile(join(HANDOFF_DIR, "notes.txt"), { content: "not a handoff" });
    addFile(join(HANDOFF_DIR, "real.md"), {
      content: makeHandoff("sess-1", "Real handoff"),
    });

    const result = await getLatestHandoff(FOLDER);
    expect(result?.sessionId).toBe("sess-1");
  });
});

// --- scanFolders (state derivation — the crown jewel) ---

describe("scanFolders", () => {
  /** Set up a folder in the VFS with optional session/handoff state. */
  function addFolder(
    name: string,
    opts?: {
      session?: { id: string; mtime: Date };
      handoff?: { sessionId: string; purpose: string; mtime: Date };
    },
  ) {
    const fullPath = join(REPOS, name);
    addDir(fullPath); // stat says it's a directory

    const encoded = encodePath(fullPath);

    if (opts?.session) {
      const dir = join(PROJECTS, encoded);
      addDir(dir, [`${opts.session.id}.jsonl`]);
      addFile(join(dir, `${opts.session.id}.jsonl`), {
        mtime: opts.session.mtime,
      });
    }

    if (opts?.handoff) {
      const dir = join(HANDOFFS, encoded);
      const fname = `${opts.handoff.sessionId.slice(0, 8)}.md`;
      addDir(dir, [fname]);
      addFile(join(dir, fname), {
        mtime: opts.handoff.mtime,
        content: makeHandoff(opts.handoff.sessionId, opts.handoff.purpose),
      });
    }
  }

  it("returns empty array when SCAN_ROOT is unreadable", async () => {
    // Don't add REPOS to VFS
    expect(await scanFolders(new Map())).toEqual([]);
  });

  it("skips hidden directories", async () => {
    addDir(REPOS, [".hidden", "visible"]);
    addDir(join(REPOS, ".hidden"));
    addFolder("visible");

    const result = await scanFolders(new Map());
    expect(result.map((f) => f.name)).toEqual(["visible"]);
  });

  it("skips non-directory entries", async () => {
    addDir(REPOS, ["readme.txt", "project"]);
    addFile(join(REPOS, "readme.txt"));
    addFolder("project");

    const result = await scanFolders(new Map());
    expect(result.map((f) => f.name)).toEqual(["project"]);
  });

  it("marks folder as active when in activeProcesses", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha");

    const active = new Map([[join(REPOS, "alpha"), { sessionId: "active-sess-id", activity: "waiting" as const }]]);
    const result = await scanFolders(active);

    expect(result[0].state).toBe("active");
    expect(result[0].sessionId).toBe("active-sess-id");
    expect(result[0].activity).toBe("waiting");
  });

  it("active folder shows handoff purpose if one exists", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      handoff: {
        sessionId: "prev-sess",
        purpose: "Previous work",
        mtime: new Date("2026-01-01"),
      },
    });

    const active = new Map([[join(REPOS, "alpha"), { sessionId: "new-sess", activity: "working" as const }]]);
    const result = await scanFolders(active);

    expect(result[0].state).toBe("active");
    expect(result[0].activity).toBe("working");
    expect(result[0].handoffPurpose).toBe("Previous work");
  });

  // THE BUG: session files persist forever. Handoff = intentional close.
  // Both session + handoff → state must be "closed", NOT "paused".
  it("closed wins over paused — handoff trumps session files", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      session: { id: "old-sess", mtime: new Date("2026-01-10") },
      handoff: {
        sessionId: "old-sess",
        purpose: "Finished work",
        mtime: new Date("2026-01-11"),
      },
    });

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("closed");
    expect(result[0].handoffPurpose).toBe("Finished work");
    // lastActive prefers session mtime over handoff mtime
    expect(result[0].lastActive).toBe(new Date("2026-01-10").toISOString());
  });

  it("paused when session exists but no handoff", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      session: { id: "paused-sess", mtime: new Date("2026-01-20") },
    });

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("paused");
    expect(result[0].sessionId).toBe("paused-sess");
    expect(result[0].handoffPurpose).toBeNull();
  });

  it("closed when .exit marker exists (no handoff)", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      session: { id: "exited-sess", mtime: new Date("2026-01-10") },
    });
    // Add .exit marker file alongside the .jsonl
    const encoded = encodePath(join(REPOS, "alpha"));
    const exitDir = join(PROJECTS, encoded);
    // The dir already exists from addFolder — just add the .exit file to it
    vfsDirs.get(exitDir)!.push("exited-sess.exit");
    addFile(join(exitDir, "exited-sess.exit"), {
      mtime: new Date("2026-01-10"),
      content: JSON.stringify({ sessionId: "exited-sess", timestamp: "2026-01-10T00:00:00Z", source: "bridge" }),
    });

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("closed");
    expect(result[0].sessionId).toBe("exited-sess");
  });

  it("closed from .exit takes priority over paused (session without handoff)", async () => {
    // Without .exit, this would be "paused". With .exit, it should be "closed".
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      session: { id: "exited-sess-2", mtime: new Date("2026-01-10") },
    });
    const encoded = encodePath(join(REPOS, "alpha"));
    const exitDir = join(PROJECTS, encoded);
    vfsDirs.get(exitDir)!.push("exited-sess-2.exit");
    addFile(join(exitDir, "exited-sess-2.exit"));

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("closed");
    expect(result[0].handoffPurpose).toBeNull(); // no handoff, just .exit
  });

  it("fresh when neither session nor handoff exists", async () => {
    addDir(REPOS, ["alpha"]);
    addFolder("alpha");

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("fresh");
    expect(result[0].sessionId).toBeNull();
    expect(result[0].lastActive).toBeNull();
    expect(result[0].handoffPurpose).toBeNull();
  });

  it("falls back to handoff mtime when closed folder has no session files", async () => {
    const handoffMtime = new Date("2026-02-01");
    addDir(REPOS, ["alpha"]);
    addFolder("alpha", {
      handoff: {
        sessionId: "h-sess",
        purpose: "Closed without session",
        mtime: handoffMtime,
      },
    });

    const result = await scanFolders(new Map());
    expect(result[0].state).toBe("closed");
    expect(result[0].lastActive).toBe(handoffMtime.toISOString());
  });

  it("sorts by state: active > paused > closed > fresh", async () => {
    addDir(REPOS, ["fresh-proj", "closed-proj", "paused-proj", "active-proj"]);

    addFolder("fresh-proj");
    addFolder("closed-proj", {
      handoff: {
        sessionId: "h-sess",
        purpose: "Done",
        mtime: new Date("2026-01-05"),
      },
    });
    addFolder("paused-proj", {
      session: { id: "p-sess", mtime: new Date("2026-01-15") },
    });
    addFolder("active-proj");

    const active = new Map([[join(REPOS, "active-proj"), { sessionId: "a-sess", activity: "waiting" as const }]]);
    const result = await scanFolders(active);

    expect(result.map((f) => f.state)).toEqual([
      "active",
      "paused",
      "closed",
      "fresh",
    ]);
  });

  it("within same state, sorts most recent first", async () => {
    addDir(REPOS, ["older", "newer"]);
    addFolder("older", {
      session: { id: "s1", mtime: new Date("2026-01-10") },
    });
    addFolder("newer", {
      session: { id: "s2", mtime: new Date("2026-01-20") },
    });

    const result = await scanFolders(new Map());
    expect(result.map((f) => f.name)).toEqual(["newer", "older"]);
  });

  it("fresh folders sort alphabetically (no lastActive)", async () => {
    addDir(REPOS, ["zeta", "alpha", "mu"]);
    addFolder("zeta");
    addFolder("alpha");
    addFolder("mu");

    const result = await scanFolders(new Map());
    expect(result.map((f) => f.name)).toEqual(["alpha", "mu", "zeta"]);
  });
});
