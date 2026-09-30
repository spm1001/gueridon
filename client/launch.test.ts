/**
 * The launcher page's live roster (gdn-jojino): the session list rides an SSE stream
 * (GET /sessions/events) and refetches GET /sessions on each nudge, instead of waiting
 * for the 20 s poll. Loads the real launch.html into jsdom with fetch and EventSource
 * faked, so what is tested is the page as shipped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// jsdom ships no type declarations and this repo carries no @types/jsdom; require keeps tsc quiet.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
type JSDOM = { window: Window & typeof globalThis };

const HTML = readFileSync(join(fileURLToPath(import.meta.url), "../../launch.html"), "utf-8");

type Listener = (ev: { type: string; data?: string }) => void;

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string, private registry: FakeEventSource[]) { registry.push(this); }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.readyState = FakeEventSource.CLOSED; }
  // -- test drivers --
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.({ type: "open" }); }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, data: JSON.stringify(data) });
  }
  fail(fatal: boolean) {
    this.readyState = fatal ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.({ type: "error" });
  }
}

const row = (pid: number, state: string) => ({
  pid, name: "acme/widgets", cwd: "/r/acme/widgets", ageSec: 90, kind: "local",
  attachable: false, wallet: "sameer@", state, stateSince: Date.now() - 3000,
});

interface Harness {
  dom: JSDOM;
  sources: FakeEventSource[];
  fetches: string[];
  /** What GET /sessions answers next; a function may return a pending promise. */
  sessions: () => unknown;
  /** HTTP status GET /sessions answers with (404 = neither roster flag set on the bridge). */
  sessionsStatus: number;
  intervals: Map<number, number>; // live interval id → delay
  timeouts: Map<number, { fn: () => void; ms: number }>; // pending timeouts
  /** Request bodies of non-GET fetches, by url. */
  bodies: Map<string, string>;
  /** Canned answers for other urls: [status, body]. */
  answers: Map<string, [number, unknown]>;
}

function load(): Harness {
  const h = { sources: [], fetches: [], sessions: () => ({ sessions: [] }), sessionsStatus: 200, intervals: new Map(), timeouts: new Map(), bodies: new Map(), answers: new Map() } as unknown as Harness;
  h.dom = new JSDOM(HTML, {
    url: "http://localhost/launch.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window: Window & typeof globalThis) {
      const w = window as unknown as Record<string, unknown>;
      w.EventSource = class extends FakeEventSource {
        constructor(url: string) { super(url, h.sources); }
      };
      w.fetch = async (url: string, opts?: { signal?: AbortSignal; body?: string }) => {
        h.fetches.push(url);
        if (opts?.body !== undefined) h.bodies.set(url, opts.body);
        const canned = h.answers.get(url);
        if (canned) return { ok: canned[0] === 200, status: canned[0], json: async () => canned[1] };
        if (url === "/sessions") {
          // Honour the page's abort signal, as a real fetch does, so a hung answer can time out.
          const aborted = new Promise((_, reject) => opts?.signal?.addEventListener("abort",
            () => reject(new Error("AbortError"))));
          const body = await Promise.race([Promise.resolve(h.sessions()), aborted]);
          const status = h.sessionsStatus;
          return { ok: status === 200, status, json: async () => body };
        }
        const body = url === "/repos" ? { repos: [] } : url === "/recent" ? { sessions: [] } : {};
        return { ok: true, status: 200, json: async () => body };
      };
      const realSet = window.setInterval.bind(window);
      const realClear = window.clearInterval.bind(window);
      w.setInterval = (fn: () => void, ms: number) => {
        const id = realSet(fn, ms) as unknown as number;
        h.intervals.set(id, ms);
        return id;
      };
      w.clearInterval = (id: number) => { h.intervals.delete(id); realClear(id); };
      // Long timeouts (reconnect, watchdog) are recorded, not armed, so a test can fire
      // them without waiting; short ones (the End button's 1.2 s refresh aside) run for real.
      const realSetT = window.setTimeout.bind(window);
      const realClearT = window.clearTimeout.bind(window);
      let fakeId = 1_000_000;
      w.setTimeout = (fn: () => void, ms = 0) => {
        if (ms < 1000) return realSetT(fn, ms);
        const id = fakeId++;
        h.timeouts.set(id, { fn, ms });
        return id;
      };
      w.clearTimeout = (id: number) => { if (!h.timeouts.delete(id)) realClearT(id); };
    },
  });
  return h;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Transport up, then the bridge's hello — the point the page counts the stream as live. */
async function up(es: FakeEventSource) { es.open(); es.emit("hello", { version: 1 }); await tick(); }
/** Pending long timers with a delay above `min` ms, as [id, ms]. */
const pendingOver = (h: Harness, min: number) => [...h.timeouts.entries()].filter(([, t]) => t.ms > min).map(([id, t]) => [id, t.ms]);
function fireTimer(h: Harness, id: number) { const t = h.timeouts.get(id)!; h.timeouts.delete(id); t.fn(); }
const sessionFetches = (h: Harness) => h.fetches.filter((u) => u === "/sessions").length;
const liveDelays = (h: Harness) => [...h.intervals.values()].sort();

