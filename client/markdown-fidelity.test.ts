// @vitest-environment jsdom
/**
 * Markdown rendering fidelity tests (gdn-nevedi).
 *
 * Feeds real CC output patterns through renderMessages and renderUserBubble
 * with the real marked library (not a mock). Asserts correct HTML structure:
 * tags, nesting, code block preservation, inline formatting.
 */
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { marked } from "marked";

const require = createRequire(import.meta.url);

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});
(globalThis as any).marked = marked;

require("./render-utils.cjs");
require("./render-chips.cjs");
require("./render-messages.cjs");

const { renderMessages, renderUserBubble } = require("./render-messages.cjs" as string);
const FIX = require("./fixtures.cjs" as string);

/** Helper: render a single assistant message and return the .msg-assistant div */
function renderAssistant(content: string): HTMLDivElement {
  const container = document.createElement("div");
  renderMessages(container, [{ role: "assistant", content }], {
    liveState: null,
    isStreaming: false,
    pendingAskUser: null,
    stagedDeposits: [],
    onAskAnswer: () => {},
    onAskDismiss: () => {},
  });
  return container.querySelector(".msg-assistant") as HTMLDivElement;
}

// ============================================================
// Fenced code blocks
// ============================================================
describe("fenced code blocks", () => {
  it("renders code block with language class", () => {
    const div = renderAssistant(FIX.MD_FENCED_CODE_WITH_LANG);
    const pre = div.querySelector("pre");
    expect(pre).toBeTruthy();
    const code = pre!.querySelector("code");
    expect(code).toBeTruthy();
    expect(code!.className).toContain("language-css");
    expect(code!.textContent).toContain("gap: 8px");
  });

  it("renders code block without language", () => {
    const div = renderAssistant(FIX.MD_FENCED_CODE_NO_LANG);
    const pre = div.querySelector("pre");
    expect(pre).toBeTruthy();
    const code = pre!.querySelector("code");
    expect(code).toBeTruthy();
    expect(code!.textContent).toContain("474 tests passed");
  });

  it("preserves consecutive code blocks as separate <pre> elements", () => {
    const div = renderAssistant(FIX.MD_CONSECUTIVE_CODE_BLOCKS);
    const pres = div.querySelectorAll("pre");
    expect(pres.length).toBe(2);
    expect(pres[0].textContent).toContain("const x = 1");
    expect(pres[1].textContent).toContain("const x = 2");
  });

  it("adds copy buttons to code blocks", () => {
    const div = renderAssistant(FIX.MD_FENCED_CODE_WITH_LANG);
    const btn = div.querySelector(".code-copy-btn");
    expect(btn).toBeTruthy();
  });
});

