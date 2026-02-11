import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeAgent, type CCTransport, type AskUserQuestionData } from "./claude-code-agent.js";

let agent: ClaudeCodeAgent;
let events: any[];

function eventsOfType(type: string) {
  return events.filter((e) => e.type === type);
}

beforeEach(() => {
  agent = new ClaudeCodeAgent();
  events = [];
  agent.subscribe((e) => events.push({ ...e }));
});

// --- Pure helper methods (tested via as any) ---

describe("mapContentBlocks", () => {
  it("maps text blocks unchanged", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "text", text: "hello" },
    ]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("maps tool_use to toolCall", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
    ]);
    expect(result).toEqual([
      { type: "toolCall", id: "toolu_1", name: "Bash", arguments: { command: "ls" } },
    ]);
  });

  it("maps tool_use with missing input to empty object", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "tool_use", id: "toolu_1", name: "Read" },
    ]);
    expect(result[0].arguments).toEqual({});
  });

  it("maps thinking blocks", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "thinking", thinking: "Let me think...", signature: "sig_abc" },
    ]);
    expect(result).toEqual([
      { type: "thinking", thinking: "Let me think...", thinkingSignature: "sig_abc" },
    ]);
  });

  it("passes unknown block types through", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "image", data: "..." },
    ]);
    expect(result).toEqual([{ type: "image", data: "..." }]);
  });

  it("handles mixed content blocks", () => {
    const result = (agent as any).mapContentBlocks([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo" } },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("thinking");
    expect(result[1].type).toBe("text");
    expect(result[2].type).toBe("toolCall");
  });
});

describe("mapUsage", () => {
  it("maps full usage object", () => {
    const result = (agent as any).mapUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    });
    expect(result.input).toBe(100);
    expect(result.output).toBe(50);
    expect(result.cacheRead).toBe(200);
    expect(result.cacheWrite).toBe(30);
    expect(result.totalTokens).toBe(380);
  });

  it("returns empty usage for null", () => {
    const result = (agent as any).mapUsage(null);
    expect(result.totalTokens).toBe(0);
  });

  it("handles partial usage (missing fields default to 0)", () => {
    const result = (agent as any).mapUsage({ input_tokens: 50 });
    expect(result.input).toBe(50);
    expect(result.output).toBe(0);
    expect(result.totalTokens).toBe(50);
  });
});

describe("mapStopReason", () => {
  it("maps tool_use to toolUse", () => {
    expect((agent as any).mapStopReason("tool_use")).toBe("toolUse");
  });

  it("maps end_turn to stop", () => {
    expect((agent as any).mapStopReason("end_turn")).toBe("stop");
  });

  it("maps max_tokens to stop", () => {
    expect((agent as any).mapStopReason("max_tokens")).toBe("stop");
  });

  it("maps null to stop", () => {
    expect((agent as any).mapStopReason(null)).toBe("stop");
  });

  it("maps unknown reason to stop", () => {
    expect((agent as any).mapStopReason("something_else")).toBe("stop");
  });
});

// --- Event handling (the core translation) ---

describe("system/init", () => {
  it("extracts CWD from init event", () => {
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/Users/test/project" });
    expect(agent.cwd).toBe("/Users/test/project");
  });

  it("fires onCwdChange callback", () => {
    let received = "";
    agent.onCwdChange = (cwd) => { received = cwd; };
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/foo" });
    expect(received).toBe("/foo");
  });

  it("ignores CWD from subsequent init events", () => {
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/first" });
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/second" });
    expect(agent.cwd).toBe("/first");
  });

  it("ignores init events without cwd", () => {
    agent.handleCCEvent({ type: "system", subtype: "hook_started" });
    expect(agent.cwd).toBe("");
  });
});

