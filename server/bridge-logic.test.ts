import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveSessionForFolder,
  validateFolderPath,
  buildCCArgs,
  getActiveProcesses,
  parseSessionJSONL,
  CC_FLAGS,
  resolveStaticFile,
  MIME_TYPES,
  checkIdle,
  createActiveTurnGuard,
  DEFAULT_IDLE_GUARDS,
  IDLE_TIMEOUT_MS,
  MAX_IDLE_MS,
  STALE_OUTPUT_MS,
  IDLE_RECHECK_MS,
  type SessionProcessInfo,
  type IdleGuard,
  type IdleSessionState,
} from "./bridge-logic.js";

// --- resolveStaticFile ---

describe("resolveStaticFile", () => {
  const DIST = "/app/dist";

  describe("SPA fallback", () => {
    it("/ serves index.html", () => {
      const r = resolveStaticFile("/", DIST);
      expect(r).toEqual({ ok: true, filePath: "/app/dist/index.html", mime: "text/html; charset=utf-8", cache: false });
    });

    it("extensionless paths serve index.html", () => {
      const r = resolveStaticFile("/some/route", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.filePath).toBe("/app/dist/index.html");
    });

    it("/about serves index.html (SPA deep link)", () => {
      const r = resolveStaticFile("/about", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.filePath).toBe("/app/dist/index.html");
    });
  });

  describe("path traversal guard", () => {
    it("blocks /../etc/passwd", () => {
      const r = resolveStaticFile("/../etc/passwd", DIST);
      expect(r).toEqual({ ok: false, status: 403 });
    });

    it("blocks /..%2f..%2fetc/passwd (encoded)", () => {
      // URL constructor decodes %2f, so the pathname arrives decoded
      const r = resolveStaticFile("/../../etc/passwd", DIST);
      expect(r).toEqual({ ok: false, status: 403 });
    });

    it("allows normal nested paths", () => {
      const r = resolveStaticFile("/assets/index-abc123.js", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.filePath).toBe("/app/dist/assets/index-abc123.js");
    });
  });

  describe("MIME types", () => {
    it("resolves .js files", () => {
      const r = resolveStaticFile("/app.js", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mime).toBe("application/javascript; charset=utf-8");
    });

    it("resolves .css files", () => {
      const r = resolveStaticFile("/style.css", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mime).toBe("text/css; charset=utf-8");
    });

    it("resolves .woff2 font files", () => {
      const r = resolveStaticFile("/fonts/inter.woff2", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mime).toBe("font/woff2");
    });

    it("resolves .svg files", () => {
      const r = resolveStaticFile("/icon.svg", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mime).toBe("image/svg+xml");
    });

    it("falls back to application/octet-stream for unknown extensions", () => {
      const r = resolveStaticFile("/data.bin", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mime).toBe("application/octet-stream");
    });
  });

  describe("cache headers", () => {
    it("sets cache flag for /assets/ paths", () => {
      const r = resolveStaticFile("/assets/index-abc123.js", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cache).toBe(true);
    });

    it("does not set cache flag for root files", () => {
      const r = resolveStaticFile("/index.html", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cache).toBe(false);
    });

    it("does not set cache flag for non-assets paths", () => {
      const r = resolveStaticFile("/favicon.ico", DIST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cache).toBe(false);
    });
  });

  describe("MIME_TYPES coverage", () => {
    it("all expected extensions are present", () => {
      const expected = [".html", ".js", ".css", ".woff", ".woff2", ".ttf", ".png", ".svg", ".ico", ".json", ".map"];
      for (const ext of expected) {
        expect(MIME_TYPES[ext]).toBeDefined();
      }
    });
  });
});

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

// --- parseSessionJSONL ---

