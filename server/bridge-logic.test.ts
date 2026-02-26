import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveSessionForFolder,
  isHandoffStale,
  validateFolderPath,
  buildCCArgs,
  buildSystemPrompt,
  getActiveSessions,
  parseSessionJSONL,
  isStreamDelta,
  extractDeltaInfo,
  buildMergedDelta,
  isUserTextEcho,
  extractLocalCommandOutput,
  coalescePrompts,
  LOCAL_CMD_TAIL_LINES,
  CONFLATION_INTERVAL_MS,
  type SessionProcessInfo,
  type PendingDelta,
} from "./bridge-logic.js";

// --- resolveSessionForFolder ---
// Decision tree for connecting to a folder. Handoff/exit only block resume
// when they match the latest session — stale signals from old sessions don't
// prevent resuming newer ones.

describe("resolveSessionForFolder", () => {
  const fixedId = () => "fresh-uuid-123";

  describe("existing bridge session (multi-WS reconnect)", () => {
    it("reconnects to existing bridge session", () => {
      const result = resolveSessionForFolder(
        { id: "bridge-session-1", resumable: true },
        null,
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
        "old-session-file", // handoff matches — but bridge session takes priority
        false,
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
        null, // no handoff
        false, // no .exit
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "paused-session-abc",
        resumable: true,
        isReconnect: false,
      });
    });
  });

  describe("closed folder (handoff matches latest session)", () => {
    it("creates fresh session when handoff matches", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "old-closed-session" },
        "old-closed-session", // handoff matches latest session
        false,
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });

    it("does NOT reuse session ID from closed session — the resume bug", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "should-not-reuse-this" },
        "should-not-reuse-this", // handoff matches
        false,
        fixedId,
      );
      expect(result.sessionId).not.toBe("should-not-reuse-this");
      expect(result.sessionId).toBe("fresh-uuid-123");
      expect(result.resumable).toBe(false);
    });
  });

  describe("stale handoff (handoff from old session, newer session exists)", () => {
    it("resumes newer session despite stale handoff", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "session-N-plus-1" },
        "session-N", // handoff is from older session — doesn't match
        false,
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "session-N-plus-1",
        resumable: true,
        isReconnect: false,
      });
    });
  });

  describe("fresh folder (no session files, no handoff)", () => {
    it("creates fresh session", () => {
      const result = resolveSessionForFolder(
        null,
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
      const result = resolveSessionForFolder(
        null,
        null,
        "orphan-handoff", // handoff exists but no session files
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

  it("uses the provided ID generator", () => {
    let counter = 0;
    const gen = () => `gen-${++counter}`;

    const r1 = resolveSessionForFolder(null, null, null, false, gen);
    expect(r1.sessionId).toBe("gen-1");

    const r2 = resolveSessionForFolder(null, null, "stale", false, gen);
    expect(r2.sessionId).toBe("gen-2");
  });

  describe("exited folder (.exit marker exists)", () => {
    it("creates fresh session when .exit marker exists (no handoff)", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "exited-session" },
        null, // no handoff
        true,  // has .exit marker
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });

    it("creates fresh session when both .exit and handoff exist", () => {
      const result = resolveSessionForFolder(
        null,
        { id: "exited-session" },
        "exited-session", // handoff matches
        true,  // has .exit marker
        fixedId,
      );
      expect(result).toEqual({
        sessionId: "fresh-uuid-123",
        resumable: false,
        isReconnect: false,
      });
    });
  });
});

// --- isHandoffStale (gdn-sekeca) ---
// A handoff is stale when the session was resumed after the handoff was written.

describe("isHandoffStale", () => {
  const earlier = new Date("2026-02-24T06:39:00Z");
  const later   = new Date("2026-02-24T06:41:00Z");

  it("returns true when handoff matches session and JSONL is newer", () => {
    expect(isHandoffStale("sess-1", earlier, "sess-1", later)).toBe(true);
  });

  it("returns false when handoff matches session and handoff is newer", () => {
    expect(isHandoffStale("sess-1", later, "sess-1", earlier)).toBe(false);
  });

  it("returns false when handoff matches session and times are equal", () => {
    expect(isHandoffStale("sess-1", earlier, "sess-1", earlier)).toBe(false);
  });

  it("returns false when handoff does not match session", () => {
    expect(isHandoffStale("sess-old", earlier, "sess-new", later)).toBe(false);
  });

  it("returns false when handoff is null", () => {
    expect(isHandoffStale(null, null, "sess-1", later)).toBe(false);
  });

  it("returns false when session is null", () => {
    expect(isHandoffStale("sess-1", earlier, null, null)).toBe(false);
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
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("default");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--append-system-prompt");
    // Must NOT include dangerous bypass
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("includes the mobile system prompt with machine context", () => {
    const args = buildCCArgs("x", false, "/home/modha/Repos/gueridon");
    const promptIndex = args.indexOf("--append-system-prompt");
    const prompt = args[promptIndex + 1];
    expect(prompt).toContain("mobile device");
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("Do not SSH");
    expect(prompt).toContain("/home/modha/Repos/gueridon");
  });

  it("system prompt works without folder", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Do not SSH");
    expect(prompt).toContain("mobile device");
    expect(prompt).not.toContain("Working directory");
  });

  it("system prompt includes folder when provided", () => {
    const prompt = buildSystemPrompt("/home/modha/Repos/gueridon");
    expect(prompt).toContain("Working directory: /home/modha/Repos/gueridon");
  });

  it("ends with session arg", () => {
    const args = buildCCArgs("abc", false);
    // Session args are always last
    expect(args[args.length - 2]).toBe("--session-id");
    expect(args[args.length - 1]).toBe("abc");
  });
});

// --- getActiveSessions ---

describe("getActiveSessions", () => {
  it("returns empty map for no sessions", () => {
    const sessions = new Map<string, SessionProcessInfo>();
    expect(getActiveSessions(sessions).size).toBe(0);
  });

  it("includes session with running process and activity state", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: { exitCode: null }, turnInProgress: false, clientCount: 0, contextPct: null }],
    ]);
    const active = getActiveSessions(sessions);
    const info = active.get("/repos/myproject");
    expect(info?.sessionId).toBe("sid-1");
    expect(info?.activity).toBe("waiting");
  });

  it("marks working when turnInProgress is true", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: { exitCode: null }, turnInProgress: true, clientCount: 0, contextPct: null }],
    ]);
    const info = getActiveSessions(sessions).get("/repos/myproject");
    expect(info?.activity).toBe("working");
  });

  it("excludes session with exited process and no clients", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: { exitCode: 0 }, turnInProgress: false, clientCount: 0, contextPct: null }],
    ]);
    expect(getActiveSessions(sessions).size).toBe(0);
  });

  it("excludes session with null process and no clients", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: null, turnInProgress: false, clientCount: 0, contextPct: null }],
    ]);
    expect(getActiveSessions(sessions).size).toBe(0);
  });

  it("includes session with connected clients but no process (reconnect before first prompt)", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["sid-1", { folder: "/repos/myproject", process: null, turnInProgress: false, clientCount: 1, contextPct: null }],
    ]);
    const active = getActiveSessions(sessions);
    const info = active.get("/repos/myproject");
    expect(info?.sessionId).toBe("sid-1");
    expect(info?.activity).toBe("waiting");
  });

  it("handles mixed sessions correctly", () => {
    const sessions = new Map<string, SessionProcessInfo>([
      ["active-1", { folder: "/repos/a", process: { exitCode: null }, turnInProgress: true, clientCount: 1, contextPct: null }],
      ["exited-2", { folder: "/repos/b", process: { exitCode: 1 }, turnInProgress: false, clientCount: 0, contextPct: null }],
      ["unspawned-3", { folder: "/repos/c", process: null, turnInProgress: false, clientCount: 0, contextPct: null }],
      ["active-4", { folder: "/repos/d", process: { exitCode: null }, turnInProgress: false, clientCount: 0, contextPct: null }],
      ["reconnected-5", { folder: "/repos/e", process: null, turnInProgress: false, clientCount: 2, contextPct: null }],
    ]);
    const active = getActiveSessions(sessions);
    expect(active.size).toBe(3);
    expect(active.get("/repos/a")?.activity).toBe("working");
    expect(active.get("/repos/d")?.activity).toBe("waiting");
    expect(active.get("/repos/e")?.activity).toBe("waiting");
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

// --- Conflation helpers ---

describe("isStreamDelta", () => {
  it("returns true for content_block_delta", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    };
    expect(isStreamDelta(event)).toBe(true);
  });

  it("returns false for content_block_start", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    };
    expect(isStreamDelta(event)).toBe(false);
  });

  it("returns false for message_start", () => {
    const event = {
      type: "stream_event",
      event: { type: "message_start", message: {} },
    };
    expect(isStreamDelta(event)).toBe(false);
  });

  it("returns false for non-stream events", () => {
    expect(isStreamDelta({ type: "result" })).toBe(false);
    expect(isStreamDelta({ type: "assistant" })).toBe(false);
    expect(isStreamDelta({ type: "system" })).toBe(false);
    expect(isStreamDelta({ type: "user" })).toBe(false);
  });
});

