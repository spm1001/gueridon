import { describe, it, expect } from "vitest";
import { StateBuilder } from "./state-builder.js";

// -- Canned event factories --

function systemInit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    model: "claude-opus-4-6",
    session_id: "test-session-1",
    cwd: "/test",
    ...overrides,
  };
}

function streamEvent(inner: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event: inner, session_id: "test-session-1" };
}

function messageStart(): Record<string, unknown> {
  return streamEvent({ type: "message_start" });
}

function blockStart(index: number, block: Record<string, unknown>): Record<string, unknown> {
  return streamEvent({ type: "content_block_start", index, content_block: block });
}

function textBlockStart(index = 0): Record<string, unknown> {
  return blockStart(index, { type: "text", text: "" });
}

function toolBlockStart(index: number, name: string, id: string): Record<string, unknown> {
  return blockStart(index, { type: "tool_use", id, name });
}

function textDelta(index: number, text: string): Record<string, unknown> {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function inputJsonDelta(index: number, partialJson: string): Record<string, unknown> {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

function blockStop(index: number): Record<string, unknown> {
  return streamEvent({ type: "content_block_stop", index });
}

function assistantMessage(
  id: string,
  content: unknown[],
  usage: Record<string, number> = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      id,
      model: "claude-opus-4-6",
      role: "assistant",
      content,
      stop_reason: null,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
    session_id: "test-session-1",
  };
}

function toolResult(
  toolUseId: string,
  content: string | unknown[],
  isError = false,
): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}

function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    result: "",
    modelUsage: {
      "claude-opus-4-6": {
        contextWindow: 200000,
        costUSD: 0.05,
        inputTokens: 100,
        outputTokens: 10,
      },
    },
    ...overrides,
  };
}

// -- Tests --