describe("parseSessionJSONL", () => {
  /** Helper: make a JSONL line for a user text message */
  function userLine(content: string, extra?: Record<string, any>): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content },
      ...extra,
    });
  }

  /** Helper: make a JSONL line for an assistant message */
  function assistantLine(
    content: any[],
    opts?: { id?: string; usage?: any; model?: string },
  ): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        id: opts?.id || "msg_1",
        model: opts?.model || "claude-opus-4-6",
        role: "assistant",
        content,
        stop_reason: null,
        usage: opts?.usage || { input_tokens: 100, output_tokens: 10 },
      },
    });
  }

  /** Parse a result string back to check its shape */
  function parse(serialized: string): any {
    return JSON.parse(serialized);
  }

  it("returns empty array for empty input", () => {
    expect(parseSessionJSONL("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseSessionJSONL("  \n  \n  ")).toEqual([]);
  });

  it("parses simple text conversation (user + assistant)", () => {
    const input = [
      userLine("hello"),
      assistantLine([{ type: "text", text: "Hi there!" }]),
    ].join("\n");

    const result = parseSessionJSONL(input);

    // user + assistant + synthetic result = 3
    expect(result).toHaveLength(3);

    const user = parse(result[0]);
    expect(user.source).toBe("cc");
    expect(user.event.type).toBe("user");
    expect(user.event.message.content).toBe("hello");

    const assistant = parse(result[1]);
    expect(assistant.source).toBe("cc");
    expect(assistant.event.type).toBe("assistant");
    expect(assistant.event.message.content).toHaveLength(1);
    expect(assistant.event.message.content[0].text).toBe("Hi there!");
  });

  it("groups consecutive assistant lines by message.id", () => {
    const input = [
      assistantLine(
        [{ type: "thinking", thinking: "Let me think..." }],
        { id: "msg_multi", usage: { input_tokens: 50, output_tokens: 5 } },
      ),
      assistantLine(
        [{ type: "text", text: "Here is my answer" }],
        { id: "msg_multi", usage: { input_tokens: 50, output_tokens: 20 } },
      ),
    ].join("\n");

    const result = parseSessionJSONL(input);

    // One merged assistant + synthetic result = 2
    expect(result).toHaveLength(2);

    const assistant = parse(result[0]);
    expect(assistant.event.message.content).toHaveLength(2);
    expect(assistant.event.message.content[0].type).toBe("thinking");
    expect(assistant.event.message.content[1].type).toBe("text");
    expect(assistant.event.message.usage.output_tokens).toBe(20);
  });

  it("handles tool use cycle (assistant tool_use + user tool_result + assistant text)", () => {
    const input = [
      userLine("read the file"),
      assistantLine(
        [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/foo.ts" } }],
        { id: "msg_tool" },
      ),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" }],
        },
      }),
      assistantLine(
        [{ type: "text", text: "The file contains..." }],
        { id: "msg_reply" },
      ),
    ].join("\n");

    const result = parseSessionJSONL(input);

    expect(result).toHaveLength(5);

    expect(parse(result[0]).event.type).toBe("user");
    expect(parse(result[1]).event.type).toBe("assistant");
    expect(parse(result[1]).event.message.content[0].name).toBe("Read");
    expect(parse(result[2]).event.type).toBe("user");
    expect(parse(result[2]).event.message.content[0].type).toBe("tool_result");
    expect(parse(result[3]).event.type).toBe("assistant");
    expect(parse(result[3]).event.message.content[0].text).toBe("The file contains...");
  });

  it("skips queue-operation events", () => {
    const input = [
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-01-01" }),
      userLine("hi"),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(1);
    expect(parse(result[0]).event.type).toBe("user");
  });

  it("skips progress events", () => {
    const input = [
      JSON.stringify({ type: "progress", data: { type: "hook_progress" } }),
      userLine("hi"),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(1);
  });

  it("skips system events", () => {
    const input = [
      JSON.stringify({ type: "system", subtype: "init", cwd: "/test" }),
      assistantLine([{ type: "text", text: "ok" }]),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(2);
    expect(parse(result[0]).event.type).toBe("assistant");
  });

  it("skips user messages with isMeta: true", () => {
    const input = [
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "internal" } }),
      userLine("real message"),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(1);
    expect(parse(result[0]).event.message.content).toBe("real message");
  });

  it("preserves user string content as-is", () => {
    const input = userLine("hello world");
    const result = parseSessionJSONL(input);
    expect(parse(result[0]).event.message.content).toBe("hello world");
  });

  it("preserves user tool_result array content", () => {
    const input = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result data" }],
      },
    });

    const result = parseSessionJSONL(input);
    const parsed = parse(result[0]);
    expect(Array.isArray(parsed.event.message.content)).toBe(true);
    expect(parsed.event.message.content[0].type).toBe("tool_result");
  });

  it("preserves multi-turn conversation order", () => {
    const input = [
      userLine("first question"),
      assistantLine([{ type: "text", text: "first answer" }], { id: "msg_a" }),
      userLine("second question"),
      assistantLine([{ type: "text", text: "second answer" }], { id: "msg_b" }),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(5);

    const types = result.slice(0, 4).map((r) => parse(r).event.type);
    expect(types).toEqual(["user", "assistant", "user", "assistant"]);

    expect(parse(result[0]).event.message.content).toBe("first question");
    expect(parse(result[1]).event.message.content[0].text).toBe("first answer");
    expect(parse(result[2]).event.message.content).toBe("second question");
    expect(parse(result[3]).event.message.content[0].text).toBe("second answer");
  });

  it("appends synthetic result event with last usage data", () => {
    const input = assistantLine(
      [{ type: "text", text: "hello" }],
      { usage: { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 10000 } },
    );

    const result = parseSessionJSONL(input);
    const synthetic = parse(result[result.length - 1]);

    expect(synthetic.source).toBe("cc");
    expect(synthetic.event.type).toBe("result");
    expect(synthetic.event.subtype).toBe("success");
    expect(synthetic.event.result.usage.input_tokens).toBe(5000);
    expect(synthetic.event.result.usage.cache_read_input_tokens).toBe(10000);
  });

  it("does not append synthetic result when no assistant messages", () => {
    const input = userLine("just a question with no answer");
    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(1);
    expect(parse(result[0]).event.type).toBe("user");
  });

  it("skips corrupted lines silently", () => {
    const input = [
      "this is not valid json",
      userLine("valid message"),
      "{incomplete json",
      assistantLine([{ type: "text", text: "valid reply" }]),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(3);
  });

  it("flushes assistant group when user message follows", () => {
    const input = [
      assistantLine(
        [{ type: "thinking", thinking: "hmm" }],
        { id: "msg_flush" },
      ),
      assistantLine(
        [{ type: "text", text: "answer" }],
        { id: "msg_flush" },
      ),
      userLine("follow up"),
    ].join("\n");

    const result = parseSessionJSONL(input);
    expect(result).toHaveLength(3);
    const assistant = parse(result[0]);
    expect(assistant.event.type).toBe("assistant");
    expect(assistant.event.message.content).toHaveLength(2);
    expect(parse(result[1]).event.type).toBe("user");
  });
});

