// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { marked } from "marked";

const require = createRequire(import.meta.url);

// Load dependencies in order (sets window.Gdn progressively)
require("./render-utils.cjs");
(globalThis as any).marked = marked;

// Mock navigator.clipboard for attachCopyButton (used by addCopyButtons)
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});

require("./render-chips.cjs");

const { buildDepositNoteClient } = require("./render-utils.cjs" as string);
const { renderUserBubble, addCopyButtons, renderMessages } = require(
  "./render-messages.cjs" as string,
);

/** Create a fresh container element for renderMessages tests. */
function makeContainer() {
  const el = document.createElement("div");
  el.id = "messages";
  return el;
}

/** Default opts — idle, connected, no scroll offset. */
const idle = { status: "idle", connection: "connected", activity: null, userScrolledUp: false };

// ============================================================
// renderUserBubble — deposit note parsing
// ============================================================
describe("renderUserBubble", () => {
  // Use the real buildDepositNoteClient — parity gate between producer and parser
  const depositBlock = (files: string[]) =>
    buildDepositNoteClient(
      "mise/upload--test",
      {
        files: files.map((f) => ({
          deposited_as: f,
          mime_type: "text/plain",
          size_bytes: 100,
        })),
        warnings: [],
      },
    );

  it("renders plain text via marked.parseInline", () => {
    const html = renderUserBubble("hello **world**");
    expect(html).toContain("<strong>world</strong>");
  });

  it("extracts single file from deposit note", () => {
    const html = renderUserBubble(depositBlock(["report.pdf"]));
    expect(html).toContain("\u{1F4CE}");
    expect(html).toContain("report.pdf");
    expect(html).not.toContain("[gu\u00E9ridon:upload]");
  });

  it("extracts multiple files from deposit note", () => {
    const html = renderUserBubble(
      depositBlock(["a.txt", "b.png", "c.csv"]),
    );
    expect(html).toContain("a.txt");
    expect(html).toContain("b.png");
    expect(html).toContain("c.csv");
  });

  it("renders deposit + remaining text together", () => {
    const content = depositBlock(["data.csv"]) + "\nPlease analyse this file";
    const html = renderUserBubble(content);
    expect(html).toContain("\u{1F4CE}");
    expect(html).toContain("data.csv");
    expect(html).toContain("Please analyse this file");
  });

  it("handles multiple deposit blocks", () => {
    const content =
      depositBlock(["first.txt"]) + "\n" + depositBlock(["second.txt"]);
    const html = renderUserBubble(content);
    expect(html).toContain("first.txt");
    expect(html).toContain("second.txt");
  });

  it("returns empty for deposit-only content (no remaining text)", () => {
    const html = renderUserBubble(depositBlock(["only.pdf"]));
    expect(html).toContain("\u{1F4CE}");
    // No text outside the deposit block
    expect(html).not.toContain("parseInline");
  });

  it("handles incomplete deposit block (missing end marker)", () => {
    const broken = "[gu\u00E9ridon:upload] Files deposited at mise/test/\n  - f.txt (text/plain, 1 bytes)";
    const html = renderUserBubble(broken);
    // Should fall through and render as text (no extraction)
    expect(html).toContain("upload");
  });

  it("returns empty string for empty content", () => {
    expect(renderUserBubble("")).toBe("");
  });
});

// ============================================================
// addCopyButtons
// ============================================================
describe("addCopyButtons", () => {
  it("adds button to pre with code child", () => {
    const container = document.createElement("div");
    container.innerHTML = "<pre><code>const x = 1;</code></pre>";
    addCopyButtons(container);
    expect(container.querySelector(".code-copy-btn")).not.toBeNull();
  });

  it("adds button to pre without code child", () => {
    const container = document.createElement("div");
    container.innerHTML = "<pre>plain preformatted</pre>";
    addCopyButtons(container);
    expect(container.querySelector(".code-copy-btn")).not.toBeNull();
  });

  it("skips pre that already has a copy button", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<pre><code>x</code><button class="code-copy-btn">Copy</button></pre>';
    addCopyButtons(container);
    expect(container.querySelectorAll(".code-copy-btn").length).toBe(1);
  });

  it("handles multiple pre blocks", () => {
    const container = document.createElement("div");
    container.innerHTML = "<pre><code>a</code></pre><pre><code>b</code></pre>";
    addCopyButtons(container);
    expect(container.querySelectorAll(".code-copy-btn").length).toBe(2);
  });
});

