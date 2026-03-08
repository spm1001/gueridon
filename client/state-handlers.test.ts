// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyStateEvent, applyTextEvent, applyCurrentEvent } = require("./state-handlers.cjs" as string);

/** Default context — connected to a folder with an existing session. */
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    currentFolder: "my-project",
    session: { id: "sess-1", model: "claude-sonnet-4-5-20250514", project: "my-project", context_pct: 42 },
    ...overrides,
  };
}

// ============================================================
// Normal state snapshot application
// ============================================================
describe("applyStateEvent — normal snapshot", () => {
  it("sets connection to connected", () => {
    const { updates } = applyStateEvent({}, ctx());
    expect(updates.connection).toBe("connected");
  });

  it("always signals clearStreaming", () => {
    const { effects } = applyStateEvent({}, ctx());
    expect(effects.clearStreaming).toBe(true);
  });

  it("applies messages from data", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const { updates } = applyStateEvent({ messages: msgs }, ctx());
    expect(updates.messages).toEqual(msgs);
  });

  it("does not set messages key when data has none", () => {
    const { updates } = applyStateEvent({}, ctx());
    expect("messages" in updates).toBe(false);
  });

  it("merges session object with existing session", () => {
    const { updates } = applyStateEvent(
      { session: { context_pct: 55 } },
      ctx({ session: { id: "sess-1", model: "opus", project: "x" } }),
    );
    expect(updates.session).toEqual({ id: "sess-1", model: "opus", project: "x", context_pct: 55 });
  });

  it("ignores non-object session values", () => {
    const { updates } = applyStateEvent({ session: "my-project" }, ctx());
    expect("session" in updates).toBe(false);
  });

  it("applies status from data", () => {
    const { updates } = applyStateEvent({ status: "working" }, ctx());
    expect(updates.status).toBe("working");
  });

  it("does not set status when data has none", () => {
    const { updates } = applyStateEvent({}, ctx());
    expect("status" in updates).toBe(false);
  });

  it("applies slashCommands when present (including null)", () => {
    const cmds = [{ name: "/help", description: "Help" }];
    const { updates: u1 } = applyStateEvent({ slashCommands: cmds }, ctx());
    expect(u1.slashCommands).toEqual(cmds);

    const { updates: u2 } = applyStateEvent({ slashCommands: null }, ctx());
    expect(u2.slashCommands).toBeNull();
  });

  it("does not set slashCommands when absent from data", () => {
    const { updates } = applyStateEvent({}, ctx());
    expect("slashCommands" in updates).toBe(false);
  });

  it("sets resetPushTag on working status", () => {
    const { effects } = applyStateEvent({ status: "working" }, ctx());
    expect(effects.resetPushTag).toBe(true);
  });

  it("does not set resetPushTag on non-working status", () => {
    const { effects } = applyStateEvent({ status: "idle" }, ctx());
    expect(effects.resetPushTag).toBe(false);
  });

  it("clears activity and triggers pushNotify on idle", () => {
    const { updates, effects } = applyStateEvent({ status: "idle" }, ctx());
    expect(updates.activity).toBeNull();
    expect(effects.pushNotify).toEqual({
      title: "Claude finished in my-project",
      opts: { tag: "gueridon-done-my-project", folder: "my-project" },
    });
  });

  it("uses empty string for folder in pushNotify when no currentFolder", () => {
    const { effects } = applyStateEvent({ status: "idle" }, ctx({ currentFolder: null }));
    expect(effects.pushNotify!.title).toBe("Claude finished in ");
    expect(effects.pushNotify!.opts.folder).toBe("");
  });

  it("does not trigger side effects on normal snapshot", () => {
    const { effects } = applyStateEvent({ status: "working", messages: [] }, ctx());
    expect(effects.openSwitcher).toBe(false);
    expect(effects.clearFolder).toBe(false);
    expect(effects.clearHash).toBe(false);
    expect(effects.fetchFolders).toBe(false);
    expect(effects.pushNotify).toBeNull();
  });
});

