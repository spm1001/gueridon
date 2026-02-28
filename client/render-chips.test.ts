// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { marked } from "marked";

const require = createRequire(import.meta.url);

// Load render-utils first (sets window.Gdn)
require("./render-utils.cjs");

// Provide marked globally (loaded as <script> in browser)
(globalThis as any).marked = marked;

// Mock navigator.clipboard
const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const {
  attachCopyButton,
  renderChip,
  renderThinkingChip,
  renderLocalCommand,
} = require("./render-chips.cjs" as string);

beforeEach(() => {
  writeText.mockClear();
});

// ============================================================
// attachCopyButton
// ============================================================
describe("attachCopyButton", () => {
  it("creates a button with correct class and text", () => {
    const parent = document.createElement("div");
    const btn = attachCopyButton(parent, "hello");
    expect(btn.className).toBe("code-copy-btn");
    expect(btn.textContent).toBe("Copy");
  });

  it("appends button to parent", () => {
    const parent = document.createElement("div");
    attachCopyButton(parent, "hello");
    expect(parent.querySelector(".code-copy-btn")).not.toBeNull();
  });

  it("returns the button element", () => {
    const parent = document.createElement("div");
    const btn = attachCopyButton(parent, "test");
    expect(btn).toBeInstanceOf(HTMLButtonElement);
  });

  it("writes text to clipboard on click", () => {
    const parent = document.createElement("div");
    attachCopyButton(parent, "copied text");
    (parent.querySelector(".code-copy-btn") as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith("copied text");
  });
});

// ============================================================
// renderChip — tool call chips
// ============================================================
describe("renderChip", () => {
  it("renders completed status", () => {
    const chip = renderChip({ name: "Read", input: "file.ts", output: "contents", status: "completed" });
    expect(chip.querySelector(".c-status")!.classList.contains("done")).toBe(true);
    expect(chip.classList.contains("chip")).toBe(true);
    expect(chip.classList.contains("error")).toBe(false);
    expect(chip.classList.contains("running")).toBe(false);
  });

  it("renders running status", () => {
    const chip = renderChip({ name: "Bash", input: "npm test", status: "running" });
    expect(chip.querySelector(".c-status")!.classList.contains("run")).toBe(true);
    expect(chip.classList.contains("running")).toBe(true);
  });

  it("renders error status", () => {
    const chip = renderChip({ name: "Edit", input: "x.ts", output: "fail", status: "error" });
    expect(chip.querySelector(".c-status")!.classList.contains("err")).toBe(true);
    expect(chip.classList.contains("error")).toBe(true);
  });

  it("displays tool name", () => {
    const chip = renderChip({ name: "Grep", input: "pattern", status: "completed" });
    expect(chip.querySelector(".c-name")!.textContent).toBe("Grep");
  });

  it("displays input in c-path", () => {
    const chip = renderChip({ name: "Read", input: "server/bridge.ts", status: "completed" });
    expect(chip.querySelector(".c-path")!.textContent).toBe("server/bridge.ts");
  });

  it("omits c-path when input is empty", () => {
    const chip = renderChip({ name: "Bash", input: "", status: "completed" });
    expect(chip.querySelector(".c-path")).toBeNull();
  });

  it("sets dataset.toolId", () => {
    const chip = renderChip({ name: "Read", input: "a.ts", status: "completed" });
    expect(chip.dataset.toolId).toBe("Read|a.ts");
  });

  it("toggles expanded on click", () => {
    const chip = renderChip({ name: "Read", input: "a.ts", status: "completed" });
    chip.click();
    expect(chip.classList.contains("expanded")).toBe(true);
    chip.click();
    expect(chip.classList.contains("expanded")).toBe(false);
  });

  it("includes copy button in detail", () => {
    const chip = renderChip({ name: "Read", input: "a.ts", output: "data", status: "completed" });
    expect(chip.querySelector(".c-detail .code-copy-btn")).not.toBeNull();
  });

  it("copies input + trimmed output to clipboard", () => {
    const chip = renderChip({ name: "Read", input: "a.ts", output: "line1\nline2", status: "completed" });
    (chip.querySelector(".code-copy-btn") as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith("a.ts\nline1\nline2");
  });
});

// ============================================================
// renderThinkingChip
// ============================================================
describe("renderThinkingChip", () => {
  it("renders short thinking without truncation", () => {
    const chip = renderThinkingChip("brief thought");
    expect(chip.querySelector(".c-detail")!.textContent).toContain("brief thought");
    expect(chip.querySelector(".thinking-more")).toBeNull();
  });

  it("renders long thinking with truncation and show-more link", () => {
    const long = "a".repeat(600);
    const chip = renderThinkingChip(long);
    const detail = chip.querySelector(".c-detail")!;
    // Truncated text should be shorter than full
    expect(detail.textContent!.length).toBeLessThan(long.length);
    expect(chip.querySelector(".thinking-more")).not.toBeNull();
  });

  it("has thinking-done class", () => {
    const chip = renderThinkingChip("thought");
    expect(chip.classList.contains("thinking-done")).toBe(true);
  });

  it("has accent-colored status icon", () => {
    const chip = renderThinkingChip("thought");
    const status = chip.querySelector(".c-status")! as HTMLElement;
    expect(status.style.color).toBe("var(--accent)");
  });

  it("toggles expanded on click", () => {
    const chip = renderThinkingChip("thought");
    chip.click();
    expect(chip.classList.contains("expanded")).toBe(true);
  });

  it("copies full (untruncated) text to clipboard", () => {
    const long = "b".repeat(600);
    const chip = renderThinkingChip(long);
    (chip.querySelector(".code-copy-btn") as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith(long);
  });

  it("show-full-thinking replaces truncated text", () => {
    const long = "c".repeat(600);
    const chip = renderThinkingChip(long);
    const moreLink = chip.querySelector(".thinking-more")! as HTMLElement;
    moreLink.click();
    const detail = chip.querySelector(".c-detail")!;
    // After expanding, detail should contain the full text
    expect(detail.textContent).toContain(long);
    // Copy button should still be present
    expect(detail.querySelector(".code-copy-btn")).not.toBeNull();
  });
});

// ============================================================
// renderLocalCommand
// ============================================================
describe("renderLocalCommand", () => {
  it("extracts content from local-command-stdout tags", () => {
    const chip = renderLocalCommand("<local-command-stdout>hello world</local-command-stdout>");
    expect(chip.querySelector(".c-detail")!.textContent).toContain("hello world");
  });

  it("falls back to raw content without tags", () => {
    const chip = renderLocalCommand("plain text");
    expect(chip.querySelector(".c-detail")!.textContent).toContain("plain text");
  });

  it("extracts Tokens summary for /context output", () => {
    const content = "<local-command-stdout># Context\n**Tokens:** 75.2k / 200k (38%)\nOther info</local-command-stdout>";
    const chip = renderLocalCommand(content);
    expect(chip.querySelector(".c-path")!.textContent).toContain("Tokens:");
  });

  it("uses short content as summary", () => {
    const chip = renderLocalCommand("<local-command-stdout>Compacted</local-command-stdout>");
    expect(chip.querySelector(".c-path")!.textContent).toBe("Compacted");
  });

  it("has local-cmd-chip class", () => {
    const chip = renderLocalCommand("<local-command-stdout>x</local-command-stdout>");
    expect(chip.classList.contains("local-cmd-chip")).toBe(true);
  });

  it("renders content via marked.parse", () => {
    const chip = renderLocalCommand("<local-command-stdout>**bold**</local-command-stdout>");
    const detail = chip.querySelector(".c-detail")!;
    expect(detail.innerHTML).toContain("<strong>");
  });

  it("toggles expanded on click", () => {
    const chip = renderLocalCommand("<local-command-stdout>x</local-command-stdout>");
    chip.click();
    expect(chip.classList.contains("expanded")).toBe(true);
  });

  it("copies raw inner content to clipboard", () => {
    const chip = renderLocalCommand("<local-command-stdout>copy me</local-command-stdout>");
    (chip.querySelector(".code-copy-btn") as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith("copy me");
  });
});
