// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load dependency chain
require("./render-utils.cjs");

const {
  showAskUserOverlay, hideAskUserOverlay,
  getSlashCommands, renderSlashList, openSlashSheet,
  showStagedError, renderStagedDeposits,
} = require("./render-overlays.cjs" as string);

// ============================================================
// AskUserQuestion overlay
// ============================================================

function makeAskEls() {
  return {
    backdrop: document.createElement("div"),
    sheet: document.createElement("div"),
    content: document.createElement("div"),
  };
}

describe("showAskUserOverlay", () => {
  it("renders single-select options with header and question", () => {
    const els = makeAskEls();
    const onAnswer = vi.fn();
    const questions = [{
      header: "Auth",
      question: "Which method?",
      multiSelect: false,
      options: [
        { label: "OAuth", description: "Use OAuth 2.0" },
        { label: "JWT", description: "JSON Web Tokens" },
      ],
    }];
    showAskUserOverlay(questions, "tc1", { els, onAnswer, onDismiss: vi.fn() });

    expect(els.backdrop.dataset.open).toBe("true");
    expect(els.sheet.dataset.open).toBe("true");
    expect(els.content.querySelector(".ask-header")!.textContent).toBe("Auth");
    expect(els.content.querySelector(".ask-question")!.textContent).toBe("Which method?");
    expect(els.content.querySelectorAll(".ask-option")).toHaveLength(2);
  });

  it("single-select immediate mode fires onAnswer on tap", () => {
    const els = makeAskEls();
    const onAnswer = vi.fn();
    const questions = [{
      header: "Pick",
      question: "One?",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    }];
    showAskUserOverlay(questions, "tc2", { els, onAnswer, onDismiss: vi.fn() });

    // Tap second option
    const opts = els.content.querySelectorAll(".ask-option");
    (opts[1] as HTMLElement).click();

    expect(onAnswer).toHaveBeenCalledWith("B");
    expect(els.backdrop.dataset.open).toBe("false");
  });

  it("multi-select shows confirm button and toggles selection", () => {
    const els = makeAskEls();
    const onAnswer = vi.fn();
    const questions = [{
      header: "Features",
      question: "Which?",
      multiSelect: true,
      options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
    }];
    showAskUserOverlay(questions, "tc3", { els, onAnswer, onDismiss: vi.fn() });

    expect(els.content.querySelector(".ask-confirm")).not.toBeNull();

    // Toggle X and Z
    const opts = els.content.querySelectorAll(".ask-option");
    (opts[0] as HTMLElement).click();
    (opts[2] as HTMLElement).click();
    expect(opts[0].getAttribute("data-selected")).toBe("true");
    expect(opts[1].getAttribute("data-selected")).toBeNull();
    expect(opts[2].getAttribute("data-selected")).toBe("true");

    // Confirm
    (els.content.querySelector(".ask-confirm") as HTMLElement).click();
    expect(onAnswer).toHaveBeenCalledWith("X, Z");
  });

  it("custom answer dismisses and calls onDismiss", () => {
    const els = makeAskEls();
    const onDismiss = vi.fn();
    const questions = [{
      header: "H",
      question: "Q?",
      multiSelect: false,
      options: [{ label: "A" }],
    }];
    showAskUserOverlay(questions, "tc4", { els, onAnswer: vi.fn(), onDismiss });

    (els.content.querySelector(".ask-custom") as HTMLElement).click();
    expect(onDismiss).toHaveBeenCalled();
    expect(els.backdrop.dataset.open).toBe("false");
  });

  it("multi-question collects header: label pairs", () => {
    const els = makeAskEls();
    const onAnswer = vi.fn();
    const questions = [
      { header: "Color", question: "Pick color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
      { header: "Size", question: "Pick size", multiSelect: false, options: [{ label: "S" }, { label: "L" }] },
    ];
    showAskUserOverlay(questions, "tc5", { els, onAnswer, onDismiss: vi.fn() });

    // Select Red and L
    const colorOpts = els.content.querySelectorAll('.ask-option[data-qi="0"]');
    const sizeOpts = els.content.querySelectorAll('.ask-option[data-qi="1"]');
    (colorOpts[0] as HTMLElement).click();
    (sizeOpts[1] as HTMLElement).click();

    // Confirm (multi-question always has confirm button)
    (els.content.querySelector(".ask-confirm") as HTMLElement).click();
    expect(onAnswer).toHaveBeenCalledWith("Color: Red\nSize: L");
  });
});

describe("hideAskUserOverlay", () => {
  it("sets both elements to closed", () => {
    const els = makeAskEls();
    els.backdrop.dataset.open = "true";
    els.sheet.dataset.open = "true";
    hideAskUserOverlay(els);
    expect(els.backdrop.dataset.open).toBe("false");
    expect(els.sheet.dataset.open).toBe("false");
  });
});

// ============================================================
// Slash command sheet
// ============================================================

describe("getSlashCommands", () => {
  it("returns bridge + fallback when no CC commands", () => {
    const cmds = getSlashCommands(null);
    const names = cmds.map((c: any) => c.name);
    expect(names).toContain("abort");
    expect(names).toContain("exit");
    expect(names).toContain("compact");
    // All should be local
    expect(cmds.every((c: any) => c.local)).toBe(true);
  });

  it("merges CC commands with bridge, deduplicates", () => {
    const cc = [
      { name: "help", description: "Get help", local: true },
      { name: "commit", description: "Create a commit" },
    ];
    const cmds = getSlashCommands(cc);
    const names = cmds.map((c: any) => c.name);
    // Bridge commands present
    expect(names).toContain("abort");
    expect(names).toContain("exit");
    // CC commands present
    expect(names).toContain("help");
    expect(names).toContain("commit");
    // No duplicates
    expect(names.filter((n: string) => n === "abort")).toHaveLength(1);
  });

  it("sorts locals first, then alphabetical", () => {
    const cc = [
      { name: "commit", description: "Commit" },
      { name: "clear", description: "Clear", local: true },
    ];
    const cmds = getSlashCommands(cc);
    const names = cmds.map((c: any) => c.name);
    // All locals should come before non-locals
    const firstNonLocal = names.findIndex(
      (n: string) => !cmds.find((c: any) => c.name === n && c.local)
    );
    const lastLocal = names.length - 1 - [...names].reverse().findIndex(
      (n: string) => cmds.find((c: any) => c.name === n && c.local)
    );
    expect(firstNonLocal).toBeGreaterThan(lastLocal);
  });
});

describe("renderSlashList", () => {
  function makeSlashEls() {
    const sheet = document.createElement("div");
    sheet.classList.add("open");
    return {
      list: document.createElement("div"),
      sheet,
      searchInput: document.createElement("input"),
    };
  }

  it("renders command rows", () => {
    const els = makeSlashEls();
    const onSelect = vi.fn();
    renderSlashList("", { ccCommands: null, els, onSelect });

    const rows = els.list.querySelectorAll(".slash-cmd");
    expect(rows.length).toBeGreaterThan(0);
    // Each row has a name
    expect(rows[0].querySelector(".slash-cmd-name")).not.toBeNull();
  });

  it("filters by name", () => {
    const els = makeSlashEls();
    renderSlashList("abort", { ccCommands: null, els, onSelect: vi.fn() });
    const rows = els.list.querySelectorAll(".slash-cmd");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".slash-cmd-name")!.textContent).toBe("abort");
  });

  it("clicking a row calls onSelect and closes sheet", () => {
    const els = makeSlashEls();
    const onSelect = vi.fn();
    renderSlashList("abort", { ccCommands: null, els, onSelect });

    const row = els.list.querySelector(".slash-cmd") as HTMLElement;
    row.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "abort" }));
    expect(els.sheet.classList.contains("open")).toBe(false);
  });
});