// ============================================================
// processAlive=false path
// ============================================================
describe("applyStateEvent — processAlive=false", () => {
  it("sets status to idle", () => {
    const { updates } = applyStateEvent({ processAlive: false }, ctx());
    expect(updates.status).toBe("idle");
  });

  it("clears activity", () => {
    const { updates } = applyStateEvent({ processAlive: false }, ctx());
    expect(updates.activity).toBeNull();
  });

  it("signals clearStreaming", () => {
    const { effects } = applyStateEvent({ processAlive: false }, ctx());
    expect(effects.clearStreaming).toBe(true);
  });

  it("does NOT clear folder", () => {
    const { effects } = applyStateEvent({ processAlive: false }, ctx());
    expect(effects.clearFolder).toBe(false);
  });

  it("does NOT open switcher", () => {
    const { effects } = applyStateEvent({ processAlive: false }, ctx());
    expect(effects.openSwitcher).toBe(false);
  });

  it("does NOT clear hash", () => {
    const { effects } = applyStateEvent({ processAlive: false }, ctx());
    expect(effects.clearHash).toBe(false);
  });

  it("does NOT fetch folders", () => {
    const { effects } = applyStateEvent({ processAlive: false }, ctx());
    expect(effects.fetchFolders).toBe(false);
  });

  it("preserves messages from data if present", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const { updates } = applyStateEvent({ processAlive: false, messages: msgs }, ctx());
    expect(updates.messages).toEqual(msgs);
  });

  it("is a no-op when no currentFolder", () => {
    const { updates } = applyStateEvent({ processAlive: false }, ctx({ currentFolder: null }));
    // Without currentFolder, the processAlive branch doesn't fire —
    // status is not set to idle (no data.status either)
    expect("status" in updates).toBe(false);
  });

  it("does not fire when sessionEnded is also true", () => {
    // sessionEnded takes precedence — processAlive guard checks !data.sessionEnded
    const { effects } = applyStateEvent({ processAlive: false, sessionEnded: true }, ctx());
    // sessionEnded branch fires instead
    expect(effects.openSwitcher).toBe(true);
    expect(effects.clearFolder).toBe(true);
  });
});

// ============================================================
// sessionEnded path (full nuke)
// ============================================================
describe("applyStateEvent — sessionEnded", () => {
  it("clears session to empty object", () => {
    const { updates } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(updates.session).toEqual({});
  });

  it("clears messages to empty array", () => {
    const { updates } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(updates.messages).toEqual([]);
  });

  it("sets status to idle", () => {
    const { updates } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(updates.status).toBe("idle");
  });

  it("clears activity", () => {
    const { updates } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(updates.activity).toBeNull();
  });

  it("clears slashCommands", () => {
    const { updates } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(updates.slashCommands).toBeNull();
  });

  it("signals clearStreaming", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(effects.clearStreaming).toBe(true);
  });

  it("clears folder", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(effects.clearFolder).toBe(true);
  });

  it("clears hash", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(effects.clearHash).toBe(true);
  });

  it("opens switcher", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(effects.openSwitcher).toBe(true);
  });

  it("fetches folders", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx());
    expect(effects.fetchFolders).toBe(true);
  });

  it("is a no-op when no currentFolder", () => {
    const { effects } = applyStateEvent({ sessionEnded: true }, ctx({ currentFolder: null }));
    expect(effects.openSwitcher).toBe(false);
    expect(effects.clearFolder).toBe(false);
    expect(effects.fetchFolders).toBe(false);
  });

  it("overrides data.messages with empty array", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const { updates } = applyStateEvent({ sessionEnded: true, messages: msgs }, ctx());
    // sessionEnded nuke wins — messages cleared
    expect(updates.messages).toEqual([]);
  });

  it("fires pushNotify when data also has status=idle", () => {
    const { effects } = applyStateEvent({ sessionEnded: true, status: "idle" }, ctx());
    // Idle notification fires (before sessionEnded nuke), matching original ordering
    expect(effects.pushNotify).not.toBeNull();
    expect(effects.openSwitcher).toBe(true);
  });
});

// ============================================================
// applyTextEvent
// ============================================================
describe("applyTextEvent", () => {
  it("returns append text from data", () => {
    const { effects } = applyTextEvent({ folder: "x", append: "hello " });
    expect(effects.appendText).toBe("hello ");
  });

  it("returns empty string when no append", () => {
    const { effects } = applyTextEvent({ folder: "x" });
    expect(effects.appendText).toBe("");
  });

  it("sets status to working", () => {
    const { updates } = applyTextEvent({ folder: "x", append: "hi" });
    expect(updates.status).toBe("working");
  });
});