function setVisibility(h: Harness, state: "visible" | "hidden") {
  const doc = h.dom.window.document;
  Object.defineProperty(doc, "visibilityState", { value: state, configurable: true });
  doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
}

describe("launcher roster over SSE (gdn-jojino)", () => {
  let h: Harness;
  beforeEach(async () => { h = load(); await tick(); });
  afterEach(() => h.dom.window.close());

  it("opens one stream on /sessions/events at load", () => {
    expect(h.sources.map((s) => s.url)).toEqual(["/sessions/events"]);
  });

  it("a sessions-changed nudge refetches /sessions and the waiting row turns amber", async () => {
    const es = h.sources[0];
    es.open();
    await tick();
    const before = sessionFetches(h);
    h.sessions = () => ({ sessions: [row(42, "waiting")] });
    es.emit("sessions-changed", { pids: [42] });
    await tick();
    expect(sessionFetches(h)).toBe(before + 1);
    const chip = h.dom.window.document.querySelector(".schip.waiting");
    expect(chip).not.toBeNull();
    expect(chip!.closest(".run-row")!.classList.contains("waiting")).toBe(true);
  });

  it("a ping keeps the stream alive without a refetch", async () => {
    const es = h.sources[0];
    es.open();
    await tick();
    const before = sessionFetches(h);
    es.emit("ping", {});
    await tick();
    expect(sessionFetches(h)).toBe(before);
  });

  it("nudges that land while a fetch is in flight collapse into ONE trailing refetch", async () => {
    const es = h.sources[0];
    es.open();
    await tick();
    let release!: () => void;
    h.sessions = () => new Promise((r) => { release = () => r({ sessions: [row(1, "busy")] }); });
    const before = sessionFetches(h);
    es.emit("sessions-changed", { pids: [1] });
    await tick();
    expect(sessionFetches(h)).toBe(before + 1); // in flight
    es.emit("sessions-changed", { pids: [1] });
    es.emit("sessions-changed", { pids: [2] });
    es.emit("sessions-changed", { pids: [3] });
    await tick();
    expect(sessionFetches(h)).toBe(before + 1); // still just the one
    h.sessions = () => ({ sessions: [row(1, "waiting")] });
    release();
    await tick(10);
    expect(sessionFetches(h)).toBe(before + 2); // one trailing refetch, not three
    expect(h.dom.window.document.querySelector(".schip.waiting")).not.toBeNull();
  });

  it("keeps the 20 s poll whether or not the stream is up: a silently dead stream is never worse than the old page", async () => {
    const es = h.sources[0];
    expect(liveDelays(h)).toEqual([20000]);
    await up(es);
    expect(liveDelays(h)).toEqual([20000]);
    es.fail(false); // transport blip; EventSource is retrying by itself
    await tick();
    expect(liveDelays(h)).toEqual([20000]);
  });

  it("the hello, not the headers, triggers the catch-up refetch", async () => {
    const es = h.sources[0];
    const before = sessionFetches(h);
    es.open(); // a proxy passed the headers and is sitting on the body
    await tick();
    expect(sessionFetches(h)).toBe(before);
    es.emit("hello", { version: 1 });
    await tick();
    expect(sessionFetches(h)).toBe(before + 1);
  });

  it("the watchdog outlasts two ping intervals, a ping re-arms it, and silence reopens the stream", async () => {
    const es = h.sources[0];
    await up(es);
    const before = pendingOver(h, 30000);
    expect(before.length).toBe(1);
    expect(before[0][1]).toBeGreaterThan(60000); // pings come every 30 s
    es.emit("ping", {});
    const after = pendingOver(h, 30000);
    expect(after.length).toBe(1);
    expect(after[0][0]).not.toBe(before[0][0]); // re-armed, not the same timer
    fireTimer(h, after[0][0] as number); // 65 s of silence
    expect(h.sources.length).toBe(2);
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("a roster that is off (both endpoints 404) is not retried", async () => {
    h.dom.window.close();
    h = load();
    h.sessionsStatus = 404;
    await tick();
    h.sources[0].fail(true);
    await tick();
    expect(pendingOver(h, 1000)).toEqual([]);
  });

  it("an answer that keeps not being a stream is retried with a doubling delay", async () => {
    h.sources[0].fail(true);
    await tick();
    const [first] = pendingOver(h, 1000);
    expect(first[1]).toBe(10000);
    fireTimer(h, first[0] as number);
    h.sources[1].fail(true);
    await tick();
    const [second] = pendingOver(h, 1000);
    expect(second[1]).toBe(20000);
  });

  it("a hung /sessions fetch is abandoned, so the nudges queued behind it still refetch", async () => {
    const es = h.sources[0];
    await up(es);
    h.sessions = () => new Promise(() => {}); // never answers
    const before = sessionFetches(h);
    es.emit("sessions-changed", { pids: [1] });
    await tick();
    es.emit("sessions-changed", { pids: [2] });
    await tick();
    expect(sessionFetches(h)).toBe(before + 1);
    h.sessions = () => ({ sessions: [row(2, "waiting")] });
    const abort = [...h.timeouts.entries()].find(([, t]) => t.ms === 15000);
    expect(abort).toBeDefined();
    fireTimer(h, abort![0]);
    await tick(10);
    expect(sessionFetches(h)).toBe(before + 2);
    expect(h.dom.window.document.querySelector(".schip.waiting")).not.toBeNull();
  });

  it("an End armed to \"Sure?\" survives a redraw between the two taps", async () => {
    const es = h.sources[0];
    h.sessions = () => ({ sessions: [row(42, "idle")] });
    await up(es);
    const endBtn = () => h.dom.window.document.querySelector(".run-row .end") as HTMLButtonElement;
    endBtn().click();
    expect(endBtn().textContent).toBe("Sure?");
    h.sessions = () => ({ sessions: [row(42, "busy")] }); // a nudge that changes the row
    const drawn = endBtn();
    es.emit("sessions-changed", { pids: [42] });
    await tick();
    expect(endBtn()).not.toBe(drawn); // it really was redrawn
    expect(endBtn().textContent).toBe("Sure?");
    endBtn().click();
    await tick();
    expect(h.fetches).toContain("/session/42");
  });

  it("a nudge that changes nothing visible does not redraw the roster", async () => {
    const es = h.sources[0];
    h.sessions = () => ({ sessions: [row(7, "idle")] });
    await up(es);
    const drawn = h.dom.window.document.querySelector(".run-row");
    es.emit("sessions-changed", { pids: [7] });
    await tick();
    expect(h.dom.window.document.querySelector(".run-row")).toBe(drawn);
  });

  it("a hidden tab closes the stream and stops polling; coming back reopens and refetches", async () => {
    const es = h.sources[0];
    es.open();
    await tick();
    setVisibility(h, "hidden");
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    expect(liveDelays(h)).toEqual([]);
    const before = sessionFetches(h);
    setVisibility(h, "visible");
    await tick();
    expect(h.sources.length).toBe(2);
    expect(h.sources[1].url).toBe("/sessions/events");
    expect(sessionFetches(h)).toBeGreaterThan(before);
  });

  it("a stream the browser gave up on (fatal error) is retried, not abandoned", async () => {
    const es = h.sources[0];
    es.fail(true);
    await tick();
    expect(liveDelays(h)).toEqual([20000]); // the poll carries the roster meanwhile
    // The page schedules its own reconnect; fire the pending long timers instead of waiting.
    const pending = [...h.timeouts.entries()];
    expect(pending.length).toBeGreaterThan(0);
    for (const [id, t] of pending) { h.timeouts.delete(id); t.fn(); }
    expect(h.sources.length).toBe(2);
    expect(h.sources[1].url).toBe("/sessions/events");
  });
});

describe("Take a terminal conversation (gdn-tamose)", () => {
  let h: Harness;
  const UUID = "a168195a-5875-4dab-846c-181282d6fdc7";
  beforeEach(() => { h = load(); });
  afterEach(() => h.dom.window.close());
  const takeButtons = () => [...h.dom.window.document.querySelectorAll(".run-row .take")] as HTMLButtonElement[];

  it("offers Take only on terminal rows that name their conversation and have a known state", async () => {
    h.sessions = () => ({ sessions: [
      { ...row(1, "idle"), sessionUuid: UUID },
      { ...row(2, "busy"), kind: "vertex-terminal", sessionUuid: UUID },
      { ...row(3, "idle") },                                        // no uuid
      { ...row(4, "unknown"), sessionUuid: UUID },                  // no status to wait on
      { ...row(5, "idle"), kind: "remote", sessionUuid: UUID },     // a phone child
    ] });
    await up(h.sources[0]);
    expect(takeButtons()).toHaveLength(2);
  });

  it("tapping Take posts the pid and conversation, then opens the conversation page on the taken id", async () => {
    h.sessions = () => ({ sessions: [{ ...row(42, "idle"), sessionUuid: UUID }] });
    h.answers.set("/take", [200, { folder: "acme/widgets", sessionId: UUID, waitedMs: 0 }]);
    await up(h.sources[0]);
    takeButtons()[0].click();
    await tick(); await tick();
    expect(JSON.parse(h.bodies.get("/take")!)).toEqual({ pid: 42, sessionId: UUID });
    expect(JSON.parse(h.dom.window.sessionStorage.getItem("gdnTakenSession")!)).toEqual({ folder: "acme/widgets", sessionId: UUID });
  });

  it("a refused take says why on the page and stores nothing", async () => {
    h.sessions = () => ({ sessions: [{ ...row(42, "busy"), sessionUuid: UUID }] });
    h.answers.set("/take", [409, { error: "still not idle", state: "busy" }]);
    await up(h.sources[0]);
    takeButtons()[0].click();
    await tick(); await tick();
    expect(h.dom.window.document.getElementById("note")!.textContent).toContain("still not idle");
    expect(h.dom.window.sessionStorage.getItem("gdnTakenSession")).toBeNull();
  });
});