// --- parseSessionJSONL: real fixture ---

describe("parseSessionJSONL with real JSONL fixture", () => {
  const fixturePath = join(__dirname, "..", "fixtures", "session-history.jsonl");
  const fixtureContent = readFileSync(fixturePath, "utf-8");

  function parse(serialized: string): any {
    return JSON.parse(serialized);
  }

  it("parses the fixture without errors", () => {
    const result = parseSessionJSONL(fixtureContent);
    expect(result.length).toBeGreaterThan(0);
  });

  it("skips queue-operation, progress, and isMeta lines", () => {
    const result = parseSessionJSONL(fixtureContent);
    const types = result.map((r) => parse(r).event.type);
    expect(types).not.toContain("queue-operation");
    expect(types).not.toContain("progress");
    const userMessages = result
      .map((r) => parse(r))
      .filter((p) => p.event.type === "user");
    for (const u of userMessages) {
      expect(u.event.message).toBeDefined();
    }
  });

  it("produces correct event sequence: user, assistant(tool), user(tool_result), assistant(tool), user(tool_result), assistant(text), result", () => {
    const result = parseSessionJSONL(fixtureContent);

    expect(result).toHaveLength(7);

    const events = result.map((r) => parse(r));
    expect(events[0].event.type).toBe("user");
    expect(events[0].event.message.content).toContain("Search my Google Drive");

    expect(events[1].event.type).toBe("assistant");
    expect(events[1].event.message.content[0].name).toBe("Skill");

    expect(events[2].event.type).toBe("user");
    expect(events[2].event.message.content[0].type).toBe("tool_result");

    expect(events[3].event.type).toBe("assistant");
    expect(events[3].event.message.content[0].name).toBe("mcp__mise__search");

    expect(events[4].event.type).toBe("user");
    expect(events[4].event.message.content[0].type).toBe("tool_result");

    expect(events[5].event.type).toBe("assistant");
    expect(events[5].event.message.content[0].type).toBe("text");
    expect(events[5].event.message.content[0].text).toContain("No results");

    expect(events[6].event.type).toBe("result");
    expect(events[6].event.result.usage).toBeDefined();
  });

  it("preserves envelope fields needed by the adapter", () => {
    const result = parseSessionJSONL(fixtureContent);
    const assistant = parse(result[1]);

    expect(assistant.event.message.id).toBe("msg_01HeZYXk68NFgKUpAE4MeM9E");
    expect(assistant.event.message.model).toBe("claude-opus-4-6");
    expect(assistant.event.message.usage.input_tokens).toBe(3);
    expect(assistant.event.message.usage.cache_read_input_tokens).toBe(20640);
  });

  it("synthetic result uses the last assistant's usage data", () => {
    const result = parseSessionJSONL(fixtureContent);
    const synthetic = parse(result[result.length - 1]);

    expect(synthetic.event.result.usage.input_tokens).toBe(1);
    expect(synthetic.event.result.usage.cache_read_input_tokens).toBe(34443);
    expect(synthetic.event.result.usage.cache_creation_input_tokens).toBe(168);
  });

  it("all output events have source: cc", () => {
    const result = parseSessionJSONL(fixtureContent);
    for (const r of result) {
      expect(parse(r).source).toBe("cc");
    }
  });
});