describe("text response streaming", () => {
  function feedTextStream(text: string) {
    // message_start
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    // content_block_start
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    // content_block_delta
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    });
  }

  it("creates stream message on message_start", () => {
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    expect(agent.state.streamMessage).not.toBeNull();
    expect(agent.state.streamMessage?.role).toBe("assistant");
    expect(eventsOfType("message_start")).toHaveLength(1);
  });

  it("accumulates text deltas", () => {
    feedTextStream("Hello");
    expect(agent.state.streamMessage?.content[0]).toEqual({ type: "text", text: "Hello" });

    // Another delta
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    });
    expect(agent.state.streamMessage?.content[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("emits message_update events on each delta", () => {
    feedTextStream("Hi");
    const updates = eventsOfType("message_update");
    // content_block_start emits one update, delta emits another
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("finalizes message on assistant complete event", () => {
    feedTextStream("Hello");

    // Complete assistant message
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].role).toBe("assistant");
    expect(agent.state.messages[0].content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(eventsOfType("message_end")).toHaveLength(1);
  });

  it("clears streaming state on result event", () => {
    feedTextStream("Hello");

    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });

    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(eventsOfType("turn_end")).toHaveLength(1);
    expect(eventsOfType("agent_end")).toHaveLength(1);
  });
});

describe("tool use", () => {
  function feedToolUseAssistant() {
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_abc", name: "Bash", input: { command: "echo hello" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
  }

  it("maps tool_use content to toolCall in message", () => {
    feedToolUseAssistant();

    const msg = agent.state.messages[0];
    expect(msg.content[0]).toEqual({
      type: "toolCall",
      id: "toolu_abc",
      name: "Bash",
      arguments: { command: "echo hello" },
    });
  });

  it("adds tool call to pendingToolCalls", () => {
    feedToolUseAssistant();
    expect(agent.state.pendingToolCalls.has("toolu_abc")).toBe(true);
  });

  it("emits tool_execution_start event", () => {
    feedToolUseAssistant();
    const starts = eventsOfType("tool_execution_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("toolu_abc");
    expect(starts[0].toolName).toBe("Bash");
  });

  it("processes tool_result from user event", () => {
    feedToolUseAssistant();

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "toolu_abc", type: "tool_result", content: "hello", is_error: false },
        ],
      },
    });

    // Tool result message added
    const lastMsg = agent.state.messages[agent.state.messages.length - 1];
    expect(lastMsg.role).toBe("toolResult");
    expect((lastMsg as any).toolCallId).toBe("toolu_abc");
    expect((lastMsg as any).toolName).toBe("Bash");
    expect(lastMsg.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("removes tool call from pending after result", () => {
    feedToolUseAssistant();
    expect(agent.state.pendingToolCalls.has("toolu_abc")).toBe(true);

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "toolu_abc", type: "tool_result", content: "hello", is_error: false },
        ],
      },
    });

    expect(agent.state.pendingToolCalls.has("toolu_abc")).toBe(false);
  });

  it("emits tool_execution_end event", () => {
    feedToolUseAssistant();

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "toolu_abc", type: "tool_result", content: "hello", is_error: false },
        ],
      },
    });

    const ends = eventsOfType("tool_execution_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].toolCallId).toBe("toolu_abc");
    expect(ends[0].toolName).toBe("Bash");
    expect(ends[0].isError).toBe(false);
  });

  it("handles tool_result with array content (extracts text)", () => {
    feedToolUseAssistant();

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_abc",
            type: "tool_result",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
            is_error: false,
          },
        ],
      },
    });

    const lastMsg = agent.state.messages[agent.state.messages.length - 1];
    expect(lastMsg.content[0]).toEqual({ type: "text", text: "line 1\nline 2" });
  });

  it("marks error tool results", () => {
    feedToolUseAssistant();

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "toolu_abc", type: "tool_result", content: "Permission denied", is_error: true },
        ],
      },
    });

    const ends = eventsOfType("tool_execution_end");
    expect(ends[0].isError).toBe(true);
  });
});

