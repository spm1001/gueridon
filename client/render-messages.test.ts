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
const { renderUserBubble, addCopyButtons } = require(
  "./render-messages.cjs" as string,
);

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