// ============================================================
// renderMessages — the main render loop
// ============================================================
describe("renderMessages", () => {
  it("renders user message as msg-user", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "user", content: "hello" }], idle);
    expect(el.querySelector(".msg-user")).not.toBeNull();
    expect(el.querySelector(".msg-user")!.textContent).toContain("hello");
  });

  it("renders assistant message as msg-assistant with marked output", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "assistant", content: "**bold**" }], idle);
    const msg = el.querySelector(".msg-assistant")!;
    expect(msg).not.toBeNull();
    expect(msg.innerHTML).toContain("<strong>");
  });

  it("strips local-command-stdout tags from assistant content via trimText", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "assistant", content: "before <local-command-stdout>inner</local-command-stdout> after" }], idle);
    const msg = el.querySelector(".msg-assistant")!;
    expect(msg.textContent).toContain("inner");
    expect(msg.textContent).not.toContain("local-command-stdout");
  });

  it("adds copy buttons to code blocks in assistant messages", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "assistant", content: "```js\nconst x = 1;\n```" }], idle);
    const msg = el.querySelector(".msg-assistant")!;
    expect(msg.querySelector("pre")).not.toBeNull();
    expect(msg.querySelector(".code-copy-btn")).not.toBeNull();
  });

  it("renders synthetic user message as msg-system", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "user", content: "system info", synthetic: true }], idle);
    expect(el.querySelector(".msg-system")).not.toBeNull();
    expect(el.querySelector(".msg-user")).toBeNull();
  });

  it("renders local command as chip", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "user", content: "<local-command-stdout>output</local-command-stdout>" }], idle);
    expect(el.querySelector(".local-cmd-chip")).not.toBeNull();
  });

  it("renders tool calls as chips in a chip-grid", () => {
    const el = makeContainer();
    renderMessages(el, [{
      role: "assistant",
      content: null,
      tool_calls: [
        { name: "Read", input: "a.ts", status: "completed" },
        { name: "Grep", input: "pattern", status: "completed" },
      ],
    }], idle);
    const chips = el.querySelectorAll(".chip");
    expect(chips.length).toBe(2);
    expect(el.querySelectorAll(".chip-grid").length).toBe(1);
  });

  it("coalesces consecutive tool-call messages into one grid", () => {
    const el = makeContainer();
    renderMessages(el, [
      { role: "assistant", content: null, tool_calls: [{ name: "Read", input: "a.ts", status: "completed" }] },
      { role: "assistant", content: null, tool_calls: [{ name: "Read", input: "b.ts", status: "completed" }] },
    ], idle);
    expect(el.querySelectorAll(".chip").length).toBe(2);
    expect(el.querySelectorAll(".chip-grid").length).toBe(1);
  });

  it("text content breaks chip coalescing", () => {
    const el = makeContainer();
    renderMessages(el, [
      { role: "assistant", content: null, tool_calls: [{ name: "Read", input: "a.ts", status: "completed" }] },
      { role: "assistant", content: "some text" },
      { role: "assistant", content: null, tool_calls: [{ name: "Read", input: "b.ts", status: "completed" }] },
    ], idle);
    expect(el.querySelectorAll(".chip-grid").length).toBe(2);
  });

  it("renders thinking chip before assistant content", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "assistant", thinking: "hmm", content: "answer" }], idle);
    expect(el.querySelector(".thinking-done")).not.toBeNull();
    const children = Array.from(el.children);
    const thinkingIdx = children.findIndex(c => c.querySelector(".thinking-done"));
    const textIdx = children.findIndex(c => c.classList.contains("msg-assistant"));
    expect(thinkingIdx).toBeLessThan(textIdx);
  });

  it("shows activity chip when working and thinking", () => {
    const el = makeContainer();
    renderMessages(el, [], {
      status: "working",
      connection: "connected",
      activity: "thinking",
      userScrolledUp: false,
    });
    const chip = el.querySelector(".chip.thinking");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".c-name")!.textContent).toBe("Thinking\u2026");
  });

  it("shows writing activity chip", () => {
    const el = makeContainer();
    renderMessages(el, [], {
      status: "working",
      connection: "connected",
      activity: "writing",
      userScrolledUp: false,
    });
    expect(el.querySelector(".chip.writing")).not.toBeNull();
  });

  it("no activity chip when disconnected", () => {
    const el = makeContainer();
    renderMessages(el, [], {
      status: "working",
      connection: "disconnected",
      activity: "thinking",
      userScrolledUp: false,
    });
    expect(el.querySelector(".chip.thinking")).toBeNull();
  });

  it("no activity chip for tool activity (shown by running chip)", () => {
    const el = makeContainer();
    renderMessages(el, [], {
      status: "working",
      connection: "connected",
      activity: "Bash",
      userScrolledUp: false,
    });
    expect(el.querySelector(".chip")).toBeNull();
  });

  it("calls onError for dupe tripwire", () => {
    const el = makeContainer();
    const onError = vi.fn();
    renderMessages(el, [
      { role: "assistant", content: "same" },
      { role: "assistant", content: "same" },
    ], { ...idle, onError });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("dupe-tripwire"));
  });

  it("sets msgId dataset on user messages", () => {
    const el = makeContainer();
    renderMessages(el, [{ role: "user", content: "hi", _msgId: "abc-123" }], idle);
    expect((el.querySelector(".msg-user") as HTMLElement).dataset.msgId).toBe("abc-123");
  });
});
