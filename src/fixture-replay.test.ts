/**
 * Fixture replay tests — feed real CC event sequences through the adapter.
 *
 * Fixtures are JSON arrays of actual CC stream-json events, derived from
 * docs/empirical-verification.md. If CC changes its event schema, these
 * tests break — which is the point. They catch schema drift that
 * hand-crafted test events would miss.
 *
 * Key CC quirks encoded in fixtures:
 * - Complete assistant message arrives BEFORE content_block_stop
 * - User replay arrives mid-stream (--replay-user-messages)
 * - Init event fires on EVERY user message, not just the first
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import textResponse from "../fixtures/text-response.json";
import toolUseResponse from "../fixtures/tool-use-response.json";
import thinkingResponse from "../fixtures/thinking-response.json";

let agent: ClaudeCodeAgent;
let events: any[];

beforeEach(() => {
  agent = new ClaudeCodeAgent();
  events = [];
  agent.subscribe((e) => events.push({ ...e }));
});

function replay(fixture: { events: any[] }) {
  for (const event of fixture.events) {
    agent.handleCCEvent(event);
  }
}

function eventsOfType(type: string) {
  return events.filter((e) => e.type === type);
}

describe("fixture: text-response", () => {
  it("produces correct final state from real CC event sequence", () => {
    replay(textResponse);

    expect(agent.cwd).toBe("/Users/test/project");
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.pendingToolCalls.size).toBe(0);

    // One assistant message with the complete text
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0].role).toBe("assistant");
    expect(agent.state.messages[0].content[0]).toEqual({
      type: "text",
      text: "Hello there, nice meeting you!",
    });
  });

  it("handles mid-stream user replay without creating a message", () => {
    replay(textResponse);

    // User replay (--replay-user-messages echo) should NOT create a user message
    // in our state — it's a server echo, not a new user input
    const userMessages = agent.state.messages.filter((m: any) => m.role === "user");
    expect(userMessages).toHaveLength(0);
  });

  it("handles assistant arriving before content_block_stop", () => {
    // Feed events up to and including the assistant complete
    const eventsUpToAssistant = textResponse.events.slice(
      0,
      textResponse.events.findIndex((e: any) => e.type === "assistant") + 1,
    );

    for (const event of eventsUpToAssistant) {
      agent.handleCCEvent(event);
    }

    // Assistant complete should have cleared stream message and created final message
    expect(agent.state.streamMessage).toBeNull();
    expect(agent.state.messages).toHaveLength(1);

    // Remaining stream events (content_block_stop, message_delta, message_stop)
    // should be no-ops since stream message is already null
    const remainingEvents = textResponse.events.slice(
      textResponse.events.findIndex((e: any) => e.type === "assistant") + 1,
    );
    for (const event of remainingEvents) {
      agent.handleCCEvent(event);
    }

    // Still just 1 message
    expect(agent.state.messages).toHaveLength(1);
  });

  it("updates context tracking from result usage", () => {
    replay(textResponse);

    // Usage from assistant message: input_tokens=31187 (output_tokens excluded)
    expect(agent.lastInputTokens).toBe(31187);
    expect(agent.contextPercent).toBeCloseTo(15.6, 0);
  });

  it("emits correct event sequence", () => {
    replay(textResponse);

    expect(eventsOfType("message_start")).toHaveLength(1);
    expect(eventsOfType("message_update").length).toBeGreaterThan(0);
    expect(eventsOfType("message_end")).toHaveLength(1);
    expect(eventsOfType("turn_end")).toHaveLength(1);
    expect(eventsOfType("agent_end")).toHaveLength(1);
  });
});

describe("fixture: tool-use-response", () => {
  it("produces correct final state from real CC tool-use sequence", () => {
    replay(toolUseResponse);

    expect(agent.cwd).toBe("/Users/test/project");
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);

    // Three messages: assistant(tool_use) + toolResult + assistant(text)
    expect(agent.state.messages).toHaveLength(3);
    expect(agent.state.messages[0].role).toBe("assistant");
    expect(agent.state.messages[1].role).toBe("toolResult");
    expect(agent.state.messages[2].role).toBe("assistant");
  });

  it("maps tool_use to toolCall in first assistant message", () => {
    replay(toolUseResponse);

    const firstMsg = agent.state.messages[0];
    expect(firstMsg.content[0]).toEqual({
      type: "toolCall",
      id: "toolu_01ABC123",
      name: "Bash",
      arguments: { command: "echo hello-from-tool", description: "Echo a test string" },
    });
  });

  it("maps tool_result to toolResult message", () => {
    replay(toolUseResponse);

    const toolResult = agent.state.messages[1] as any;
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("toolu_01ABC123");
    expect(toolResult.toolName).toBe("Bash");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0].text).toBe("hello-from-tool");
  });

  it("has correct final text response", () => {
    replay(toolUseResponse);

    const lastMsg = agent.state.messages[2];
    expect(lastMsg.content[0]).toEqual({
      type: "text",
      text: "Done \u2014 output: `hello-from-tool`",
    });
  });

  it("ignores second init event (same CWD)", () => {
    replay(toolUseResponse);

    // Init fires twice (once per turn) but CWD should only be set from first
    expect(agent.cwd).toBe("/Users/test/project");
  });

  it("clears tool from pending after result", () => {
    // Feed events up to tool_result
    const toolResultIndex = toolUseResponse.events.findIndex(
      (e: any) => e.type === "user" && e.message?.content?.[0]?.type === "tool_result",
    );

    // Before tool_result: tool should be pending
    for (let i = 0; i <= toolUseResponse.events.findIndex((e: any) => e.type === "assistant"); i++) {
      agent.handleCCEvent(toolUseResponse.events[i]);
    }
    expect(agent.state.pendingToolCalls.has("toolu_01ABC123")).toBe(true);

    // After tool_result: tool should be cleared
    agent.handleCCEvent(toolUseResponse.events[toolResultIndex]);
    expect(agent.state.pendingToolCalls.has("toolu_01ABC123")).toBe(false);
  });
});

describe("fixture: thinking-response", () => {
  it("produces correct final state with thinking + text", () => {
    replay(thinkingResponse);

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages).toHaveLength(1);

    const msg = agent.state.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toHaveLength(2);
  });

  it("maps thinking block with signature", () => {
    replay(thinkingResponse);

    const msg = agent.state.messages[0];
    expect(msg.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think about this carefully...",
      thinkingSignature: "EqoBCkgIAhgCIkC8sIZMBLVPMaDY07OmB",
    });
  });

  it("maps text block after thinking", () => {
    replay(thinkingResponse);

    const msg = agent.state.messages[0];
    expect(msg.content[1]).toEqual({
      type: "text",
      text: "After careful consideration, the answer is 42.",
    });
  });

  it("accumulates thinking in stream before assistant complete", () => {
    // Feed events up to just before the assistant complete
    const assistantIndex = thinkingResponse.events.findIndex((e: any) => e.type === "assistant");

    for (let i = 0; i < assistantIndex; i++) {
      agent.handleCCEvent(thinkingResponse.events[i]);
    }

    // Stream should have thinking block with accumulated text
    const stream = agent.state.streamMessage;
    expect(stream).not.toBeNull();
    const thinkingBlock = stream!.content.find((b: any) => b.type === "thinking");
    expect(thinkingBlock?.thinking).toBe("Let me think about this carefully...");
    expect(thinkingBlock?.thinkingSignature).toBe("EqoBCkgIAhgCIkC8sIZMBLVPMaDY07OmB");

    // Text block should be accumulating
    const textBlock = stream!.content.find((b: any) => b.type === "text");
    expect(textBlock?.text).toBe("After careful consideration, the answer is 42.");
  });
});
