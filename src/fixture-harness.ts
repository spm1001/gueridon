/**
 * Visual fixture replay harness.
 *
 * Injects pre-built message arrays into the agent at the state level,
 * bypassing transport/CC entirely. For deterministic, sub-second UI testing.
 *
 * Usage: append `?fixture=kitchen-sink` to the URL.
 */

import type { ClaudeCodeAgent } from "./claude-code-agent.js";

// --- Compact fixture format ---

interface FixtureUserMessage {
  role: "user";
  text: string;
}

interface FixtureAssistantMessage {
  role: "assistant";
  text: string;
  thinking?: string;
}

interface FixtureToolMessage {
  role: "tool";
  name: string;
  input: string;
  output: string;
  isError?: boolean;
}

type FixtureMessage = FixtureUserMessage | FixtureAssistantMessage | FixtureToolMessage;

interface FixtureData {
  messages: FixtureMessage[];
}

// --- Message builders ---
// Expand compact fixture descriptions into full AgentMessage objects.

let toolCallCounter = 0;

function makeTimestamp(index: number): number {
  // Stable timestamps: 2026-01-01 + index seconds
  return 1735689600000 + index * 1000;
}

function buildUser(text: string, index: number) {
  return {
    role: "user" as const,
    content: text,
    timestamp: makeTimestamp(index),
  };
}

function buildAssistant(text: string, index: number, thinking?: string) {
  const content: any[] = [];
  if (thinking) {
    content.push({ type: "thinking", thinking });
  }
  content.push({ type: "text", text });

  return {
    role: "assistant" as const,
    content,
    api: "anthropic" as const,
    provider: "anthropic" as const,
    model: "claude-fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: makeTimestamp(index),
  };
}

function buildToolCall(name: string, input: string, index: number) {
  const id = `fixture-tc-${++toolCallCounter}`;
  return {
    message: {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name, arguments: { command: input } }],
      api: "anthropic" as const,
      provider: "anthropic" as const,
      model: "claude-fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse" as const,
      timestamp: makeTimestamp(index),
    },
    toolCallId: id,
  };
}

function buildToolResult(toolCallId: string, name: string, output: string, isError: boolean, index: number) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: name,
    content: [{ type: "text" as const, text: output }],
    isError,
    timestamp: makeTimestamp(index),
  };
}

// --- Expand fixture messages into AgentMessage[] ---

function expandMessages(fixture: FixtureData): any[] {
  toolCallCounter = 0;
  const messages: any[] = [];
  let index = 0;

  for (const msg of fixture.messages) {
    switch (msg.role) {
      case "user":
        messages.push(buildUser(msg.text, index++));
        break;
      case "assistant":
        messages.push(buildAssistant(msg.text, index++, msg.thinking));
        break;
      case "tool": {
        const tc = buildToolCall(msg.name, msg.input, index++);
        messages.push(tc.message);
        messages.push(buildToolResult(tc.toolCallId, msg.name, msg.output, msg.isError ?? false, index++));
        break;
      }
    }
  }

  return messages;
}

// --- Public API ---

export async function loadFixture(agent: ClaudeCodeAgent, name: string): Promise<boolean> {
  try {
    const resp = await fetch(`/fixtures/visual/${name}.json`);
    if (!resp.ok) {
      console.error(`[fixture] Failed to load fixture "${name}": ${resp.status}`);
      return false;
    }
    const fixture: FixtureData = await resp.json();
    const messages = expandMessages(fixture);
    agent.injectFixture(messages);

    console.log(`[fixture] Loaded "${name}" with ${messages.length} messages`);
    return true;
  } catch (err) {
    console.error(`[fixture] Error loading fixture "${name}":`, err);
    return false;
  }
}