describe("StateBuilder", () => {
  function makeBuilder(): StateBuilder {
    return new StateBuilder("test-session-1", "test-project");
  }

  describe("text-only turn", () => {
    it("accumulates text deltas and produces assistant message on result", () => {
      const sb = makeBuilder();

      // init → working
      const d1 = sb.handleEvent(systemInit());
      expect(d1).toEqual({ type: "status", status: "working" });
      expect(sb.getState().status).toBe("working");

      // message_start
      sb.handleEvent(messageStart());

      // text block start
      const d2 = sb.handleEvent(textBlockStart(0));
      expect(d2).toEqual({ type: "activity", activity: "writing" });

      // text deltas — accumulated, no delta emitted
      expect(sb.handleEvent(textDelta(0, "Hello "))).toBeNull();
      expect(sb.handleEvent(textDelta(0, "world"))).toBeNull();

      // block stop — emits content delta with full text
      const d3 = sb.handleEvent(blockStop(0));
      expect(d3).toEqual({ type: "content", index: 0, text: "Hello world" });

      // assistant complete message
      sb.handleEvent(
        assistantMessage("msg_001", [{ type: "text", text: "Hello world" }]),
      );

      // result → idle
      const d4 = sb.handleEvent(resultEvent());
      expect(d4).toEqual({ type: "status", status: "idle" });
      expect(sb.getState().status).toBe("idle");

      // State has one assistant message
      const state = sb.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({
        role: "assistant",
        content: "Hello world",
      });
    });

    it("sets model from init event", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit({ model: "claude-sonnet-4-6" }));
      expect(sb.getState().session.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("tool call turn", () => {
    it("handles tool_use block with input_json_delta and tool_result", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // tool block start
      const d1 = sb.handleEvent(toolBlockStart(0, "Bash", "toolu_001"));
      expect(d1).toEqual({ type: "activity", activity: "tool" });

      // input JSON arrives in fragments
      sb.handleEvent(inputJsonDelta(0, '{"comma'));
      sb.handleEvent(inputJsonDelta(0, 'nd": "ls -la"}'));

      // block stop — parses JSON, extracts tool input
      const d2 = sb.handleEvent(blockStop(0));
      expect(d2).toEqual({
        type: "tool_start",
        index: 0,
        name: "Bash",
        input: "ls -la",
      });

      // assistant complete message (with tool_use in content)
      sb.handleEvent(
        assistantMessage("msg_002", [
          { type: "tool_use", id: "toolu_001", name: "Bash", input: { command: "ls -la" } },
        ]),
      );

      // tool result
      const d3 = sb.handleEvent(toolResult("toolu_001", "file1.txt\nfile2.txt"));
      expect(d3).toEqual({
        type: "tool_complete",
        index: 0,
        status: "completed",
        output: "file1.txt\nfile2.txt",
      });

      // result
      sb.handleEvent(resultEvent());

      const state = sb.getState();
      expect(state.messages).toHaveLength(1);
      const msg = state.messages[0];
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0]).toEqual({
        name: "Bash",
        status: "completed",
        input: "ls -la",
        output: "file1.txt\nfile2.txt",
        collapsed: true,
      });
    });

    it("marks errored tool results", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(toolBlockStart(0, "Bash", "toolu_err"));
      sb.handleEvent(inputJsonDelta(0, '{"command": "bad"}'));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(
        assistantMessage("msg_err", [
          { type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "bad" } },
        ]),
      );

      const d = sb.handleEvent(toolResult("toolu_err", "exit code 1", true));
      expect(d).toMatchObject({ type: "tool_complete", status: "error" });

      sb.handleEvent(resultEvent());
      const call = sb.getState().messages[0].tool_calls![0];
      expect(call.status).toBe("error");
    });

    it("extracts file_path for Read tool", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(toolBlockStart(0, "Read", "toolu_read"));
      sb.handleEvent(inputJsonDelta(0, '{"file_path": "/tmp/test.ts"}'));
      sb.handleEvent(blockStop(0));

      const state = sb.getState();
      // Tool call input should be the file path, not raw JSON
      // (tool isn't in messages yet — it's in currentToolCalls, check via next assistant)
      sb.handleEvent(
        assistantMessage("msg_read", [
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ]),
      );
      sb.handleEvent(toolResult("toolu_read", "file contents"));
      sb.handleEvent(resultEvent());

      expect(sb.getState().messages[0].tool_calls![0].input).toBe("/tmp/test.ts");
    });
  });

  describe("multi-tool turn with parallel tool calls", () => {
    it("tracks multiple tool blocks with separate IDs", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Two parallel tool calls
      sb.handleEvent(toolBlockStart(0, "Read", "toolu_r1"));
      sb.handleEvent(inputJsonDelta(0, '{"file_path": "/a.ts"}'));
      sb.handleEvent(toolBlockStart(1, "Read", "toolu_r2"));
      sb.handleEvent(inputJsonDelta(1, '{"file_path": "/b.ts"}'));

      // Both stop
      sb.handleEvent(blockStop(0));
      sb.handleEvent(blockStop(1));

      // Assistant message
      sb.handleEvent(
        assistantMessage("msg_multi", [
          { type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "toolu_r2", name: "Read", input: { file_path: "/b.ts" } },
        ]),
      );

      // Tool results arrive as a batch
      sb.handleEvent({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_r1", content: "contents of a", is_error: false },
            { type: "tool_result", tool_use_id: "toolu_r2", content: "contents of b", is_error: false },
          ],
        },
      });

      sb.handleEvent(resultEvent());

      const calls = sb.getState().messages[0].tool_calls!;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ name: "Read", input: "/a.ts", status: "completed" });
      expect(calls[1]).toMatchObject({ name: "Read", input: "/b.ts", status: "completed" });
    });

    it("handles text block followed by tool block in same message", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Text block first
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Let me check that file."));
      sb.handleEvent(blockStop(0));

      // Then tool block
      sb.handleEvent(toolBlockStart(1, "Read", "toolu_mixed"));
      sb.handleEvent(inputJsonDelta(1, '{"file_path": "/c.ts"}'));
      sb.handleEvent(blockStop(1));

      // Assistant message
      sb.handleEvent(
        assistantMessage("msg_mixed", [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", id: "toolu_mixed", name: "Read", input: { file_path: "/c.ts" } },
        ]),
      );

      sb.handleEvent(toolResult("toolu_mixed", "file content"));
      sb.handleEvent(resultEvent());

      const msg = sb.getState().messages[0];
      expect(msg.content).toBe("Let me check that file.");
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0].input).toBe("/c.ts");
    });
  });

  describe("JSONL replay via replayFromJSONL", () => {
    it("rebuilds state from complete assistant messages (no streaming events)", () => {
      const sb = makeBuilder();

      // JSONL has the envelope format: {"source": "cc", "event": {...}}
      const events = [
        JSON.stringify({
          source: "cc",
          event: { type: "user", message: { role: "user", content: "What is 1+1?" } },
        }),
        JSON.stringify({
          source: "cc",
          event: {
            type: "assistant",
            message: {
              id: "msg_replay_1",
              role: "assistant",
              content: [{ type: "text", text: "2" }],
              usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
        }),
        JSON.stringify({
          source: "cc",
          event: {
            type: "result",
            subtype: "success",
            is_error: false,
            modelUsage: {
              "claude-opus-4-6": { contextWindow: 200000, costUSD: 0.01 },
            },
          },
        }),
      ];

      sb.replayFromJSONL(events);

      const state = sb.getState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]).toEqual({ role: "user", content: "What is 1+1?" });
      expect(state.messages[1]).toEqual({ role: "assistant", content: "2" });
      expect(state.status).toBe("idle");
    });

    it("replays tool calls from assistant content array", () => {
      const sb = makeBuilder();

      const events = [
        JSON.stringify({
          source: "cc",
          event: {
            type: "assistant",
            message: {
              id: "msg_replay_tool",
              role: "assistant",
              content: [
                { type: "text", text: "Let me read that." },
                { type: "tool_use", id: "toolu_replay", name: "Read", input: { file_path: "/test.ts" } },
              ],
              usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
        }),
        JSON.stringify({
          source: "cc",
          event: {
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_replay", content: "file contents here", is_error: false },
              ],
            },
          },
        }),
        JSON.stringify({
          source: "cc",
          event: { type: "result", subtype: "success", is_error: false, modelUsage: {} },
        }),
      ];

      sb.replayFromJSONL(events);

      const state = sb.getState();
      expect(state.messages).toHaveLength(1);
      const msg = state.messages[0];
      expect(msg.content).toBe("Let me read that.");
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0]).toMatchObject({
        name: "Read",
        input: "/test.ts",
        status: "completed",
        output: "file contents here",
      });
    });

    it("deduplicates assistant messages by ID", () => {
      const sb = makeBuilder();

      // Same message ID twice — should only appear once
      const assistantEvent = JSON.stringify({
        source: "cc",
        event: {
          type: "assistant",
          message: {
            id: "msg_dedup",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
      });

      sb.replayFromJSONL([assistantEvent, assistantEvent]);
      expect(sb.getState().messages).toHaveLength(1);
    });

    it("multi-turn replay: second assistant message does not inherit first turn's tool calls", () => {
      const sb = makeBuilder();
      const events = [
        // Turn 1: assistant uses a tool
        JSON.stringify({ source: "cc", event: {
          type: "assistant",
          message: {
            id: "msg_turn1",
            role: "assistant",
            content: [
              { type: "text", text: "Let me check that." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a.ts" } },
            ],
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }}),
        // Tool result
        JSON.stringify({ source: "cc", event: {
          type: "user",
          message: { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file contents", is_error: false },
          ]},
        }}),
        // Turn 2: pure text follow-up, no tools
        JSON.stringify({ source: "cc", event: {
          type: "assistant",
          message: {
            id: "msg_turn2",
            role: "assistant",
            content: [{ type: "text", text: "Here is the result." }],
            usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }}),
      ];

      sb.replayFromJSONL(events);
      const state = sb.getState();

      // Should have user message + 2 assistant messages
      const assistantMsgs = state.messages.filter(m => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(2);

      // First assistant message has the tool call with output attached
      expect(assistantMsgs[0].tool_calls).toHaveLength(1);
      expect(assistantMsgs[0].tool_calls![0].output).toBe("file contents");

      // Second assistant message must NOT inherit turn 1's tool calls
      expect(assistantMsgs[1].tool_calls).toBeUndefined();
      expect(assistantMsgs[1].content).toBe("Here is the result.");
    });

    it("skips malformed JSONL lines", () => {
      const sb = makeBuilder();
      sb.replayFromJSONL(["not json", "{}", '{"source":"cc"}']);
      expect(sb.getState().messages).toHaveLength(0);
    });
  });

  describe("context_pct tracking", () => {
    it("computes context_pct from usage and contextWindow", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Hi"));
      sb.handleEvent(blockStop(0));

      // Assistant message with usage: 50k input tokens out of 200k window = 25%
      sb.handleEvent(
        assistantMessage("msg_ctx", [{ type: "text", text: "Hi" }], {
          input_tokens: 10000,
          cache_read_input_tokens: 30000,
          cache_creation_input_tokens: 10000,
          output_tokens: 5,
        }),
      );

      // Before result — context_pct computed from usage / default 200k window
      expect(sb.getState().session.context_pct).toBe(25); // 50000/200000 = 25%

      // Result with modelUsage.contextWindow = 100000 → recomputes to 50%
      sb.handleEvent(
        resultEvent({
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: 100000,
              costUSD: 0.05,
            },
          },
        }),
      );

      expect(sb.getState().session.context_pct).toBe(50); // 50000/100000 = 50%
    });

    it("tracks context_pct across multiple turns", () => {
      const sb = makeBuilder();

      // Turn 1
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Hi"));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(
        assistantMessage("msg_t1", [{ type: "text", text: "Hi" }], {
          input_tokens: 20000,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      );
      sb.handleEvent(resultEvent());
      expect(sb.getState().session.context_pct).toBe(10); // 20000/200000

      // Turn 2 — context grew
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "More"));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(
        assistantMessage("msg_t2", [{ type: "text", text: "More" }], {
          input_tokens: 80000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      );
      sb.handleEvent(resultEvent());
      expect(sb.getState().session.context_pct).toBe(40); // 80000/200000
    });
  });

  describe("slash command normalisation", () => {
    it("normalises string-shaped commands", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        systemInit({
          slash_commands: ["/context", "/cost", "/compact"],
        }),
      );

      const cmds = sb.getState().slashCommands!;
      expect(cmds).toHaveLength(3);
      expect(cmds[0]).toEqual({ name: "context", description: "", local: true });
      expect(cmds[1]).toEqual({ name: "cost", description: "", local: true });
      expect(cmds[2]).toEqual({ name: "compact", description: "", local: true });
    });

    it("normalises object-shaped commands", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        systemInit({
          slash_commands: [
            { name: "/review", description: "Review code" },
            { name: "/help", description: "Get help" },
          ],
        }),
      );

      const cmds = sb.getState().slashCommands!;
      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toEqual({ name: "review", description: "Review code", local: false });
      expect(cmds[1]).toEqual({ name: "help", description: "Get help", local: true });
    });

    it("handles mixed string and object shapes", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        systemInit({
          slash_commands: ["/context", { name: "/review", description: "Review" }],
        }),
      );

      const cmds = sb.getState().slashCommands!;
      expect(cmds).toHaveLength(2);
      expect(cmds[0].name).toBe("context");
      expect(cmds[0].local).toBe(true);
      expect(cmds[1].name).toBe("review");
      expect(cmds[1].local).toBe(false);
    });

    it("slash commands are null before init", () => {
      const sb = makeBuilder();
      expect(sb.getState().slashCommands).toBeNull();
    });
  });

  describe("user message handling", () => {
    it("adds user text messages", () => {
      const sb = makeBuilder();
      sb.handleEvent({
        type: "user",
        message: { role: "user", content: "Hello Claude" },
      });

      expect(sb.getState().messages).toHaveLength(1);
      expect(sb.getState().messages[0]).toEqual({
        role: "user",
        content: "Hello Claude",
      });
    });
  });

  describe("initial state", () => {
    it("starts with correct defaults", () => {
      const sb = makeBuilder();
      const state = sb.getState();

      expect(state.session).toEqual({
        id: "test-session-1",
        model: "",
        project: "test-project",
        context_pct: 0,
      });
      expect(state.messages).toEqual([]);
      expect(state.connection).toBe("connected");
      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();
      expect(state.slashCommands).toBeNull();
    });
  });
});