describe("AskUserQuestion suppression", () => {
  function feedAskUser() {
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          { type: "text", text: "Let me ask you something." },
          {
            type: "tool_use",
            id: "toolu_ask",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which approach?",
                  header: "Approach",
                  options: [
                    { label: "Option A", description: "First way" },
                    { label: "Option B", description: "Second way" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 50 },
      },
    });
  }

  it("fires onAskUser callback with question data", () => {
    let received: AskUserQuestionData | null = null;
    agent.onAskUser = (data) => { received = data; };

    feedAskUser();

    expect(received).not.toBeNull();
    expect(received!.questions).toHaveLength(1);
    expect(received!.questions[0].question).toBe("Which approach?");
    expect(received!.toolCallId).toBe("toolu_ask");
  });

  it("filters AskUserQuestion from message content", () => {
    feedAskUser();

    const msg = agent.state.messages[0];
    // Should only have the text block, not the AskUserQuestion tool_use
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("text");
  });

  it("does not add AskUserQuestion to pendingToolCalls", () => {
    feedAskUser();
    expect(agent.state.pendingToolCalls.has("toolu_ask")).toBe(false);
  });

  it("suppresses AskUserQuestion error tool_result", () => {
    feedAskUser();
    const messageCountBefore = agent.state.messages.length;

    // CC sends back an error tool_result for the denied AskUserQuestion
    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "toolu_ask", type: "tool_result", content: "Tool denied", is_error: true },
        ],
      },
    });

    // Should not add a tool result message
    expect(agent.state.messages.length).toBe(messageCountBefore);
    expect(eventsOfType("tool_execution_end")).toHaveLength(0);
  });

  it("suppresses AskUserQuestion from stream content blocks", () => {
    // message_start
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });

    // text block at index 0
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    });

    // AskUserQuestion tool_use at index 1
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"questions":[]}' } },
    });

    // Stream message should only show the text block, not the AskUserQuestion
    const content = agent.state.streamMessage?.content.filter(Boolean) ?? [];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});

describe("thinking blocks", () => {
  it("accumulates thinking deltas in stream", () => {
    // message_start
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });

    // thinking block
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think..." } },
    });

    const block = agent.state.streamMessage?.content[0];
    expect(block?.type).toBe("thinking");
    expect(block?.thinking).toBe("Let me think...");
  });

  it("captures signature delta", () => {
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });

    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_xyz" } },
    });

    expect(agent.state.streamMessage?.content[0].thinkingSignature).toBe("sig_xyz");
  });
});

describe("tool use streaming", () => {
  it("accumulates JSON fragments and parses on block_stop", () => {
    // message_start
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });

    // tool_use block
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } },
    });

    // JSON fragments
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls -la"}' } },
    });

    // Before finalization, arguments should be empty
    expect(agent.state.streamMessage?.content[0].arguments).toEqual({});

    // Finalize
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });

    // After finalization, JSON should be parsed
    expect(agent.state.streamMessage?.content[0].arguments).toEqual({ command: "ls -la" });
  });

  it("handles malformed JSON gracefully", () => {
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });

    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken json" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });

    // Should fall back to empty object, not throw
    expect(agent.state.streamMessage?.content[0].arguments).toEqual({});
  });
});

describe("context tracking", () => {
  it("updates contextPercent from result usage", () => {
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100000, output_tokens: 10000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 },
    });

    // Total tokens = 100000 + 10000 + 50000 = 160000
    // contextPercent = 160000 / 200000 * 100 = 80%
    expect(agent.lastInputTokens).toBe(160000);
    expect(agent.contextPercent).toBe(80);
  });

  it("detects compaction on >15% token drop", () => {
    let compactionArgs: [number, number] | null = null;
    agent.onCompaction = (from, to) => { compactionArgs = [from, to]; };

    // First result: 100k tokens
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100000, output_tokens: 0 },
    });
    expect(compactionArgs).toBeNull();

    // Second result: 50k tokens (50% drop)
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 50000, output_tokens: 0 },
    });
    expect(compactionArgs).toEqual([100000, 50000]);
  });

  it("does not fire compaction for small drop (<15%)", () => {
    let fired = false;
    agent.onCompaction = () => { fired = true; };

    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 100000, output_tokens: 0 },
    });

    // 10% drop — should NOT trigger
    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 90000, output_tokens: 0 },
    });

    expect(fired).toBe(false);
  });

  it("sets context note on amber band crossing (80%)", () => {
    // Push to 82% usage: 164000 / 200000
    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 164000, output_tokens: 0 },
    });

    // Context note is private — test via prompt injection
    const sent: string[] = [];
    agent.connectTransport({
      send: (msg) => sent.push(msg),
      onEvent: () => {},
      close: () => {},
    });

    agent.prompt("test");
    expect(sent[0]).toContain("[Context:");
    expect(sent[0]).toContain("20% remaining");
  });

  it("sets context note on red band crossing (90%)", () => {
    // Push to 92% usage: 184000 / 200000
    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 184000, output_tokens: 0 },
    });

    const sent: string[] = [];
    agent.connectTransport({
      send: (msg) => sent.push(msg),
      onEvent: () => {},
      close: () => {},
    });

    agent.prompt("test");
    expect(sent[0]).toContain("[Context:");
    expect(sent[0]).toContain("10% remaining");
  });
});

