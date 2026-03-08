// @vitest-environment jsdom
/**
 * Client module chain integration test (gdn-vufehu, gdn-jowebu).
 *
 * Loads all client/*.cjs modules in dependency order (matching the
 * <script> tag chain in index.html) and verifies:
 * 1. Every expected export lands on window.Gdn
 * 2. A basic renderMessages call produces correct DOM output
 * 3. Every .cjs module wraps its code in an IIFE (Safari global-scope leakage guard)
 */
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { marked } from "marked";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// Mock navigator.clipboard (needed by attachCopyButton)
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});

// Provide marked globally (loaded as <script> in browser)
(globalThis as any).marked = marked;

// Load in exact <script> order from index.html:
// marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → render-overlays.js → state-handlers.js
require("./render-utils.cjs");
require("./render-chips.cjs");
require("./render-messages.cjs");
require("./render-chrome.cjs");
require("./render-overlays.cjs");
require("./state-handlers.cjs");

const Gdn = (window as any).Gdn;

// -- Expected exports (from CLAUDE.md module table) --

const EXPECTED_EXPORTS: Record<string, string[]> = {
  "render-utils": [
    "esc", "trimText", "trimToolOutput", "truncateThinking",
    "buildDepositNoteClient", "timeAgo", "shortModel", "THINKING_TRUNCATE",
  ],
  "render-chips": [
    "renderChip", "renderThinkingChip", "renderLocalCommand", "attachCopyButton",
  ],
  "render-messages": [
    "renderUserBubble", "addCopyButtons", "renderMessages", "truncateAutolinks",
  ],
  "render-chrome": [
    "renderStatusBar", "renderSwitcher", "updatePlaceholder", "updateSendButton",
  ],
  "render-overlays": [
    "showAskUserOverlay", "hideAskUserOverlay", "getSlashCommands",
    "renderSlashList", "openSlashSheet", "showStagedError", "renderStagedDeposits",
  ],
  "state-handlers": [
    "applyStateEvent", "applyTextEvent", "applyCurrentEvent",
  ],
};

describe("client module chain", () => {
  it("window.Gdn exists after loading all modules", () => {
    expect(Gdn).toBeDefined();
    expect(typeof Gdn).toBe("object");
  });

  for (const [mod, fns] of Object.entries(EXPECTED_EXPORTS)) {
    describe(mod, () => {
      for (const fn of fns) {
        it(`exports ${fn}`, () => {
          expect(Gdn[fn]).toBeDefined();
        });
      }
    });
  }

  it("Gdn has no unexpected exports beyond EXPECTED_EXPORTS", () => {
    const allExpected = new Set(
      Object.values(EXPECTED_EXPORTS).flat(),
    );
    const actual = Object.keys(Gdn);
    const unexpected = actual.filter((k) => !allExpected.has(k));
    expect(unexpected).toEqual([]);
  });

  it("renderMessages produces DOM from a simple assistant message", () => {
    const container = document.createElement("div");
    const messages = [
      { role: "assistant", content: "Hello world", model: "claude-opus-4-6" },
    ];

    Gdn.renderMessages(container, messages, {
      liveState: null,
      isStreaming: false,
      pendingAskUser: null,
      stagedDeposits: [],
      onAskAnswer: () => {},
      onAskDismiss: () => {},
    });

    // Should produce at least one child element
    expect(container.children.length).toBeGreaterThan(0);
    // Should contain the message text somewhere in the output
    expect(container.textContent).toContain("Hello world");
  });

  it("renderMessages handles user message with deposit note", () => {
    const container = document.createElement("div");
    const messages = [
      {
        role: "user",
        content: "[guéridon:upload]\nFiles deposited to `mise/upload--test--abc/`:\n- test.txt (text/plain, 42 bytes)\n\nPlease review",
      },
    ];

    Gdn.renderMessages(container, messages, {
      liveState: null,
      isStreaming: false,
      pendingAskUser: null,
      stagedDeposits: [],
      onAskAnswer: () => {},
      onAskDismiss: () => {},
    });

    expect(container.textContent).toContain("test.txt");
    expect(container.textContent).toContain("Please review");
  });
});

// ============================================================
// Safari IIFE guard (gdn-jowebu)
//
// Safari/WebKit throws SyntaxError when const/let shadows a global property
// created by a top-level function declaration. If an IIFE is removed from a
// .cjs module, its function declarations leak to window, and the Gdn
// destructuring in the inline script (`const { renderStatusBar } = Gdn`)
// collides — blank page on iOS.
// ============================================================
describe("Safari IIFE guard (gdn-jowebu)", () => {
  const CLIENT_DIR = join(__dirname, ".");
  const cjsFiles = readdirSync(CLIENT_DIR).filter(f => f.endsWith(".cjs"));

  // Regex: top-level function declaration = "function name(" at the start of a line
  // (after trimming), NOT indented inside an IIFE. We check that the entire file
  // is wrapped by verifying the first non-comment, non-empty line is `(function() {`
  // and the last non-empty line is `})();`.

  for (const file of cjsFiles) {
    it(`${file} wraps content in an IIFE`, () => {
      const src = readFileSync(join(CLIENT_DIR, file), "utf-8");
      const lines = src.split("\n");

      // Strip leading block comment (/** ... */) and blank lines
      let firstCodeLine = "";
      let inBlockComment = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (inBlockComment) {
          if (trimmed.includes("*/")) inBlockComment = false;
          continue;
        }
        if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
          if (!trimmed.includes("*/")) inBlockComment = true;
          continue;
        }
        if (trimmed === "" || trimmed.startsWith("//")) continue;
        firstCodeLine = trimmed;
        break;
      }

      // Last non-empty line
      let lastCodeLine = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed !== "") { lastCodeLine = trimmed; break; }
      }

      expect(firstCodeLine).toMatch(/^\(function\s*\(\)\s*\{$/);
      expect(lastCodeLine).toMatch(/^\}\)\(\);$/);
    });
  }

  it("no exported function name collides with a browser global", () => {
    // These are Web API globals that Safari forbids shadowing with const/let.
    // Not exhaustive, but covers the dangerous ones for our function names.
    const DANGEROUS_GLOBALS = new Set([
      "fetch", "close", "open", "focus", "blur", "scroll", "stop",
      "print", "alert", "confirm", "prompt", "find", "name", "status",
      "event", "location", "history", "navigator", "screen",
    ]);

    const allExports = Object.values(EXPECTED_EXPORTS).flat();
    const collisions = allExports.filter(name => DANGEROUS_GLOBALS.has(name));
    expect(collisions).toEqual([]);
  });
});
