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

function thinkingBlockStart(index = 0): Record<string, unknown> {
  return blockStart(index, { type: "thinking", thinking: "" });
}

function thinkingDelta(index: number, thinking: string): Record<string, unknown> {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "thinking", thinking },
  });
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

function apiErrorMessage(
  id: string,
  statusCode: number,
  errorType: string,
  errorMessage: string,
): Record<string, unknown> {
  const jsonBody = JSON.stringify({
    type: "error",
    error: { type: errorType, message: errorMessage },
    request_id: "req_test123",
  });
  return {
    type: "assistant",
    isApiErrorMessage: true,
    error: "unknown",
    message: {
      id,
      model: "claude-opus-4-6",
      role: "assistant",
      content: [{ type: "text", text: `API Error: ${statusCode} ${jsonBody}` }],
      stop_reason: "stop_sequence",
      usage: { input_tokens: 100, output_tokens: 0 },
    },
    session_id: "test-session-1",
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

  describe("getTurnMetrics", () => {
    it("returns token counts from last assistant usage", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        assistantMessage("msg_metrics", [{ type: "text", text: "Hi" }], {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        }),
      );
      sb.handleEvent(resultEvent());

      const metrics = sb.getTurnMetrics();
      expect(metrics.inputTokens).toBe(300); // 100 + 200
      expect(metrics.outputTokens).toBe(50);
    });

    it("counts tool calls from committed assistant message", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        assistantMessage("msg_tools", [
          { type: "text", text: "Reading files." },
          { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "foo" } },
        ]),
      );
      sb.handleEvent(resultEvent());

      const metrics = sb.getTurnMetrics();
      expect(metrics.toolCalls).toBe(2);
    });

    it("returns zeros before any events", () => {
      const sb = makeBuilder();
      const metrics = sb.getTurnMetrics();
      expect(metrics.inputTokens).toBe(0);
      expect(metrics.outputTokens).toBe(0);
      expect(metrics.toolCalls).toBe(0);
    });

    it("accumulates tool calls across multiple assistant messages in a turn (streaming)", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());

      // First assistant message: 2 tool calls (streaming path)
      sb.handleEvent(messageStart());
      sb.handleEvent(toolBlockStart(0, "Bash", "toolu_1"));
      sb.handleEvent(inputJsonDelta(0, '{"command":"ls"}'));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(toolBlockStart(1, "Read", "toolu_2"));
      sb.handleEvent(inputJsonDelta(1, '{"file_path":"/a.ts"}'));
      sb.handleEvent(blockStop(1));
      sb.handleEvent(assistantMessage("msg_1", [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/a.ts" } },
      ]));

      // Tool results come back, then a text-only assistant message
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Here are the results."));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(assistantMessage("msg_2", [{ type: "text", text: "Here are the results." }]));
      sb.handleEvent(resultEvent());

      const metrics = sb.getTurnMetrics();
      // Should count all 2 tool calls from the turn, not just the last message (0)
      expect(metrics.toolCalls).toBe(2);
    });

    it("resets tool call count on new turn", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());

      // Turn 1: 1 tool call
      sb.handleEvent(messageStart());
      sb.handleEvent(toolBlockStart(0, "Bash", "toolu_a"));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(assistantMessage("msg_t1", [
        { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
      ]));
      sb.handleEvent(resultEvent());
      expect(sb.getTurnMetrics().toolCalls).toBe(1);

      // Turn 2: system:init resets, no tool calls
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Just text."));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(assistantMessage("msg_t2", [{ type: "text", text: "Just text." }]));
      sb.handleEvent(resultEvent());
      expect(sb.getTurnMetrics().toolCalls).toBe(0);
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

    it("replays interleaved assistant/user events with merged content (dupe bug scenario)", () => {
      const sb = makeBuilder();

      // This is what parseSessionJSONL now produces for a multi-tool turn:
      // one merged assistant (tool_use + text), interleaved user (tool_result)
      const events = [
        JSON.stringify({
          source: "cc",
          event: {
            type: "assistant",
            message: {
              id: "msg_interleave",
              role: "assistant",
              content: [
                { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a.ts" } },
                { type: "text", text: "Here is the result." },
              ],
              usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
                { type: "tool_result", tool_use_id: "toolu_1", content: "file contents", is_error: false },
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

      // Single assistant message, not two
      expect(state.messages).toHaveLength(1);
      const msg = state.messages[0];
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("Here is the result.");
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0]).toMatchObject({
        name: "Read",
        status: "completed",
        output: "file contents",
      });
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

    it("detects synthetic messages by [guéridon:*] prefix", () => {
      const sb = makeBuilder();
      sb.handleEvent({
        type: "user",
        message: {
          role: "user",
          content:
            "[guéridon:system] The bridge was restarted externally and your session has been resumed. Review the conversation and continue where you left off.",
        },
      });

      expect(sb.getState().messages).toHaveLength(1);
      const msg = sb.getState().messages[0];
      expect(msg.synthetic).toBe(true);
      expect(msg.content).toBe(
        "The bridge was restarted externally and your session has been resumed. Review the conversation and continue where you left off.",
      );
      expect(msg.role).toBe("user");
    });

    it("does not flag regular user messages as synthetic", () => {
      const sb = makeBuilder();
      sb.handleEvent({
        type: "user",
        message: { role: "user", content: "Hello Claude" },
      });

      expect(sb.getState().messages[0].synthetic).toBeUndefined();
    });

    it("strips [guéridon:upload] prefix for upload deposit notes", () => {
      const sb = makeBuilder();
      sb.handleEvent({
        type: "user",
        message: {
          role: "user",
          content: "[guéridon:upload] File deposited: report.pdf (2.3 MB)",
        },
      });

      const msg = sb.getState().messages[0];
      expect(msg.synthetic).toBe(true);
      expect(msg.content).toBe("File deposited: report.pdf (2.3 MB)");
    });
  });

  describe("live event ordering: assistant before content_block_stop (bb-lonego)", () => {
    it("content delta has real text when assistant fires before content_block_stop", () => {
      const sb = makeBuilder();

      // --- Turn 1: normal ordering (works fine) ---
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "First response"));
      sb.handleEvent(blockStop(0));
      // assistant AFTER content_block_stop on first turn
      sb.handleEvent(
        assistantMessage("msg_t1", [{ type: "text", text: "First response" }]),
      );
      sb.handleEvent(resultEvent());

      expect(sb.getState().messages).toHaveLength(1);
      expect(sb.getState().messages[0].content).toBe("First response");

      // --- Turn 2: user prompt replayed, then CC responds ---
      // The user event from the prompt
      sb.handleEvent({
        type: "user",
        message: { role: "user", content: "Follow up question" },
      });

      // New turn starts
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Second response"));

      // BUG TRIGGER: assistant fires BEFORE content_block_stop on 2nd+ turns
      // (CC sends assistant before block_stop when user replay shifts ordering)
      sb.handleEvent(
        assistantMessage("msg_t2", [{ type: "text", text: "Second response" }]),
      );

      // content_block_stop fires AFTER assistant — must still emit real text
      const delta = sb.handleEvent(blockStop(0));
      expect(delta).toEqual({ type: "content", index: 0, text: "Second response" });

      // State must have the message with real content
      const state = sb.getState();
      const assistantMsgs = state.messages.filter(m => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(2);
      expect(assistantMsgs[1].content).toBe("Second response");
    });

    it("extended thinking: assistant fires after thinking block, text block patched by content_block_stop", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Thinking block (index 0)
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Let me think about this..."));
      // First assistant event fires AFTER thinking, BEFORE text block
      sb.handleEvent(
        assistantMessage("msg_think", [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Hello!" }, // CC includes full content, but streaming isn't done
        ]),
      );
      sb.handleEvent(blockStop(0)); // thinking block stop

      // Text block (index 1) starts after thinking completes
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "Hello!"));

      // Second assistant event — SAME ID, deduped
      sb.handleEvent(
        assistantMessage("msg_think", [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Hello!" },
        ]),
      );

      // Text block stop — must patch the committed message
      const delta = sb.handleEvent(blockStop(1));
      expect(delta).toEqual({ type: "content", index: 1, text: "Hello!" });

      // The critical check: state.messages must have content, not null
      sb.handleEvent(resultEvent());
      const state = sb.getState();
      const msg = state.messages[0];
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("Hello!");
    });

    it("replay still works: consecutive assistant messages without message_start", () => {
      // Verify the replaying flag doesn't break the replay path
      const sb = makeBuilder();

      const events = [
        JSON.stringify({ source: "cc", event: {
          type: "assistant",
          message: {
            id: "msg_r1", role: "assistant",
            content: [{ type: "text", text: "First" }],
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }}),
        // Second assistant message — no message_start between them in replay
        JSON.stringify({ source: "cc", event: {
          type: "assistant",
          message: {
            id: "msg_r2", role: "assistant",
            content: [{ type: "text", text: "Second" }],
            usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }}),
      ];

      sb.replayFromJSONL(events);
      const assistantMsgs = sb.getState().messages.filter(m => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(2);
      expect(assistantMsgs[0].content).toBe("First");
      expect(assistantMsgs[1].content).toBe("Second");
      // Second message must NOT inherit first's text
      expect(assistantMsgs[1].content).not.toBe("FirstSecond");
    });
  });

  describe("thinking content (gdn-vinagu)", () => {
    it("realistic CC stream: separate assistant events per block type, thinking persists in final state", () => {
      // CC sends separate assistant events for each content block type (same msg ID).
      // Only the first is processed; second/third are deduped.
      // Thinking and text come from streaming events, not the assistant content array.
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Thinking block (index 0)
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Let me reason about this."));

      // CC sends first assistant event — ONLY thinking in content array
      sb.handleEvent(
        assistantMessage("msg_real", [
          { type: "thinking", thinking: "Let me reason about this." },
        ]),
      );
      sb.handleEvent(blockStop(0)); // thinking block stop

      // Text block (index 1)
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "Here is my answer."));

      // CC sends second assistant event — ONLY text (same ID, deduped)
      sb.handleEvent(
        assistantMessage("msg_real", [
          { type: "text", text: "Here is my answer." },
        ]),
      );
      sb.handleEvent(blockStop(1)); // text block stop

      // Result
      sb.handleEvent(resultEvent());

      const state = sb.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("Here is my answer.");
      expect(state.messages[0].thinking).toBe("Let me reason about this.");
    });

    it("accumulates thinking deltas and emits thinking_content on block stop", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Thinking block
      sb.handleEvent(thinkingBlockStart(0));
      const d1 = sb.handleEvent(thinkingDelta(0, "Let me think"));
      expect(d1).toBeNull(); // accumulated, not emitted yet

      sb.handleEvent(thinkingDelta(0, " about this carefully."));

      const d2 = sb.handleEvent(blockStop(0));
      expect(d2).toEqual({
        type: "thinking_content",
        text: "Let me think about this carefully.",
      });
    });

    it("includes thinking text on the committed assistant message", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // Thinking block
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Reasoning here"));
      sb.handleEvent(blockStop(0));

      // Text block
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "The answer is 42."));
      sb.handleEvent(blockStop(1));

      // Assistant message
      sb.handleEvent(
        assistantMessage("msg_think_1", [
          { type: "thinking", thinking: "Reasoning here" },
          { type: "text", text: "The answer is 42." },
        ]),
      );
      sb.handleEvent(resultEvent());

      const state = sb.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].thinking).toBe("Reasoning here");
      expect(state.messages[0].content).toBe("The answer is 42.");
    });

    it("extracts thinking from JSONL replay content array", () => {
      const sb = makeBuilder();
      const events = [
        JSON.stringify({
          source: "cc",
          event: {
            type: "assistant",
            message: {
              id: "msg_replay_think",
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Deep thoughts" },
                { type: "text", text: "Here is my answer." },
              ],
              usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
      expect(state.messages[0].thinking).toBe("Deep thoughts");
      expect(state.messages[0].content).toBe("Here is my answer.");
    });

    it("handles multiple thinking blocks in one message", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      // First thinking block
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "First thought"));
      sb.handleEvent(blockStop(0));

      // Second thinking block
      sb.handleEvent(blockStart(1, { type: "thinking", thinking: "" }));
      sb.handleEvent(thinkingDelta(1, "Second thought"));
      const d = sb.handleEvent(blockStop(1));
      expect(d).toEqual({
        type: "thinking_content",
        text: "First thought\n\nSecond thought",
      });
    });

    it("does not emit thinking_content when thinking is empty", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());

      sb.handleEvent(thinkingBlockStart(0));
      // No thinking deltas
      const d = sb.handleEvent(blockStop(0));
      expect(d).toBeNull();
    });

    it("clears thinking between messages", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());

      // Turn 1 with thinking
      sb.handleEvent(messageStart());
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Turn 1 thought"));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "Answer 1"));
      sb.handleEvent(blockStop(1));
      sb.handleEvent(
        assistantMessage("msg_t1", [
          { type: "thinking", thinking: "Turn 1 thought" },
          { type: "text", text: "Answer 1" },
        ]),
      );
      sb.handleEvent(resultEvent());

      // Turn 2 without thinking
      sb.handleEvent(systemInit());
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Answer 2"));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(
        assistantMessage("msg_t2", [{ type: "text", text: "Answer 2" }]),
      );
      sb.handleEvent(resultEvent());

      const state = sb.getState();
      const assistantMsgs = state.messages.filter(m => m.role === "assistant");
      expect(assistantMsgs[0].thinking).toBe("Turn 1 thought");
      expect(assistantMsgs[1].thinking).toBeUndefined();
    });
  });

  describe("multi-tool turn: streaming state leakage (gdn-duzumi)", () => {
    it("second API call within same turn does not duplicate first call's text", () => {
      // Scenario: Claude thinks, writes text, calls Task tool.
      // Tool result comes back. Claude responds again (new msg_id).
      // BUG: if message_start doesn't fire between API calls,
      // currentText/currentToolCalls leak into the second handleAssistant push.
      const sb = makeBuilder();
      sb.handleEvent(systemInit());

      // --- API call 1: thinking + text + tool_use ---
      sb.handleEvent(messageStart());

      // Thinking block (index 0)
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Let me plan this."));

      // First partial assistant event (after thinking block, before text)
      sb.handleEvent(
        assistantMessage("msg_api1", [
          { type: "thinking", thinking: "Let me plan this." },
        ]),
      );
      sb.handleEvent(blockStop(0)); // thinking stop

      // Text block (index 1)
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "I'll use the Task tool to help."));

      // Second partial assistant event (same ID — deduped)
      sb.handleEvent(
        assistantMessage("msg_api1", [
          { type: "thinking", thinking: "Let me plan this." },
          { type: "text", text: "I'll use the Task tool to help." },
        ]),
      );
      sb.handleEvent(blockStop(1)); // text stop

      // Tool use block (index 2)
      sb.handleEvent(toolBlockStart(2, "Task", "toolu_task1"));
      sb.handleEvent(inputJsonDelta(2, '{"prompt": "do something"}'));

      // Third partial assistant event (same ID — deduped)
      sb.handleEvent(
        assistantMessage("msg_api1", [
          { type: "thinking", thinking: "Let me plan this." },
          { type: "text", text: "I'll use the Task tool to help." },
          { type: "tool_use", id: "toolu_task1", name: "Task", input: { prompt: "do something" } },
        ]),
      );
      sb.handleEvent(blockStop(2)); // tool stop

      // Tool result
      sb.handleEvent(toolResult("toolu_task1", "Task completed successfully"));

      // --- API call 2: Claude responds after tool result ---
      // KEY: no message_start fires here in the live CC stream
      // (message_start fires per CC turn, not per inner API call)

      // Thinking block (index 0 — reused indices for new API call)
      sb.handleEvent(thinkingBlockStart(0));
      sb.handleEvent(thinkingDelta(0, "Now I can summarize."));

      // NEW assistant event — different msg_id, passes dedup
      sb.handleEvent(
        assistantMessage("msg_api2", [
          { type: "thinking", thinking: "Now I can summarize." },
        ]),
      );
      sb.handleEvent(blockStop(0));

      // Text block (index 1)
      sb.handleEvent(textBlockStart(1));
      sb.handleEvent(textDelta(1, "Here's what the task found."));
      sb.handleEvent(
        assistantMessage("msg_api2", [
          { type: "thinking", thinking: "Now I can summarize." },
          { type: "text", text: "Here's what the task found." },
        ]),
      );
      sb.handleEvent(blockStop(1));

      sb.handleEvent(resultEvent());

      // --- Assertions ---
      const state = sb.getState();
      const assistantMsgs = state.messages.filter(m => m.role === "assistant");

      // Should have exactly 2 assistant messages (one per API call)
      expect(assistantMsgs).toHaveLength(2);

      // First message: text about Task, with Task tool call
      expect(assistantMsgs[0].content).toBe("I'll use the Task tool to help.");
      expect(assistantMsgs[0].thinking).toBe("Let me plan this.");
      expect(assistantMsgs[0].tool_calls).toHaveLength(1);
      expect(assistantMsgs[0].tool_calls![0].name).toBe("Task");

      // Second message: summary text, NO tool calls, NO leaked text from first
      expect(assistantMsgs[1].content).toBe("Here's what the task found.");
      expect(assistantMsgs[1].thinking).toBe("Now I can summarize.");
      expect(assistantMsgs[1].tool_calls).toBeUndefined();

      // The critical check: second message must NOT contain first message's text
      expect(assistantMsgs[1].content).not.toContain("I'll use the Task tool");
    });

    it("handles multiple sequential tool calls without duplication", () => {
      // Scenario: Claude calls Read, then Grep, then responds.
      // Each inner API call produces a new msg_id.
      const sb = makeBuilder();
      sb.handleEvent(systemInit());

      // --- API call 1: text + Read tool ---
      sb.handleEvent(messageStart());
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Let me read that file."));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(toolBlockStart(1, "Read", "toolu_read1"));
      sb.handleEvent(inputJsonDelta(1, '{"file_path": "/src/app.ts"}'));
      sb.handleEvent(blockStop(1));
      sb.handleEvent(
        assistantMessage("msg_read", [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: "/src/app.ts" } },
        ]),
      );
      sb.handleEvent(toolResult("toolu_read1", "file contents"));

      // --- API call 2: text + Grep tool (no message_start) ---
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Now searching for the function."));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(toolBlockStart(1, "Grep", "toolu_grep1"));
      sb.handleEvent(inputJsonDelta(1, '{"pattern": "handleEvent"}'));
      sb.handleEvent(blockStop(1));
      sb.handleEvent(
        assistantMessage("msg_grep", [
          { type: "text", text: "Now searching for the function." },
          { type: "tool_use", id: "toolu_grep1", name: "Grep", input: { pattern: "handleEvent" } },
        ]),
      );
      sb.handleEvent(toolResult("toolu_grep1", "match found"));

      // --- API call 3: final text response (no message_start) ---
      sb.handleEvent(textBlockStart(0));
      sb.handleEvent(textDelta(0, "Found it on line 42."));
      sb.handleEvent(blockStop(0));
      sb.handleEvent(
        assistantMessage("msg_final", [
          { type: "text", text: "Found it on line 42." },
        ]),
      );

      sb.handleEvent(resultEvent());

      const state = sb.getState();
      const assistantMsgs = state.messages.filter(m => m.role === "assistant");

      expect(assistantMsgs).toHaveLength(3);
      expect(assistantMsgs[0].content).toBe("Let me read that file.");
      expect(assistantMsgs[0].tool_calls).toHaveLength(1);
      expect(assistantMsgs[1].content).toBe("Now searching for the function.");
      expect(assistantMsgs[1].tool_calls).toHaveLength(1);
      expect(assistantMsgs[2].content).toBe("Found it on line 42.");
      expect(assistantMsgs[2].tool_calls).toBeUndefined();
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
      expect(state.slashCommands).toBeNull();
    });
  });

  describe("API error handling", () => {
    it("returns api_error delta with human-readable message", () => {
      const sb = makeBuilder();
      const delta = sb.handleEvent(
        apiErrorMessage("err-1", 400, "invalid_request_error", "Could not process image"),
      );
      expect(delta).toEqual({ type: "api_error", error: "API error 400: Could not process image" });
    });

    it("pushes error as assistant message and sets status to idle", () => {
      const sb = makeBuilder();
      sb.handleEvent(systemInit());
      expect(sb.getState().status).toBe("working");

      sb.handleEvent(
        apiErrorMessage("err-1", 400, "invalid_request_error", "Could not process image"),
      );
      const state = sb.getState();
      expect(state.status).toBe("idle");
      expect(state.messages).toEqual([
        { role: "assistant", content: "API error 400: Could not process image" },
      ]);
    });

    it("pushes each repeated API error as a separate message", () => {
      const sb = makeBuilder();
      sb.handleEvent(
        apiErrorMessage("err-1", 400, "invalid_request_error", "Could not process image"),
      );
      sb.handleEvent(
        apiErrorMessage("err-2", 400, "invalid_request_error", "Could not process image"),
      );
      const state = sb.getState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0].content).toBe("API error 400: Could not process image");
      expect(state.messages[1].content).toBe("API error 400: Could not process image");
    });

    it("handles API error with malformed JSON gracefully", () => {
      const sb = makeBuilder();
      const event = {
        type: "assistant",
        isApiErrorMessage: true,
        error: "unknown",
        message: {
          id: "err-bad",
          role: "assistant",
          content: [{ type: "text", text: "API Error: 500 not-json" }],
          usage: {},
        },
      };
      const delta = sb.handleEvent(event);
      expect(delta).toEqual({ type: "api_error", error: "API Error: 500 not-json" });
    });

    it("replays API error from JSONL as inline message", () => {
      const sb = makeBuilder();
      const errorEvent = apiErrorMessage(
        "err-1", 400, "invalid_request_error", "Could not process image",
      );
      const jsonlLine = JSON.stringify({ event: errorEvent });
      sb.replayFromJSONL([jsonlLine]);

      const state = sb.getState();
      expect(state.status).toBe("idle");
      expect(state.messages).toEqual([
        { role: "assistant", content: "API error 400: Could not process image" },
      ]);
    });
  });
});
