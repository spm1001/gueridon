// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  esc,
  trimText,
  trimToolOutput,
  truncateThinking,
  buildDepositNoteClient,
  timeAgo,
  shortModel,
  THINKING_TRUNCATE,
} = require("./render-utils.cjs");

// ============================================================
// esc
// ============================================================
describe("esc", () => {
  it("escapes angle brackets", () => {
    expect(esc("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(esc("A & B")).toBe("A &amp; B");
  });

  it("preserves quotes (textContent does not escape them)", () => {
    expect(esc('"hello"')).toBe('"hello"');
  });

  it("passes through plain text unchanged", () => {
    expect(esc("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(esc("")).toBe("");
  });
});

// ============================================================
// trimText
// ============================================================
describe("trimText", () => {
  it("strips <local-command-stdout> tags and keeps inner content", () => {
    const input =
      "before <local-command-stdout>inner content</local-command-stdout> after";
    expect(trimText(input)).toBe("before inner content after");
  });

  it("handles multiple tags", () => {
    const input =
      "<local-command-stdout>one</local-command-stdout> mid <local-command-stdout>two</local-command-stdout>";
    expect(trimText(input)).toBe("one mid two");
  });

  it("trims whitespace inside tags", () => {
    const input = "<local-command-stdout>  padded  </local-command-stdout>";
    expect(trimText(input)).toBe("padded");
  });

  it("returns null/empty unchanged", () => {
    expect(trimText(null)).toBe(null);
    expect(trimText("")).toBe("");
  });

  it("passes through text without tags", () => {
    expect(trimText("no tags here")).toBe("no tags here");
  });
});

// ============================================================
// trimToolOutput
// ============================================================
describe("trimToolOutput", () => {
  it("returns short output unchanged", () => {
    const output = "line1\nline2\nline3";
    expect(trimToolOutput(output, 10)).toBe(output);
  });

  it("truncates long output with head/tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
    const result = trimToolOutput(lines.join("\n"), 10);
    expect(result).toContain("line0");
    expect(result).toContain("line4"); // head = ceil(10/2) = 5
    expect(result).toContain("… 30 lines hidden …");
    expect(result).toContain("line35");
    expect(result).toContain("line39");
  });

  it("uses default maxLines of 30", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    const result = trimToolOutput(lines.join("\n"));
    expect(result).toContain("… 20 lines hidden …");
  });

  it("returns null/empty unchanged", () => {
    expect(trimToolOutput(null)).toBe(null);
    expect(trimToolOutput("")).toBe("");
  });

  it("handles exactly maxLines (no truncation)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    expect(trimToolOutput(lines.join("\n"), 10)).toBe(lines.join("\n"));
  });
});

// ============================================================
// truncateThinking
// ============================================================
describe("truncateThinking", () => {
  it("returns short text unchanged", () => {
    expect(truncateThinking("short")).toBe("short");
  });

  it("truncates text beyond THINKING_TRUNCATE chars", () => {
    const long = "a".repeat(THINKING_TRUNCATE + 100);
    const result = truncateThinking(long);
    expect(result.length).toBe(THINKING_TRUNCATE + 1); // +1 for ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns text at exactly THINKING_TRUNCATE unchanged", () => {
    const exact = "b".repeat(THINKING_TRUNCATE);
    expect(truncateThinking(exact)).toBe(exact);
  });
});

// ============================================================
// buildDepositNoteClient
// ============================================================
describe("buildDepositNoteClient", () => {
  it("formats single file without warnings", () => {
    const manifest = {
      files: [
        {
          deposited_as: "report.pdf",
          mime_type: "application/pdf",
          size_bytes: 54321,
        },
      ],
      warnings: [],
    };
    const result = buildDepositNoteClient("mise/upload--test--abc", manifest);
    expect(result).toContain("[guéridon:upload]");
    expect(result).toContain("mise/upload--test--abc/");
    expect(result).toContain("report.pdf (application/pdf, 54321 bytes)");
    expect(result).toContain("manifest.json has full metadata");
    expect(result).not.toContain("⚠️");
  });

  it("formats multiple files with warnings", () => {
    const manifest = {
      files: [
        {
          deposited_as: "data.csv",
          mime_type: "text/csv",
          size_bytes: 100,
        },
        {
          deposited_as: "fake.png",
          mime_type: "application/octet-stream",
          size_bytes: 4,
        },
      ],
      warnings: ["fake.png: deposited as binary"],
    };
    const result = buildDepositNoteClient("mise/upload--data--xyz", manifest);
    expect(result).toContain("data.csv (text/csv, 100 bytes)");
    expect(result).toContain(
      "fake.png (application/octet-stream, 4 bytes)",
    );
    expect(result).toContain("⚠️ fake.png: deposited as binary");
  });
});

// ============================================================
// timeAgo
// ============================================================
describe("timeAgo", () => {
  it("returns 'now' for recent timestamps", () => {
    expect(timeAgo(new Date().toISOString())).toBe("now");
  });

  it("returns minutes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(timeAgo(fiveMinAgo)).toBe("5m");
  });

  it("returns hours", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    expect(timeAgo(threeHoursAgo)).toBe("3h");
  });

  it("returns days", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    expect(timeAgo(twoDaysAgo)).toBe("2d");
  });

  it("returns empty for null/undefined", () => {
    expect(timeAgo(null)).toBe("");
    expect(timeAgo(undefined)).toBe("");
  });

  it("returns empty for bad data (negative or >1 year)", () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    expect(timeAgo(future)).toBe("");
  });
});

// ============================================================
// shortModel
// ============================================================
describe("shortModel", () => {
  it("strips claude- prefix and trailing date suffix", () => {
    expect(shortModel("claude-sonnet-4-5-20250514")).toBe("sonnet-4-5");
  });

  it("strips claude- prefix and trailing digit segment", () => {
    // /-\d+$/ matches the last -digits segment: "opus-4-6" → strips "-6"
    expect(shortModel("claude-opus-4-6")).toBe("opus-4");
  });

  it("returns empty for null/undefined", () => {
    expect(shortModel(null)).toBe("");
    expect(shortModel(undefined)).toBe("");
  });

  it("strips trailing digit segment from non-claude models too", () => {
    // No claude- prefix but regex still strips /-\d+$/
    expect(shortModel("gpt-4")).toBe("gpt");
  });
});
