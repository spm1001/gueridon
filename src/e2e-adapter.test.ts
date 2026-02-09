/**
 * End-to-end adapter sequence tests.
 *
 * Unlike the unit tests in claude-code-agent.test.ts that test individual
 * handlers, these feed complete multi-turn CC event sequences through
 * handleCCEvent and assert intermediate state at each phase transition.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ClaudeCodeAgent, type AskUserQuestionData } from "./claude-code-agent.js";

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

// --- Reusable event builders ---

function init(cwd = "/Users/test/project") {
  return { type: "system", subtype: "init", cwd };
}

function messageStart(id = "msg_1") {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { model: "claude-opus-4-6", id, role: "assistant", content: [], stop_reason: null, usage: {} },
    },
  };
}

function textBlockStart(index: number) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  };
}

function textDelta(index: number, text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

function blockStop(index: number) {
  return { type: "stream_event", event: { type: "content_block_stop", index } };
}

function messageStop() {
  return { type: "stream_event", event: { type: "message_stop" } };
}

function assistantComplete(content: any[], stopReason = "end_turn", usage = { input_tokens: 500, output_tokens: 50 }) {
  return {
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      id: "msg_1",
      role: "assistant",
      content,
      stop_reason: stopReason,
      usage,
    },
  };
}

function toolResultUser(toolUseId: string, content: string, isError = false) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }],
    },
  };
}

function result(usage = { input_tokens: 500, output_tokens: 50 }) {
  return { type: "result", subtype: "success", is_error: false, usage };
}

// --- Full sequences ---

describe("end-to-end: text-only turn", () => {
  it("init → stream → assistant → result with state checkpoints", () => {
    // Phase 1: init
    agent.handleCCEvent(init("/Users/test/myapp"));
    expect(agent.cwd).toBe("/Users/test/myapp");
    expect(agent.state.isStreaming).toBe(false);

    // Phase 2: stream starts
    agent.handleCCEvent(messageStart());
    expect(agent.state.isStreaming).toBe(false); // isStreaming set by prompt(), not stream
    expect(agent.state.streamMessage).not.toBeNull();
    expect(agent.state.streamMessage?.role).toBe("assistant");

    agent.handleCCEvent(textBlockStart(0));
    agent.handleCCEvent(textDelta(0, "Hello "));
    expect(agent.state.streamMessage?.content[0]?.text).toBe("Hello ");

    agent.handleCCEvent(textDelta(0, "world!"));
    expect(agent.state.streamMessage?.content[0]?.text).toBe("Hello world!");

    agent.handleCCEvent(blockStop(0));
    agent.handleCCEvent(messageStop());

    // Stream message still exists until assistant complete
    expect(agent.state.streamMessage).not.toBeNull();
    expect(agent.state.messages).toHaveLength(0);

    // Phase 3: assistant complete replaces stream with final message
    agent.handleCCEvent(assistantComplete(
      [{ type: "text", text: "Hello world!" }],
      "end_turn",
      { input_tokens: 1000, output_tokens: 20 },
    ));
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].role).toBe("assistant");
    expect(agent.state.messages[0].content[0]).toEqual({ type: "text", text: "Hello world!" });

    // Phase 4: result clears everything
    agent.handleCCEvent(result({ input_tokens: 1000, output_tokens: 20 }));
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.pendingToolCalls.size).toBe(0);

    // Verify event sequence
    expect(eventsOfType("message_start")).toHaveLength(1);
    expect(eventsOfType("message_update").length).toBeGreaterThan(0);
    expect(eventsOfType("message_end")).toHaveLength(1);
    expect(eventsOfType("turn_end")).toHaveLength(1);
    expect(eventsOfType("agent_end")).toHaveLength(1);
  });
});

describe("end-to-end: tool-use turn", () => {
  it("assistant(tool_use) → tool_result → second assistant(text) → result", () => {
    agent.handleCCEvent(init());

    // Turn 1: assistant calls a tool
    agent.handleCCEvent(assistantComplete(
      [{ type: "tool_use", id: "toolu_abc", name: "Bash", input: { command: "ls -la" } }],
      "tool_use",
    ));

    // Checkpoint: tool call tracked, message stored
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.pendingToolCalls.has("toolu_abc")).toBe(true);
    expect(eventsOfType("tool_execution_start")).toHaveLength(1);
    expect(eventsOfType("tool_execution_start")[0].toolName).toBe("Bash");

    // Tool result arrives
    agent.handleCCEvent(toolResultUser("toolu_abc", "file1.ts\nfile2.ts"));

    // Checkpoint: tool resolved, result message added
    expect(agent.state.pendingToolCalls.has("toolu_abc")).toBe(false);
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[1].role).toBe("toolResult");
    expect(eventsOfType("tool_execution_end")).toHaveLength(1);
    expect(eventsOfType("tool_execution_end")[0].isError).toBe(false);

    // Turn 2: assistant responds with text after seeing tool result
    agent.handleCCEvent(messageStart("msg_2"));
    agent.handleCCEvent(textBlockStart(0));
    agent.handleCCEvent(textDelta(0, "I found 2 files."));
    agent.handleCCEvent(blockStop(0));
    agent.handleCCEvent(messageStop());

    agent.handleCCEvent(assistantComplete(
      [{ type: "text", text: "I found 2 files." }],
      "end_turn",
      { input_tokens: 2000, output_tokens: 30 },
    ));

    // Checkpoint: two assistant messages + one tool result
    expect(agent.state.messages).toHaveLength(3);
    expect(agent.state.messages[0].role).toBe("assistant");
    expect(agent.state.messages[1].role).toBe("toolResult");
    expect(agent.state.messages[2].role).toBe("assistant");

    // Result closes the turn
    agent.handleCCEvent(result({ input_tokens: 2000, output_tokens: 30 }));
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
  });

  it("handles multiple tool calls in single assistant message", () => {
    agent.handleCCEvent(init());

    agent.handleCCEvent(assistantComplete(
      [
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/b.ts" } },
      ],
      "tool_use",
    ));

    expect(agent.state.pendingToolCalls.size).toBe(2);
    expect(agent.state.pendingToolCalls.has("toolu_1")).toBe(true);
    expect(agent.state.pendingToolCalls.has("toolu_2")).toBe(true);

    // First result
    agent.handleCCEvent(toolResultUser("toolu_1", "contents of a"));
    expect(agent.state.pendingToolCalls.size).toBe(1);

    // Second result
    agent.handleCCEvent(toolResultUser("toolu_2", "contents of b"));
    expect(agent.state.pendingToolCalls.size).toBe(0);

    // Messages: assistant + 2 tool results
    expect(agent.state.messages).toHaveLength(3);
  });

  it("tracks error tool results correctly", () => {
    agent.handleCCEvent(init());

    agent.handleCCEvent(assistantComplete(
      [{ type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "rm -rf /" } }],
      "tool_use",
    ));

    agent.handleCCEvent(toolResultUser("toolu_err", "Permission denied", true));

    const endEvents = eventsOfType("tool_execution_end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].isError).toBe(true);
    expect(endEvents[0].result).toBe("Permission denied");
  });
});

describe("end-to-end: AskUserQuestion turn", () => {
  it("intercepts AskUser, suppresses error result, conversation continues", () => {
    agent.handleCCEvent(init());

    let askData: AskUserQuestionData | null = null;
    agent.onAskUser = (data) => { askData = data; };

    // Assistant sends text + AskUserQuestion
    agent.handleCCEvent(assistantComplete(
      [
        { type: "text", text: "I have a question." },
        {
          type: "tool_use",
          id: "toolu_ask",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Which database?",
              header: "DB",
              options: [
                { label: "PostgreSQL", description: "Relational" },
                { label: "MongoDB", description: "Document" },
              ],
              multiSelect: false,
            }],
          },
        },
      ],
      "tool_use",
    ));

    // Checkpoint: AskUser callback fired with correct data
    expect(askData).not.toBeNull();
    expect(askData!.questions[0].question).toBe("Which database?");
    expect(askData!.toolCallId).toBe("toolu_ask");

    // Checkpoint: AskUserQuestion filtered from message content
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].content).toHaveLength(1);
    expect(agent.state.messages[0].content[0].type).toBe("text");

    // Checkpoint: AskUserQuestion NOT in pending tool calls
    expect(agent.state.pendingToolCalls.has("toolu_ask")).toBe(false);

    // CC sends back error tool_result for denied AskUserQuestion
    const messagesBefore = agent.state.messages.length;
    agent.handleCCEvent(toolResultUser("toolu_ask", "Tool denied", true));

    // Checkpoint: error result suppressed — no new message
    expect(agent.state.messages.length).toBe(messagesBefore);
    expect(eventsOfType("tool_execution_end")).toHaveLength(0);

    // Conversation continues — user answers via next prompt, CC responds
    agent.handleCCEvent(messageStart("msg_2"));
    agent.handleCCEvent(textBlockStart(0));
    agent.handleCCEvent(textDelta(0, "PostgreSQL it is!"));
    agent.handleCCEvent(blockStop(0));
    agent.handleCCEvent(messageStop());

    agent.handleCCEvent(assistantComplete(
      [{ type: "text", text: "PostgreSQL it is!" }],
      "end_turn",
      { input_tokens: 3000, output_tokens: 10 },
    ));

    agent.handleCCEvent(result({ input_tokens: 3000, output_tokens: 10 }));

    // Final state: original text message + follow-up
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.isStreaming).toBe(false);
  });
});

describe("end-to-end: multi-turn conversation", () => {
  it("maintains state across prompt → response → prompt → response", () => {
    // Simulate what GueridonInterface would drive
    const sent: string[] = [];
    agent.connectTransport({
      send: (msg) => sent.push(msg),
      onEvent: () => {},
      close: () => {},
    });

    agent.handleCCEvent(init("/Users/test/app"));

    // Turn 1: user sends prompt
    agent.prompt("What files are here?");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("What files are here?");
    expect(agent.state.isStreaming).toBe(true);
    // User message added
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].role).toBe("user");

    // CC responds with tool use
    agent.handleCCEvent(assistantComplete(
      [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls" } }],
      "tool_use",
    ));
    agent.handleCCEvent(toolResultUser("toolu_ls", "index.ts\napp.ts"));

    // CC follows up with text
    agent.handleCCEvent(assistantComplete(
      [{ type: "text", text: "I see index.ts and app.ts." }],
      "end_turn",
      { input_tokens: 1500, output_tokens: 30 },
    ));
    agent.handleCCEvent(result({ input_tokens: 1500, output_tokens: 30 }));

    expect(agent.state.isStreaming).toBe(false);
    // user + assistant(tool) + toolResult + assistant(text) = 4
    expect(agent.state.messages).toHaveLength(4);

    // Turn 2: user sends another prompt
    agent.prompt("Read index.ts");
    expect(sent).toHaveLength(2);
    expect(agent.state.isStreaming).toBe(true);
    // Previous 4 + new user = 5
    expect(agent.state.messages).toHaveLength(5);

    agent.handleCCEvent(assistantComplete(
      [{ type: "text", text: "Here are the contents..." }],
      "end_turn",
      { input_tokens: 3000, output_tokens: 100 },
    ));
    agent.handleCCEvent(result({ input_tokens: 3000, output_tokens: 100 }));

    // 5 + assistant = 6
    expect(agent.state.messages).toHaveLength(6);
    expect(agent.state.isStreaming).toBe(false);

    // Context tracking updated
    expect(agent.lastInputTokens).toBe(3100); // 3000 + 100
    expect(agent.contextPercent).toBeCloseTo(1.55, 1);
  });
});

describe("end-to-end: context tracking across turns", () => {
  it("detects compaction when tokens drop significantly between results", () => {
    let compacted: [number, number] | null = null;
    agent.onCompaction = (from, to) => { compacted = [from, to]; };

    // Turn 1 result: 150k tokens
    agent.handleCCEvent(result({ input_tokens: 140000, output_tokens: 10000 }));
    expect(compacted).toBeNull();
    expect(agent.contextPercent).toBe(75); // 150k / 200k

    // Turn 2 result: 80k tokens (compacted)
    agent.handleCCEvent(result({ input_tokens: 70000, output_tokens: 10000 }));
    expect(compacted).toEqual([150000, 80000]);
    expect(agent.contextPercent).toBe(40);
  });
});