// --- checkIdle ---
// The idle guard system replaces the old single-timer idle logic.
// Pure function: takes state, returns action. Caller handles side effects.

describe("checkIdle", () => {
  const T0 = 1_000_000; // arbitrary "now" for deterministic tests
  const idle: IdleSessionState = { turnInProgress: false, lastOutputTime: null };
  const noGuards: IdleGuard[] = [];

  describe("no guards (baseline — original behavior)", () => {
    it("kills after idle timeout with no guards", () => {
      const result = checkIdle(T0, false, noGuards, idle, T0 + IDLE_TIMEOUT_MS + 1);
      // No guards to defer, guardWasDeferred is false → kill
      expect(result.action).toBe("kill");
      expect(result.reason).toBe("idle timeout");
    });

    it("kills even if called early with no guards", () => {
      // checkIdle is called by the timer, so it should kill if no guard objects
      const result = checkIdle(T0, false, noGuards, idle, T0 + 1);
      expect(result.action).toBe("kill");
    });
  });

  describe("safety cap", () => {
    it("kills when safety cap exceeded regardless of guards", () => {
      const keepAliveGuard: IdleGuard = {
        name: "always-keep",
        shouldKeepAlive: () => ({ keep: true, reason: "testing" }),
      };
      const result = checkIdle(
        T0,
        false,
        [keepAliveGuard],
        idle,
        T0 + MAX_IDLE_MS + 1,
      );
      expect(result.action).toBe("kill");
      expect(result.reason).toBe("safety cap exceeded");
    });

    it("does not kill at exactly MAX_IDLE_MS", () => {
      const keepAliveGuard: IdleGuard = {
        name: "always-keep",
        shouldKeepAlive: () => ({ keep: true, reason: "testing" }),
      };
      const result = checkIdle(
        T0,
        false,
        [keepAliveGuard],
        idle,
        T0 + MAX_IDLE_MS, // exactly at boundary, not exceeded
      );
      expect(result.action).toBe("recheck");
    });
  });

  describe("guard deferral", () => {
    it("rechecks when a guard keeps alive", () => {
      const guard: IdleGuard = {
        name: "test-guard",
        shouldKeepAlive: () => ({
          keep: true,
          reason: "working hard",
          recheckMs: 15_000,
        }),
      };
      const result = checkIdle(T0, false, [guard], idle, T0 + IDLE_TIMEOUT_MS);
      expect(result).toEqual({
        action: "recheck",
        delayMs: 15_000,
        guardDeferred: true,
        reason: "kept alive by test-guard: working hard",
      });
    });

    it("uses default recheck interval when guard omits recheckMs", () => {
      const guard: IdleGuard = {
        name: "minimal",
        shouldKeepAlive: () => ({ keep: true, reason: "yes" }),
      };
      const result = checkIdle(T0, false, [guard], idle, T0 + IDLE_TIMEOUT_MS);
      expect(result.action).toBe("recheck");
      if (result.action === "recheck") {
        expect(result.delayMs).toBe(IDLE_RECHECK_MS);
      }
    });

    it("first guard wins — stops checking after first deferral", () => {
      let secondCalled = false;
      const guards: IdleGuard[] = [
        {
          name: "first",
          shouldKeepAlive: () => ({ keep: true, reason: "first wins" }),
        },
        {
          name: "second",
          shouldKeepAlive: () => {
            secondCalled = true;
            return { keep: true, reason: "should not reach" };
          },
        },
      ];
      const result = checkIdle(T0, false, guards, idle, T0 + IDLE_TIMEOUT_MS);
      expect(result.action).toBe("recheck");
      if (result.action === "recheck") {
        expect(result.reason).toContain("first");
      }
      expect(secondCalled).toBe(false);
    });

    it("falls through to next guard when first declines", () => {
      const guards: IdleGuard[] = [
        {
          name: "declines",
          shouldKeepAlive: () => ({ keep: false }),
        },
        {
          name: "keeps",
          shouldKeepAlive: () => ({ keep: true, reason: "I'm here" }),
        },
      ];
      const result = checkIdle(T0, false, guards, idle, T0 + IDLE_TIMEOUT_MS);
      expect(result.action).toBe("recheck");
      if (result.action === "recheck") {
        expect(result.reason).toContain("keeps");
      }
    });
  });

  describe("grace period", () => {
    it("grants grace period when guard stops deferring", () => {
      // guardWasDeferred=true means a guard was keeping alive last check.
      // Now no guard keeps alive → CC just finished working → grace period.
      const result = checkIdle(T0, true, noGuards, idle, T0 + IDLE_TIMEOUT_MS);
      expect(result).toEqual({
        action: "recheck",
        delayMs: IDLE_TIMEOUT_MS,
        guardDeferred: false,
        reason: "grace period — CC finished working, restarting idle countdown",
      });
    });

    it("kills after grace period elapses", () => {
      // Second call: guardWasDeferred is now false (set by previous call),
      // no guards keep alive → kill.
      const result = checkIdle(T0, false, noGuards, idle, T0 + 2 * IDLE_TIMEOUT_MS);
      expect(result.action).toBe("kill");
      expect(result.reason).toBe("idle timeout");
    });

    it("guard re-activating during grace period defers again", () => {
      // Grace period started (guardWasDeferred=false from previous recheck).
      // But CC started a new turn — guard defers again.
      const midTurn: IdleSessionState = {
        turnInProgress: true,
        lastOutputTime: T0 + IDLE_TIMEOUT_MS + 1000,
      };
      const result = checkIdle(
        T0,
        false,
        DEFAULT_IDLE_GUARDS,
        midTurn,
        T0 + IDLE_TIMEOUT_MS + 2000,
      );
      expect(result.action).toBe("recheck");
      if (result.action === "recheck") {
        expect(result.guardDeferred).toBe(true);
      }
    });
  });
});

