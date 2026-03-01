// @vitest-environment jsdom
/**
 * Client module chain integration test (gdn-vufehu).
 *
 * Loads all client/*.cjs modules in dependency order (matching the
 * <script> tag chain in index.html) and verifies:
 * 1. Every expected export lands on window.Gdn
 * 2. A basic renderMessages call produces correct DOM output
 */
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { marked } from "marked";

const require = createRequire(import.meta.url);

// Mock navigator.clipboard (needed by attachCopyButton)
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});

// Provide marked globally (loaded as <script> in browser)
(globalThis as any).marked = marked;

// Load in exact <script> order from index.html:
// marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → render-overlays.js
require("./render-utils.cjs");
require("./render-chips.cjs");
require("./render-messages.cjs");
require("./render-chrome.cjs");
require("./render-overlays.cjs");

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
    "renderUserBubble", "addCopyButtons", "renderMessages",
  ],
  "render-chrome": [
    "renderStatusBar", "renderSwitcher", "updatePlaceholder", "updateSendButton",
  ],
  "render-overlays": [
    "showAskUserOverlay", "hideAskUserOverlay", "getSlashCommands",
    "renderSlashList", "openSlashSheet", "showStagedError", "renderStagedDeposits",
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