describe("extractDeltaInfo", () => {
  it("extracts text_delta info", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    };
    const info = extractDeltaInfo(event);
    expect(info).toEqual({
      key: "0:text_delta",
      index: 0,
      deltaType: "text_delta",
      field: "text",
      payload: "hello",
    });
  });

  it("extracts input_json_delta info", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd' } },
    };
    const info = extractDeltaInfo(event);
    expect(info).toEqual({
      key: "1:input_json_delta",
      index: 1,
      deltaType: "input_json_delta",
      field: "partial_json",
      payload: '{"cmd',
    });
  });

  it("extracts thinking delta info", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking", thinking: "Let me" } },
    };
    const info = extractDeltaInfo(event);
    expect(info).toEqual({
      key: "0:thinking",
      index: 0,
      deltaType: "thinking",
      field: "thinking",
      payload: "Let me",
    });
  });

  it("returns null for unknown delta subtype", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "future_type", data: "x" } },
    };
    expect(extractDeltaInfo(event)).toBeNull();
  });

  it("returns null for non-delta stream events", () => {
    const event = {
      type: "stream_event",
      event: { type: "message_start", message: {} },
    };
    expect(extractDeltaInfo(event)).toBeNull();
  });

  it("returns null for non-stream events", () => {
    expect(extractDeltaInfo({ type: "result" })).toBeNull();
  });

  it("handles empty text payload", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } },
    };
    const info = extractDeltaInfo(event);
    expect(info?.payload).toBe("");
  });

  it("uses different keys for different indices", () => {
    const event0 = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
    };
    const event1 = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "b" } },
    };
    expect(extractDeltaInfo(event0)?.key).toBe("0:text_delta");
    expect(extractDeltaInfo(event1)?.key).toBe("1:text_delta");
  });
});