// --- ActiveTurnGuard ---

describe("createActiveTurnGuard", () => {
  const T0 = 1_000_000;
  const guard = createActiveTurnGuard();

  it("does not keep alive when no turn in progress", () => {
    const result = guard.shouldKeepAlive(
      { turnInProgress: false, lastOutputTime: T0 },
      T0,
    );
    expect(result.keep).toBe(false);
  });

  it("keeps alive when mid-turn with recent output", () => {
    const result = guard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: T0 - 1000 },
      T0,
    );
    expect(result.keep).toBe(true);
    expect(result.reason).toBe("CC is mid-turn");
  });

  it("keeps alive when mid-turn with no output yet", () => {
    // lastOutputTime is null — CC just started, hasn't produced output.
    // This is expected during the initial API call (~8s cold start).
    const result = guard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: null },
      T0,
    );
    expect(result.keep).toBe(true);
  });

  it("declines when mid-turn but output is stale", () => {
    const result = guard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: T0 - STALE_OUTPUT_MS - 1 },
      T0,
    );
    expect(result.keep).toBe(false);
    expect(result.reason).toContain("stale");
  });

  it("keeps alive at exactly stale threshold (not exceeded)", () => {
    const result = guard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: T0 - STALE_OUTPUT_MS },
      T0,
    );
    expect(result.keep).toBe(true);
  });

  it("accepts custom stale threshold", () => {
    const shortGuard = createActiveTurnGuard(5000); // 5 seconds
    const result = shortGuard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: T0 - 6000 },
      T0,
    );
    expect(result.keep).toBe(false);
  });

  it("uses IDLE_RECHECK_MS as recheck interval", () => {
    const result = guard.shouldKeepAlive(
      { turnInProgress: true, lastOutputTime: T0 },
      T0,
    );
    expect(result.recheckMs).toBe(IDLE_RECHECK_MS);
  });
});