describe("result event", () => {
  it("sets error on max_turns result", () => {
    agent.handleCCEvent({
      type: "result",
      subtype: "error_max_turns",
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    expect(agent.state.error).toBe("Max turns reached");
  });

  it("clears pending tool calls on result", () => {
    // Set up a pending tool call
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(agent.state.pendingToolCalls.size).toBe(1);

    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(agent.state.pendingToolCalls.size).toBe(0);
  });
});

describe("abort", () => {
  it("clears streaming state", () => {
    // Start streaming
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    expect(agent.state.streamMessage).not.toBeNull();

    agent.abort();

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMessage).toBeNull();
    expect(eventsOfType("agent_end")).toHaveLength(1);
  });
});

describe("subscribe", () => {
  it("returns unsubscribe function", () => {
    const events2: any[] = [];
    const unsub = agent.subscribe((e) => events2.push(e));

    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    expect(events2.length).toBeGreaterThan(0);

    const countBefore = events2.length;
    unsub();

    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: {},
    });
    expect(events2.length).toBe(countBefore);
  });
});

describe("unknown event handling", () => {
  it("logs unknown CC event types without throwing", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    agent.handleCCEvent({ type: "some_future_event", data: "payload" });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown CC event type: some_future_event"),
      expect.objectContaining({ type: "some_future_event" }),
    );
    debugSpy.mockRestore();
  });

  it("logs unknown stream event types without throwing", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "some_new_stream_thing", data: 123 },
    });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown stream event type: some_new_stream_thing"),
      expect.objectContaining({ type: "some_new_stream_thing" }),
    );
    debugSpy.mockRestore();
  });

  it("does not log known event types", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("prompt guards", () => {
  it("sets error and does not stream when transport is null", () => {
    // agent has no transport connected (default from beforeEach)
    agent.prompt("hello");

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.error).toBe("Not connected");
    expect(agent.state.messages).toEqual([]); // user message not added
    expect(eventsOfType("agent_end")).toHaveLength(1);
  });

  it("does not set error when transport is connected", () => {
    agent.connectTransport({
      send: () => {},
      onEvent: () => {},
      close: () => {},
    });
    agent.prompt("hello");

    expect(agent.state.error).toBeUndefined();
    expect(agent.state.isStreaming).toBe(true);
  });
});

describe("reset", () => {
  it("clears messages", () => {
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });
    expect(agent.state.messages.length).toBeGreaterThan(0);

    agent.reset();
    expect(agent.state.messages).toEqual([]);
  });

  it("clears streaming state", () => {
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_1", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    expect(agent.state.streamMessage).not.toBeNull();

    agent.reset();
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.isStreaming).toBe(false);
  });

  it("clears pending tool calls", () => {
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(agent.state.pendingToolCalls.size).toBe(1);

    agent.reset();
    expect(agent.state.pendingToolCalls.size).toBe(0);
  });

  it("clears context tracking", () => {
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 150000, output_tokens: 10000 },
    });
    expect(agent.contextPercent).toBeGreaterThan(0);

    agent.reset();
    expect(agent.contextPercent).toBe(0);
    expect(agent.lastInputTokens).toBe(0);
  });

  it("clears CWD", () => {
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/old/project" });
    expect(agent.cwd).toBe("/old/project");

    agent.reset();
    expect(agent.cwd).toBe("");
  });

  it("preserves subscribers", () => {
    const postResetEvents: any[] = [];
    agent.subscribe((e) => postResetEvents.push(e));

    agent.reset();

    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_2", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    expect(postResetEvents.length).toBeGreaterThan(0);
  });

  it("preserves transport", () => {
    const sent: string[] = [];
    agent.connectTransport({
      send: (msg) => sent.push(msg),
      onEvent: () => {},
      close: () => {},
    });

    agent.reset();
    agent.prompt("hello after reset");
    expect(sent).toHaveLength(1);
  });

  it("accepts new CWD after reset", () => {
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/old" });
    agent.reset();
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/new" });
    expect(agent.cwd).toBe("/new");
  });

  it("resets context band so notes fire again", () => {
    // Push to amber
    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 164000, output_tokens: 0 },
    });

    agent.reset();

    // Push to amber again — should set note again since band was reset
    agent.handleCCEvent({
      type: "result",
      usage: { input_tokens: 164000, output_tokens: 0 },
    });

    const sent: string[] = [];
    agent.connectTransport({
      send: (msg) => sent.push(msg),
      onEvent: () => {},
      close: () => {},
    });
    agent.prompt("test");
    expect(sent[0]).toContain("[Context:");
  });
});