describe("buildMergedDelta", () => {
  it("builds a text_delta event from accumulated text", () => {
    const pending: PendingDelta = {
      index: 0,
      deltaType: "text_delta",
      field: "text",
      accumulated: "Hello world",
    };
    expect(buildMergedDelta(pending)).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      },
    });
  });

  it("builds an input_json_delta event", () => {
    const pending: PendingDelta = {
      index: 1,
      deltaType: "input_json_delta",
      field: "partial_json",
      accumulated: '{"command":"ls"}',
    };
    expect(buildMergedDelta(pending)).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
    });
  });

  it("builds a thinking delta event", () => {
    const pending: PendingDelta = {
      index: 0,
      deltaType: "thinking",
      field: "thinking",
      accumulated: "Let me think about this carefully",
    };
    expect(buildMergedDelta(pending)).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking", thinking: "Let me think about this carefully" },
      },
    });
  });
});

// --- isUserTextEcho ---

describe("isUserTextEcho", () => {
  it("returns true for user text message (CC echo from --replay-user-messages)", () => {
    const event = {
      type: "user",
      message: { role: "user", content: "Say hello" },
      session_id: "abc",
      parent_tool_use_id: null,
    };
    expect(isUserTextEcho(event)).toBe(true);
  });

  it("returns false for user tool_result message (array content)", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "output", is_error: false }],
      },
    };
    expect(isUserTextEcho(event)).toBe(false);
  });

  it("returns false for assistant events", () => {
    expect(isUserTextEcho({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBe(false);
  });

  it("returns false for result events", () => {
    expect(isUserTextEcho({ type: "result" })).toBe(false);
  });

  it("returns false for system events", () => {
    expect(isUserTextEcho({ type: "system", subtype: "init" })).toBe(false);
  });

  it("returns false for stream events", () => {
    expect(isUserTextEcho({ type: "stream_event", event: { type: "message_start" } })).toBe(false);
  });

  it("returns false for user event with missing message", () => {
    expect(isUserTextEcho({ type: "user" })).toBe(false);
  });

  it("returns false for user event with content array (image prompt via bridge)", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } },
          { type: "text", text: "What's in this image?" },
        ],
      },
    };
    expect(isUserTextEcho(event)).toBe(false);
  });

  it("returns false for local command output wrapped in <local-command-stdout>", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>## Context Usage\n\n**Model:** claude-opus-4-6\n</local-command-stdout>",
      },
    };
    expect(isUserTextEcho(event)).toBe(false);
  });
});