// ============================================================
// Staged deposit pills
// ============================================================

describe("showStagedError", () => {
  it("appends error message that auto-removes", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    showStagedError("Upload failed", container);

    expect(container.querySelector(".staged-error")!.textContent).toBe("Upload failed");

    vi.advanceTimersByTime(3000);
    expect(container.querySelector(".staged-error")).toBeNull();
    vi.useRealTimers();
  });
});

describe("renderStagedDeposits", () => {
  it("renders pills from deposits", () => {
    const container = document.createElement("div");
    const deposits = [
      { manifest: { files: [{ deposited_as: "photo.jpg" }] } },
      { manifest: { files: [{ deposited_as: "a.txt" }, { deposited_as: "b.txt" }] } },
    ];
    renderStagedDeposits(deposits, { container, onRemove: vi.fn() });

    const pills = container.querySelectorAll(".staged-pill");
    expect(pills).toHaveLength(2);
    expect(pills[0].querySelector(".staged-name")!.textContent).toBe("photo.jpg");
    expect(pills[1].querySelector(".staged-name")!.textContent).toBe("a.txt +1");
  });

  it("calls onRemove with index when x button clicked", () => {
    const container = document.createElement("div");
    const onRemove = vi.fn();
    const deposits = [
      { manifest: { files: [{ deposited_as: "file.txt" }] } },
    ];
    renderStagedDeposits(deposits, { container, onRemove });

    (container.querySelector(".staged-x") as HTMLElement).click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("preserves error toasts across re-renders", () => {
    const container = document.createElement("div");
    const errorEl = document.createElement("div");
    errorEl.className = "staged-error";
    errorEl.textContent = "oops";
    container.appendChild(errorEl);

    renderStagedDeposits([], { container, onRemove: vi.fn() });
    expect(container.querySelector(".staged-error")!.textContent).toBe("oops");
  });
});
