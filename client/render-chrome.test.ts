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

const { renderStatusBar, renderSwitcher, updatePlaceholder, updateSendButton } =
  require("./render-chrome.cjs" as string);

/** Create mock elements bag for renderStatusBar. */
function makeStatusEls() {
  return {
    project: document.createElement("span"),
    contextPct: document.createElement("span"),
    contextBtn: document.createElement("button"),
    connectionDot: document.createElement("span"),
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

// ============================================================
// renderSwitcher
// ============================================================
describe("renderSwitcher", () => {
  function makeSwitcherEls() {
    return {
      switcher: document.createElement("div"),
      list: document.createElement("div"),
      backdrop: document.createElement("div"),
      body: document.createElement("div"),
    };
  }

  const now = new Date().toISOString();
  const baseState = {
    session: { id: "sess-1" },
    switcher: {
      sessions: [
        { project: "alpha", id: "/alpha", status: "now", backendState: "active", context_pct: 40, humanSessionCount: 1, updated: now },
        { project: "beta", id: "/beta", status: "previous", backendState: "closed", context_pct: 80, humanSessionCount: 2, updated: now, sessions: [
          { id: "s1-full-uuid", humanInteraction: true, contextPct: 80, model: "claude-sonnet-4-5-20250514" },
          { id: "s2-full-uuid", humanInteraction: true, contextPct: 20, model: "claude-opus-4-6", closed: true },
        ] },
      ],
    },
  };

  it("hides when switcherOpen is false", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: false, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    expect(els.switcher.dataset.open).toBe("false");
  });

  it("shows items when open", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    expect(els.switcher.dataset.open).toBe("true");
    expect(els.list.querySelectorAll(".switcher-item").length).toBeGreaterThan(0);
  });

  it("calls onConnect when item clicked", () => {
    const els = makeSwitcherEls();
    const onConnect = vi.fn();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect, onExpand: vi.fn(),
    });
    const body = els.list.querySelector(".switcher-item-body") as HTMLElement;
    body.click();
    expect(onConnect).toHaveBeenCalled();
  });

  it("current folder appears first with data-current", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: "alpha", expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    const first = els.list.querySelector(".switcher-item") as HTMLElement;
    expect(first.dataset.current).toBe("true");
    expect(first.querySelector(".switcher-project")!.textContent).toBe("alpha");
  });

  it("filters by search string", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "alpha", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    const items = els.list.querySelectorAll(".switcher-item");
    expect(items.length).toBe(1);
    expect(items[0].querySelector(".switcher-project")!.textContent).toBe("alpha");
  });

  it("groups recently-active folders into Recent section", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    const sections = els.list.querySelectorAll(".switcher-section");
    // Both alpha and beta have recent timestamps, so one "Recent" section
    expect(sections.length).toBe(1);
    expect(sections[0].textContent).toBe("Recent");
  });

  it("puts old folders in Previous section", () => {
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
    const stateWithOld = {
      session: { id: "sess-1" },
      switcher: {
        sessions: [
          { project: "recent-proj", id: "/recent", status: "now", backendState: "active", context_pct: 40, humanSessionCount: 1, updated: now },
          { project: "old-proj", id: "/old", status: "previous", backendState: "closed", context_pct: 50, humanSessionCount: 3, updated: oldDate },
        ],
      },
    };
    const els = makeSwitcherEls();
    renderSwitcher(stateWithOld, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    const sections = els.list.querySelectorAll(".switcher-section");
    expect(sections.length).toBe(2);
    expect(sections[0].textContent).toBe("Recent");
    expect(sections[1].textContent).toBe("Previous");
  });

  it("paused folder always appears in Recent regardless of age", () => {
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const stateWithPaused = {
      session: { id: "sess-1" },
      switcher: {
        sessions: [
          { project: "paused-proj", id: "/paused", status: "now", backendState: "paused", context_pct: 60, humanSessionCount: 1, updated: oldDate },
        ],
      },
    };
    const els = makeSwitcherEls();
    renderSwitcher(stateWithPaused, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    const sections = els.list.querySelectorAll(".switcher-section");
    expect(sections.length).toBe(1);
    expect(sections[0].textContent).toBe("Recent");
  });

  it("shows create option when filter has no exact match", () => {
    const els = makeSwitcherEls();
    const onCreate = vi.fn();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "new-project", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate,
    });
    const create = els.list.querySelector(".switcher-create") as HTMLElement;
    expect(create).not.toBeNull();
    expect(create.textContent).toContain("new-project");
  });

  it("calls onCreate when create row clicked", () => {
    const els = makeSwitcherEls();
    const onCreate = vi.fn();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "my-app", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate,
    });
    const create = els.list.querySelector(".switcher-create") as HTMLElement;
    create.click();
    expect(onCreate).toHaveBeenCalledWith("my-app");
  });

  it("hides create when filter exactly matches an existing folder", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "alpha", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate: vi.fn(),
    });
    expect(els.list.querySelector(".switcher-create")).toBeNull();
  });

  it("hides create when filter has invalid characters", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "my project!", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate: vi.fn(),
    });
    expect(els.list.querySelector(".switcher-create")).toBeNull();
  });

  it("hides create when no onCreate callback provided", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "new-project", els, onConnect: vi.fn(), onExpand: vi.fn(),
    });
    expect(els.list.querySelector(".switcher-create")).toBeNull();
  });

  it("shows New Project button when no filter and onCreate provided", () => {
    const els = makeSwitcherEls();
    const onCreate = vi.fn();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate,
    });
    const create = els.list.querySelector(".switcher-create") as HTMLElement;
    expect(create).not.toBeNull();
    expect(create.textContent).toContain("New Project");
    create.click();
    expect(onCreate).toHaveBeenCalledWith("");
  });

  it("hides create when filter starts with hyphen", () => {
    const els = makeSwitcherEls();
    renderSwitcher(baseState, {
      switcherOpen: true, currentFolder: null, expandedFolder: null,
      filter: "-bad-name", els, onConnect: vi.fn(), onExpand: vi.fn(), onCreate: vi.fn(),
    });
    expect(els.list.querySelector(".switcher-create")).toBeNull();
  });
});