// --- DEFAULT_IDLE_GUARDS ---

describe("DEFAULT_IDLE_GUARDS", () => {
  it("contains exactly one guard (active-turn)", () => {
    expect(DEFAULT_IDLE_GUARDS).toHaveLength(1);
    expect(DEFAULT_IDLE_GUARDS[0].name).toBe("active-turn");
  });
});

// --- Full scenario: client disconnects while CC is working ---

describe("idle guard scenario: CC working while client away", () => {
  const T0 = 1_000_000;

  it("keeps alive → CC finishes → grace period → kill", () => {
    // 1. Client disconnects, CC is mid-turn. First check at T0 + 5min.
    const r1 = checkIdle(
      T0,
      false,
      DEFAULT_IDLE_GUARDS,
      { turnInProgress: true, lastOutputTime: T0 + IDLE_TIMEOUT_MS - 1000 },
      T0 + IDLE_TIMEOUT_MS,
    );
    expect(r1.action).toBe("recheck");
    expect(r1).toHaveProperty("guardDeferred", true);

    // 2. CC finishes work (turnInProgress = false). Recheck at +5min30s.
    const r2 = checkIdle(
      T0,
      true, // guardWasDeferred from r1
      DEFAULT_IDLE_GUARDS,
      { turnInProgress: false, lastOutputTime: T0 + IDLE_TIMEOUT_MS + 10_000 },
      T0 + IDLE_TIMEOUT_MS + IDLE_RECHECK_MS,
    );
    expect(r2.action).toBe("recheck");
    expect(r2).toHaveProperty("guardDeferred", false); // grace period
    expect(r2).toHaveProperty("delayMs", IDLE_TIMEOUT_MS); // full countdown

    // 3. Grace period elapses. Recheck at +10min30s.
    const r3 = checkIdle(
      T0,
      false, // guardWasDeferred from r2
      DEFAULT_IDLE_GUARDS,
      { turnInProgress: false, lastOutputTime: T0 + IDLE_TIMEOUT_MS + 10_000 },
      T0 + 2 * IDLE_TIMEOUT_MS + IDLE_RECHECK_MS,
    );
    expect(r3.action).toBe("kill");
    expect(r3.reason).toBe("idle timeout");
  });

  it("safety cap overrides active guard after 30 minutes", () => {
    const result = checkIdle(
      T0,
      true,
      DEFAULT_IDLE_GUARDS,
      { turnInProgress: true, lastOutputTime: T0 + MAX_IDLE_MS },
      T0 + MAX_IDLE_MS + 1,
    );
    expect(result.action).toBe("kill");
    expect(result.reason).toBe("safety cap exceeded");
  });
});