// --- Replay mode ---

describe("replay mode", () => {
  it("startReplay resets state and suppresses emit", () => {
    // Build some state first
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    events.length = 0; // clear event log

    agent.startReplay();

    // State should be reset
    expect(agent.state.messages).toEqual([]);
    // emit() is suppressed — agent_end from reset() should NOT fire
    // (startReplay sets replayMode before reset's emit would fire...
    //  actually reset() emits agent_end, but startReplay calls reset() first then sets flag)
    // Let's check by replaying an event — subscribers should NOT fire
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "replayed" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(events).toEqual([]); // No events emitted during replay
    expect(agent.state.messages).toHaveLength(1); // But state IS built
    expect(agent.state.messages[0].content[0]).toEqual({ type: "text", text: "replayed" });
  });

  it("endReplay re-enables emit and fires agent_start sync event", () => {
    agent.startReplay();
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "replayed" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    agent.handleCCEvent({ type: "result", subtype: "success", usage: { input_tokens: 20, output_tokens: 10 } });
    events.length = 0;

    agent.endReplay();

    // Should fire agent_start (sync trigger)
    expect(events.some((e) => e.type === "agent_start")).toBe(true);
    // And emit should work again for future events
    events.length = 0;
    agent.handleCCEvent({ type: "system", cwd: "/test" });
    // system doesn't emit events, but streaming would. Check emit is unblocked:
    expect((agent as any)._replayMode).toBe(false);
  });

  it("endReplay mid-stream emits message_update before sync", () => {
    agent.startReplay();
    // Start a streaming message
    agent.handleCCEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-6", id: "msg_r", role: "assistant", content: [], stop_reason: null, usage: {} },
      },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    agent.handleCCEvent({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    });
    events.length = 0;

    agent.endReplay();

    // Should emit message_update (with partial stream message) then agent_start
    const types = events.map((e) => e.type);
    expect(types).toContain("message_update");
    expect(types).toContain("agent_start");
    expect(types.indexOf("message_update")).toBeLessThan(types.indexOf("agent_start"));
  });

  it("suppresses onAskUser during replay", () => {
    const askSpy = vi.fn();
    agent.onAskUser = askSpy;

    agent.startReplay();
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{
          type: "tool_use",
          id: "toolu_ask",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Pick one", header: "Q", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    expect(askSpy).not.toHaveBeenCalled();
  });

  it("suppresses onCompaction during replay", () => {
    const compactionSpy = vi.fn();
    agent.onCompaction = compactionSpy;

    agent.startReplay();
    // First result with high tokens
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100000, output_tokens: 0 },
    });
    // Second result with much lower tokens (triggers compaction detection)
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 50000, output_tokens: 0 },
    });

    expect(compactionSpy).not.toHaveBeenCalled();
  });

  it("suppresses onCwdChange during replay", () => {
    const cwdSpy = vi.fn();
    agent.onCwdChange = cwdSpy;

    agent.startReplay();
    agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/replayed/path" });

    expect(cwdSpy).not.toHaveBeenCalled();
    expect(agent.cwd).toBe("/replayed/path"); // State IS updated
  });

  it("adds user text messages to state during replay", () => {
    agent.startReplay();
    // CC echoes user messages with content as a plain string (not an array)
    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: "hello from replay",
      },
    });

    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].role).toBe("user");
    expect(agent.state.messages[0].content[0]).toEqual({
      type: "text",
      text: "hello from replay",
    });
    expect(events).toEqual([]); // Suppressed during replay
  });

  it("ignores user text echo during normal (non-replay) operation", () => {
    // During normal use, prompt() already added the user message.
    // The CC echo via --replay-user-messages should NOT duplicate it.
    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: "echo from CC",
      },
    });

    // No user message added (prompt() would have done it)
    expect(agent.state.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("context gauge is available after replay ends", () => {
    agent.startReplay();
    agent.handleCCEvent({
      type: "result",
      result: {
        usage: {
          input_tokens: 50000,
          output_tokens: 5000,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    agent.endReplay();

    expect(agent.contextPercent).toBeGreaterThan(0);
  });

  it("preserves AskUser tool_use in message content during replay", () => {
    agent.startReplay();
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [
          { type: "text", text: "Let me ask you something." },
          {
            type: "tool_use",
            id: "toolu_ask_replay",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which option?",
                header: "Choice",
                options: [{ label: "A" }, { label: "B" }],
                multiSelect: false,
              }],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });

    const msg = agent.state.messages[0];
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[1].type).toBe("toolCall");
    expect(msg.content[1].name).toBe("AskUserQuestion");
  });

  it("renders AskUser tool_result during replay (not suppressed)", () => {
    agent.startReplay();

    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{
          type: "tool_use",
          id: "toolu_ask_replay2",
          name: "AskUserQuestion",
          input: { questions: [] },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    });

    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ask_replay2", content: "Error: AskUserQuestion denied", is_error: true },
        ],
      },
    });

    const toolResults = agent.state.messages.filter((m) => (m as any).role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolCallId).toBe("toolu_ask_replay2");
    expect((toolResults[0] as any).toolName).toBe("AskUserQuestion");
  });

  it("does NOT trigger AskUser overlay during replay", () => {
    const askSpy = vi.fn();
    agent.onAskUser = askSpy;

    agent.startReplay();
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{
          type: "tool_use",
          id: "toolu_ask_replay3",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Pick", header: "Q", options: [{ label: "X" }], multiSelect: false }] },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    expect(askSpy).not.toHaveBeenCalled();
  });

  it("multi-turn replay produces correctly interleaved user + assistant messages", () => {
    agent.startReplay();

    // Turn 1: bridge-injected user message, then assistant response
    agent.handleCCEvent({
      type: "user",
      message: { role: "user", content: "What is 2+2?" },
    });
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_turn1",
        content: [{ type: "text", text: "The answer is 4." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    });
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      result: { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });

    // Turn 2: another user message, then assistant with tool use
    agent.handleCCEvent({
      type: "user",
      message: { role: "user", content: "List files in current dir" },
    });
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_turn2a",
        content: [{ type: "tool_use", id: "toolu_abc", name: "Bash", input: { command: "ls" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 20 },
      },
    });
    // Tool result
    agent.handleCCEvent({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_abc", type: "tool_result", content: "file1.ts\nfile2.ts", is_error: false }],
      },
    });
    agent.handleCCEvent({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_turn2b",
        content: [{ type: "text", text: "Found 2 files." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 15 },
      },
    });
    agent.handleCCEvent({
      type: "result",
      subtype: "success",
      result: { usage: { input_tokens: 300, output_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });

    agent.endReplay();

    // Verify: 6 messages in correct order
    const messages = agent.state.messages;
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("user");
    expect((messages[0].content[0] as any).text).toBe("What is 2+2?");
    expect(messages[1].role).toBe("assistant");
    expect((messages[1].content[0] as any).text).toBe("The answer is 4.");
    expect(messages[2].role).toBe("user");
    expect((messages[2].content[0] as any).text).toBe("List files in current dir");
    expect(messages[3].role).toBe("assistant");
    expect((messages[3].content[0] as any).name).toBe("Bash");
    expect(messages[4].role).toBe("toolResult");
    expect(messages[5].role).toBe("assistant");
    expect((messages[5].content[0] as any).text).toBe("Found 2 files.");

    // Verify no events emitted during replay, agent_start emitted after
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_start");
  });
});