// ============================================================
// applyCurrentEvent
// ============================================================
describe("applyCurrentEvent — no previous message", () => {
  it("does not commit when no previous currentMessage", () => {
    const { effects } = applyCurrentEvent(
      { text: "hello", tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: null, streamingText: "" },
    );
    expect(effects.commitMessage).toBeNull();
  });

  it("sets newCurrentMessage to the data", () => {
    const data = { text: "hello", tool_calls: [], thinking: null, activity: "writing" };
    const { effects } = applyCurrentEvent(data, { currentMessage: null, streamingText: "" });
    expect(effects.newCurrentMessage).toBe(data);
  });

  it("sets newStreamingText from data.text", () => {
    const { effects } = applyCurrentEvent(
      { text: "some text", tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: null, streamingText: "" },
    );
    expect(effects.newStreamingText).toBe("some text");
  });

  it("sets newStreamingText to empty when data.text is null", () => {
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "tool" },
      { currentMessage: null, streamingText: "" },
    );
    expect(effects.newStreamingText).toBe("");
  });

  it("sets status to working", () => {
    const { updates } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: null, streamingText: "" },
    );
    expect(updates.status).toBe("working");
  });

  it("sets activity from data", () => {
    const { updates } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "tool" },
      { currentMessage: null, streamingText: "" },
    );
    expect(updates.activity).toBe("tool");
  });

  it("sets activity to null when data has no activity", () => {
    const { updates } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null },
      { currentMessage: null, streamingText: "" },
    );
    expect(updates.activity).toBeNull();
  });
});

describe("applyCurrentEvent — commit previous message", () => {
  it("commits when previous message has streamingText", () => {
    const prev = { text: null, tool_calls: [], thinking: null, activity: "writing" };
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [{ name: "Bash", status: "running" }], thinking: null, activity: "tool" },
      { currentMessage: prev, streamingText: "I'll check the files." },
    );
    expect(effects.commitMessage).toEqual({
      role: "assistant",
      content: "I'll check the files.",
      tool_calls: [],
      thinking: undefined,
    });
  });

  it("commits when previous message has tool_calls", () => {
    const prev = {
      text: "some text",
      tool_calls: [{ name: "Read", status: "completed", input: "f.ts", output: "...", collapsed: true }],
      thinking: null,
      activity: null,
    };
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: prev, streamingText: "" },
    );
    expect(effects.commitMessage).not.toBeNull();
    expect(effects.commitMessage!.tool_calls).toEqual(prev.tool_calls);
    // No streamingText, so content falls back to prev.text
    expect(effects.commitMessage!.content).toBe("some text");
  });

  it("prefers streamingText over currentMessage.text for content", () => {
    const prev = { text: "old text", tool_calls: [], thinking: "hmm", activity: "writing" };
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "tool" },
      { currentMessage: prev, streamingText: "newer accumulated text" },
    );
    expect(effects.commitMessage!.content).toBe("newer accumulated text");
    expect(effects.commitMessage!.thinking).toBe("hmm");
  });

  it("does NOT commit when previous message has no text and no tools", () => {
    const prev = { text: null, tool_calls: [], thinking: null, activity: "thinking" };
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: prev, streamingText: "" },
    );
    expect(effects.commitMessage).toBeNull();
  });

  it("does NOT commit when previous message has empty tool_calls array", () => {
    // Empty array is falsy for .length check
    const prev = { text: null, tool_calls: [], thinking: null, activity: "writing" };
    const { effects } = applyCurrentEvent(
      { text: "next", tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: prev, streamingText: "" },
    );
    expect(effects.commitMessage).toBeNull();
  });

  it("commits with null content when no text anywhere", () => {
    const prev = {
      text: null,
      tool_calls: [{ name: "Bash", status: "completed" }],
      thinking: null,
      activity: "tool",
    };
    const { effects } = applyCurrentEvent(
      { text: null, tool_calls: [], thinking: null, activity: "writing" },
      { currentMessage: prev, streamingText: "" },
    );
    expect(effects.commitMessage!.content).toBeNull();
  });
});
