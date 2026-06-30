// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load dependencies in order
require("./render-utils.cjs");
(globalThis as any).marked = { parse: (s: string) => s, parseInline: (s: string) => s };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});
require("./render-chips.cjs");
require("./render-messages.cjs");

const { renderStatusBar, updatePlaceholder, updateSendButton } =
  require("./render-chrome.cjs" as string);

/** Create mock elements bag for renderStatusBar. */
function makeStatusEls() {
  return {
    project: document.createElement("span"),
    contextPct: document.createElement("span"),
    contextBtn: document.createElement("button"),
    body: document.createElement("div"), // stand-in for document.body
  };
}

// ============================================================
// renderStatusBar
// ============================================================
describe("renderStatusBar", () => {
  it("sets project name", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: { project: "myapp" }, connection: "connected", status: "idle" }, els);
    expect(els.project.textContent).toBe("myapp");
  });

  it("sets context percentage and level", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: { project: "x", context_pct: 90 }, connection: "connected", status: "idle" }, els);
    expect(els.contextPct.textContent).toBe("90%");
    expect(els.contextBtn.dataset.level).toBe("critical");
  });

  it("sets low level at 70%", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: { project: "x", context_pct: 72 }, connection: "connected", status: "idle" }, els);
    expect(els.contextBtn.dataset.level).toBe("low");
  });

  it("sets empty level below 70%", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: { project: "x", context_pct: 50 }, connection: "connected", status: "idle" }, els);
    expect(els.contextBtn.dataset.level).toBe("");
  });

  it("shows 0% when project exists but no pct", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: { project: "x" }, connection: "connected", status: "idle" }, els);
    expect(els.contextPct.textContent).toBe("0%");
  });

  it("sets connection state on body", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: {}, connection: "disconnected", status: "idle" }, els);
    expect(els.body.dataset.connection).toBe("disconnected");
  });

  it("sets busy state when connected and working", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: {}, connection: "connected", status: "working" }, els);
    expect(els.body.dataset.busy).toBe("true");
  });

  it("not busy when disconnected even if working", () => {
    const els = makeStatusEls();
    renderStatusBar({ session: {}, connection: "disconnected", status: "working" }, els);
    expect(els.body.dataset.busy).toBe("false");
  });

  it("handles missing session gracefully", () => {
    const els = makeStatusEls();
    renderStatusBar({ connection: "disconnected", status: "idle" }, els);
    expect(els.project.textContent).toBe("");
    expect(els.contextPct.textContent).toBe("");
  });
});

// ============================================================
// updatePlaceholder
// ============================================================
describe("updatePlaceholder", () => {
  it("shows 'Choose a folder' when no folder", () => {
    const ta = document.createElement("textarea") as HTMLTextAreaElement;
    updatePlaceholder(ta, { currentFolder: null, connection: "connected", status: "idle", activity: null, model: null });
    expect(ta.placeholder).toContain("Choose a folder");
  });

  it("shows 'Reconnecting' when disconnected", () => {
    const ta = document.createElement("textarea") as HTMLTextAreaElement;
    updatePlaceholder(ta, { currentFolder: "proj", connection: "disconnected", status: "idle", activity: null, model: null });
    expect(ta.placeholder).toContain("Reconnecting");
  });

  it("shows 'Claude is thinking' when working", () => {
    const ta = document.createElement("textarea") as HTMLTextAreaElement;
    updatePlaceholder(ta, { currentFolder: "proj", connection: "connected", status: "working", activity: null, model: null });
    expect(ta.placeholder).toContain("thinking");
  });

  it("shows 'Claude is writing' for writing activity", () => {
    const ta = document.createElement("textarea") as HTMLTextAreaElement;
    updatePlaceholder(ta, { currentFolder: "proj", connection: "connected", status: "working", activity: "writing", model: null });
    expect(ta.placeholder).toContain("writing");
  });

  it("shows model name when idle", () => {
    const ta = document.createElement("textarea") as HTMLTextAreaElement;
    updatePlaceholder(ta, { currentFolder: "proj", connection: "connected", status: "idle", activity: null, model: "claude-sonnet-4-5-20250514" });
    expect(ta.placeholder).toContain("sonnet-4-5");
  });
});

// ============================================================
// updateSendButton
// ============================================================
describe("updateSendButton", () => {
  it("shows stop icon when busy with no content", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: false, hasDeposits: false, isDisconnected: false, isBusy: true, isLive: true });
    expect(btn.dataset.stop).toBe("true");
  });

  it("shows send when has text", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: true, hasDeposits: false, isDisconnected: false, isBusy: false, isLive: true });
    expect(btn.dataset.active).toBe("true");
    expect(btn.dataset.stop).toBe("false");
  });

  it("active when has deposits but no text", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: false, hasDeposits: true, isDisconnected: false, isBusy: false, isLive: true });
    expect(btn.dataset.active).toBe("true");
  });

  it("disabled when disconnected and not live", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: true, hasDeposits: false, isDisconnected: true, isBusy: false, isLive: false });
    expect(btn.dataset.active).toBe("false");
  });

  it("allows send when disconnected but live", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: true, hasDeposits: false, isDisconnected: true, isBusy: false, isLive: true });
    expect(btn.dataset.active).toBe("true");
  });

  it("send overrides stop when busy with content", () => {
    const btn = document.createElement("button");
    updateSendButton(btn, { hasText: true, hasDeposits: false, isDisconnected: false, isBusy: true, isLive: true });
    expect(btn.dataset.stop).toBe("false");
    expect(btn.dataset.active).toBe("true");
  });
});