// --- isUserTextEcho with content-array messages (gdn-tezima) ---

describe("isUserTextEcho with content-array user messages", () => {
  it("array-content user event is NOT a text echo", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
          { type: "text", text: "What's in this image?" },
        ],
      },
    };
    expect(isUserTextEcho(event)).toBe(false);
  });
});

// --- lobbyQueue error recovery (gdn-zibeji) ---

describe("lobby queue error recovery pattern", () => {
  it("subsequent messages process after a failure", async () => {
    const results: string[] = [];
    let queue = Promise.resolve();

    const failingHandler = async () => {
      throw new Error("folder scan failed");
    };
    const succeedingHandler = async () => {
      results.push("ok");
    };

    queue = queue.then(failingHandler).catch(() => { /* bridge logs here */ });
    queue = queue.then(succeedingHandler).catch(() => {});

    await queue;
    expect(results).toEqual(["ok"]);
  });
});

// --- connectFolder session reuse (gdn-zibeji) ---

describe("resolveSessionForFolder reuse", () => {
  it("reconnects to existing bridge session", () => {
    const existing = { id: "existing-uuid", resumable: true };
    const result = resolveSessionForFolder(
      existing,
      { id: "existing-uuid" },
      "existing-uuid",
      false,
      () => "should-not-be-called",
    );
    expect(result.isReconnect).toBe(true);
    expect(result.sessionId).toBe("existing-uuid");
  });

  it("does not call UUID generator when reconnecting", () => {
    let uuidCalled = false;
    const existing = { id: "existing-uuid", resumable: true };
    const result = resolveSessionForFolder(
      existing,
      { id: "existing-uuid" },
      null,
      false,
      () => { uuidCalled = true; return "new-uuid"; },
    );
    expect(result.isReconnect).toBe(true);
    expect(uuidCalled).toBe(false);
  });
});

// --- extractLocalCommandOutput ---
// Recovery function for local commands (/context, /cost, /compact) that produce
// no stdout in CC pipe mode. The output IS in the session JSONL — this function
// finds it in the tail.