// ============================================================
// Lists
// ============================================================
describe("nested bullet lists", () => {
  it("produces nested <ul> structure", () => {
    const div = renderAssistant(FIX.MD_NESTED_BULLETS);
    const topUl = div.querySelector("ul");
    expect(topUl).toBeTruthy();
    // Should have nested lists
    const nestedUls = div.querySelectorAll("ul ul");
    expect(nestedUls.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves inline formatting inside list items", () => {
    const div = renderAssistant(FIX.MD_NESTED_BULLETS);
    const strongs = div.querySelectorAll("li > strong");
    expect(strongs.length).toBeGreaterThanOrEqual(1);
    // Bold text should contain "Server" or "Client"
    const boldTexts = Array.from(strongs).map((s) => s.textContent);
    expect(boldTexts.some((t) => t!.includes("Server"))).toBe(true);
  });

  it("preserves inline code inside list items", () => {
    const div = renderAssistant(FIX.MD_NESTED_BULLETS);
    const codes = div.querySelectorAll("li code");
    expect(codes.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Tables
// ============================================================
describe("markdown tables", () => {
  it("renders a <table> with headers and rows", () => {
    const div = renderAssistant(FIX.MD_TABLE);
    const table = div.querySelector("table");
    expect(table).toBeTruthy();
    const ths = table!.querySelectorAll("th");
    expect(ths.length).toBe(2);
    expect(ths[0].textContent).toBe("File");
    expect(ths[1].textContent).toBe("Exports");
    const rows = table!.querySelectorAll("tbody tr");
    expect(rows.length).toBe(3);
  });

  it("renders inline code inside table cells", () => {
    const div = renderAssistant(FIX.MD_TABLE);
    const codes = div.querySelectorAll("td code");
    expect(codes.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// Inline formatting
// ============================================================
describe("inline formatting", () => {
  it("renders code inside bold", () => {
    const div = renderAssistant(FIX.MD_INLINE_CODE_IN_BOLD);
    // Should have <strong><code>renderMessages</code></strong> or similar
    const strongs = div.querySelectorAll("strong");
    const hasCodeInStrong = Array.from(strongs).some(
      (s) => s.querySelector("code") !== null,
    );
    expect(hasCodeInStrong).toBe(true);
  });

  it("renders HTML entity references in prose", () => {
    const div = renderAssistant(FIX.MD_HTML_ENTITIES);
    // The backtick-wrapped entities should be in <code> tags
    const codes = div.querySelectorAll("code");
    const codeTexts = Array.from(codes).map((c) => c.textContent);
    expect(codeTexts.some((t) => t!.includes("&lt;div&gt;"))).toBe(true);
    expect(codeTexts.some((t) => t!.includes("esc()"))).toBe(true);
  });
});

// ============================================================
// Mixed formatting (realistic CC response)
// ============================================================
describe("mixed formatting (real CC response shape)", () => {
  it("renders numbered list, bold+code, blockquote, and code block together", () => {
    const div = renderAssistant(FIX.MD_MIXED_FORMATTING);
    // Ordered list
    const ol = div.querySelector("ol");
    expect(ol).toBeTruthy();
    expect(ol!.querySelectorAll("li").length).toBe(3);
    // Blockquote
    expect(div.querySelector("blockquote")).toBeTruthy();
    // Code block
    expect(div.querySelector("pre code")).toBeTruthy();
    // Bold + code in list items
    const li = ol!.querySelector("li");
    expect(li!.querySelector("strong")).toBeTruthy();
    expect(li!.querySelector("code")).toBeTruthy();
  });
});

// ============================================================
// Headings
// ============================================================
describe("headings with inline code", () => {
  it("renders h2 and h3 with code spans", () => {
    const div = renderAssistant(FIX.MD_HEADING_WITH_CODE);
    const h2 = div.querySelector("h2");
    expect(h2).toBeTruthy();
    expect(h2!.querySelector("code")).toBeTruthy();
    expect(h2!.textContent).toContain("--what");
    const h3 = div.querySelector("h3");
    expect(h3).toBeTruthy();
  });
});

// ============================================================
// Links
// ============================================================
describe("links", () => {
  it("renders markdown links as <a> tags", () => {
    const div = renderAssistant(FIX.MD_LINK_AND_IMAGE);
    const link = div.querySelector("a");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toContain("github.com");
    expect(link!.textContent).toContain("CC #27099");
  });
});

// ============================================================
// Thinking blocks with code
// ============================================================
describe("thinking blocks with code", () => {
  it("renders thinking chip with code preserved in detail", () => {
    const container = document.createElement("div");
    renderMessages(
      container,
      [{ role: "assistant", content: "Moved the map.", thinking: FIX.MD_THINKING_WITH_CODE }],
      {
        liveState: null,
        isStreaming: false,
        pendingAskUser: null,
        stagedDeposits: [],
        onAskAnswer: () => {},
        onAskDismiss: () => {},
      },
    );
    // Thinking chip should exist
    const chip = container.querySelector(".chip.thinking-done");
    expect(chip).toBeTruthy();
    // Detail should contain code content (escaped, not parsed)
    const detail = chip!.querySelector(".c-detail");
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain("STATIC_FILES");
    // Assistant content should be rendered via marked
    const assistant = container.querySelector(".msg-assistant");
    expect(assistant).toBeTruthy();
    expect(assistant!.textContent).toContain("Moved the map.");
  });
});

// ============================================================
// renderUserBubble with inline markdown
// ============================================================
describe("renderUserBubble", () => {
  it("renders inline markdown (bold, code) in user text", () => {
    const html = renderUserBubble("Try **`renderMessages`** with the new `opts` interface");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
    expect(html).toContain("renderMessages");
  });

  it("does not wrap inline content in <p> tags", () => {
    const html = renderUserBubble("Fix the CSS gap");
    // parseInline should NOT produce block-level elements
    expect(html).not.toContain("<p>");
  });

  it("handles deposit note + remaining text", () => {
    const content = [
      "[guéridon:upload]",
      "Files deposited to `mise/upload--test--abc/`:",
      "  - screenshot.png (image/png, 54 KB)",
      "manifest.json has full metadata. Read the files if relevant to our conversation.",
      "",
      "Here's the **screenshot**",
    ].join("\n");
    const html = renderUserBubble(content);
    expect(html).toContain("screenshot.png");
    expect(html).toContain("<strong>");
  });
});