describe("extractLocalCommandOutput", () => {
  /** Helper: make a JSONL user line with string content. */
  function userLine(content: string): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
  }

  /** Helper: make a JSONL assistant line. */
  function assistantLine(text: string): string {
    return JSON.stringify({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text }] },
    });
  }

  it("recovers local-command-stdout from last line", () => {
    const content = [
      userLine("/context"),
      userLine("<local-command-stdout>Tokens: 73.3k / 200k (37%)</local-command-stdout>"),
    ].join("\n");

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();

    const parsed = JSON.parse(result!);
    expect(parsed.source).toBe("cc");
    expect(parsed.event.type).toBe("user");
    expect(parsed.event.message.content).toContain("<local-command-stdout>");
    expect(parsed.event.message.content).toContain("73.3k");
  });

  it("recovers when stdout is within last 5 lines but not the last", () => {
    const content = [
      userLine("<local-command-stdout>Cost: $0.42</local-command-stdout>"),
      assistantLine("some response"),
      userLine("follow up question"),
    ].join("\n");

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();

    const parsed = JSON.parse(result!);
    expect(parsed.event.message.content).toContain("$0.42");
  });

  it("returns null when no local-command-stdout in tail", () => {
    const content = [
      userLine("hello"),
      assistantLine("world"),
      userLine("how are you"),
    ].join("\n");

    expect(extractLocalCommandOutput(content)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractLocalCommandOutput("")).toBeNull();
  });

  it("returns null for whitespace-only content", () => {
    expect(extractLocalCommandOutput("  \n  \n  ")).toBeNull();
  });

  it("ignores local-command-stdout beyond the tail window", () => {
    // Put stdout at position 0, then pad with more than LOCAL_CMD_TAIL_LINES lines
    const lines = [
      userLine("<local-command-stdout>old output</local-command-stdout>"),
    ];
    for (let i = 0; i < LOCAL_CMD_TAIL_LINES + 1; i++) {
      lines.push(userLine(`message ${i}`));
    }
    const content = lines.join("\n");

    expect(extractLocalCommandOutput(content)).toBeNull();
  });

  it("skips non-user entries when searching", () => {
    const content = [
      assistantLine("thinking..."),
      JSON.stringify({ type: "system", subtype: "init", cwd: "/test" }),
      userLine("<local-command-stdout>Model: opus-4-6</local-command-stdout>"),
    ].join("\n");

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.event.message.content).toContain("opus-4-6");
  });

  it("skips corrupted JSON lines without throwing", () => {
    const content = [
      "this is not valid json",
      "{broken",
      userLine("<local-command-stdout>recovered despite corruption</local-command-stdout>"),
    ].join("\n");

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.event.message.content).toContain("recovered despite corruption");
  });

  it("ignores user messages without local-command-stdout", () => {
    const content = [
      userLine("normal message"),
      userLine("<command-name>/context</command-name>"),
      userLine("<local-command-caveat>Local commands may not work</local-command-caveat>"),
    ].join("\n");

    expect(extractLocalCommandOutput(content)).toBeNull();
  });

  it("returns the LAST match when multiple stdout entries exist in tail", () => {
    // Searches backwards, so returns the last one found
    const content = [
      userLine("<local-command-stdout>first: context</local-command-stdout>"),
      userLine("<local-command-stdout>second: cost</local-command-stdout>"),
    ].join("\n");

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    // Walking backwards → finds "second" first
    expect(parsed.event.message.content).toContain("second: cost");
  });

  it("handles JSONL with trailing newlines", () => {
    const content = userLine("<local-command-stdout>output</local-command-stdout>") + "\n\n\n";

    const result = extractLocalCommandOutput(content);
    expect(result).not.toBeNull();
  });
});

describe("coalescePrompts", () => {
  it("returns null for empty queue", () => {
    expect(coalescePrompts([])).toBeNull();
  });

  it("passes single message through unchanged", () => {
    const msg = { text: "hello" };
    expect(coalescePrompts([msg])).toBe(msg);
  });

  it("concatenates two messages with numbered markers", () => {
    const result = coalescePrompts([
      { text: "first" },
      { text: "second" },
    ]);
    expect(result).toEqual({ text: "[1/2] first\n\n[2/2] second" });
  });

  it("concatenates three messages with correct numbering", () => {
    const result = coalescePrompts([
      { text: "alpha" },
      { text: "beta" },
      { text: "gamma" },
    ]);
    expect(result!.text).toBe("[1/3] alpha\n\n[2/3] beta\n\n[3/3] gamma");
  });

  it("handles empty text in some prompts", () => {
    const result = coalescePrompts([
      { text: "real message" },
      { text: "" },
      { text: "another" },
    ]);
    expect(result!.text).toBe("[1/3] real message\n\n[2/3] \n\n[3/3] another");
  });

  it("handles prompts with no text field", () => {
    const result = coalescePrompts([
      { text: "has text" },
      { content: [{ type: "text", text: "content array" }] },
    ]);
    expect(result!.text).toBe("[1/2] has text\n\n[2/2] ");
  });
});
