import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RosterFeed, rosterChanged } from "./roster-feed.js";
import { RegistryWatcher, parseRegistryRecord, type RegistryRecord } from "./registry-watch.js";
import { buildSessionRoster, sseFrame } from "./bridge-logic.js";

const SEAT = "/home/x/.claude/sessions";

function rec(pid: number, over: Partial<RegistryRecord> = {}): RegistryRecord {
  const base = parseRegistryRecord(JSON.stringify({
    pid, sessionId: `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
    cwd: "/home/x/repos/acme/widgets", startedAt: 1789330156656, version: "2.1.283",
    kind: "interactive", entrypoint: "cli", tmux: "0:@37.%37", name: "claude-76",
    status: "idle", updatedAt: 1000, statusUpdatedAt: 1000, bridgeSessionId: null,
  }), SEAT, pid)!;
  return { ...base, ...over };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor: still false after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return Date.now() - t0;
}

describe("sseFrame — one framing for every SSE stream the bridge serves", () => {
  it("writes id, event and JSON data, terminated by a blank line", () => {
    expect(sseFrame(7, "sessions-changed", { pids: [42] }))
      .toBe('id: 7\nevent: sessions-changed\ndata: {"pids":[42]}\n\n');
  });
});

describe("rosterChanged — does this registry change alter what GET /sessions renders?", () => {
  it("a new record always counts (a session appeared)", () => {
    expect(rosterChanged(null, rec(1))).toBe(true);
  });
  it("idle → waiting counts: the transition the phone must never miss", () => {
    expect(rosterChanged(rec(1, { status: "idle", state: "idle" }), rec(1, { status: "waiting", state: "waiting" }))).toBe(true);
  });
  it("a write that only moves updatedAt does not count", () => {
    expect(rosterChanged(rec(1), rec(1, { updatedAt: 9999 }))).toBe(false);
  });
  it("a raw status change that maps to the same chip (idle → shell) does not count", () => {
    expect(rosterChanged(rec(1), rec(1, { status: "shell", state: "idle" }))).toBe(false);
  });

  // The binding test: the feed's notion of "changed" and the roster's actual output must
  // agree for every field a registry record carries. If buildSessionRoster starts reading
  // a new registry field, this fails until rosterChanged watches it too — never retyped.
  it("agrees with buildSessionRoster's output for a mutation of every record field", () => {
    const procs = [{ pid: 1, cwd: "/home/x/repos/acme/widgets", ageSec: 60 }];
    const roster = (r: RegistryRecord) => JSON.stringify(buildSessionRoster(
      procs, new Map(), new Map(), "/home/x/repos", "/home/x", [], new Map([[1, r]])));
    const base = rec(1);
    const mutations: Partial<RegistryRecord>[] = [
      { seatDir: "/home/x/.claude-commis/sessions", configDir: "/home/x/.claude-commis" },
      { sessionId: "11111111-1111-4111-8111-111111111111" },
      { status: "waiting", state: "waiting" },
      { status: "busy", state: "busy" },
      { status: null, state: "unknown" },
      { status: "shell", state: "idle" },
      { statusUpdatedAt: 2000 },
      { updatedAt: 2000 },
      { tmuxPane: "0:@1.%1" },
      { tmuxPane: null },
      { cwd: "/elsewhere" },
      { entrypoint: "sdk-cli" },
      { kind: "bg" },
      { name: "renamed" },
      { bridgeSessionId: "session_01ABC" },
      { version: "9.9.9" },
      { startedAt: 1 },
    ];
    // Every RegistryRecord key is exercised by at least one mutation.
    const covered = new Set(mutations.flatMap((m) => Object.keys(m)));
    for (const k of Object.keys(base)) if (k !== "pid") expect(covered, `no mutation for ${k}`).toContain(k);
    for (const m of mutations) {
      const next = { ...base, ...m };
      expect(rosterChanged(base, next), JSON.stringify(m)).toBe(roster(base) !== roster(next));
    }
  });
});

describe("RosterFeed — coalesces watcher events into one nudge", () => {
  let watcher: EventEmitter;
  let feed: RosterFeed;
  beforeEach(() => {
    watcher = new EventEmitter();
    feed = new RosterFeed({ coalesceMs: 40 });
    feed.attach(watcher);
  });
  afterEach(() => feed.stop());

  it("a relevant upsert emits `changed` once, carrying the pid", async () => {
    const got: number[][] = [];
    feed.on("changed", (e: { pids: number[] }) => got.push(e.pids));
    watcher.emit("upsert", rec(5, { status: "waiting", state: "waiting" }), rec(5));
    await waitFor(() => got.length === 1);
    expect(got).toEqual([[5]]);
  });

  it("a burst inside the window becomes ONE nudge with every pid, and never starves", async () => {
    const got: number[][] = [];
    feed.on("changed", (e: { pids: number[] }) => got.push(e.pids));
    watcher.emit("upsert", rec(1), null);
    watcher.emit("upsert", rec(2), null);
    watcher.emit("remove", rec(3));
    watcher.emit("upsert", rec(2), null);
    await waitFor(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(got.length).toBe(1);
    expect(got[0].sort()).toEqual([1, 2, 3]);
  });

  it("a steady run of writes cannot starve it: it fires within the window of the FIRST write (throttle, not debounce)", async () => {
    // coalesceMs is 40 here. Writes every 10 ms for 200 ms: a debounce would stay silent until
    // ~240 ms; the throttle must speak by ~40 ms and again while the run continues.
    const t0 = Date.now();
    const at: number[] = [];
    feed.on("changed", () => at.push(Date.now() - t0));
    for (let i = 0; i < 20; i++) {
      watcher.emit("upsert", rec(100 + i), null);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at[0]).toBeLessThan(120);
  });

  it("an irrelevant upsert (updatedAt only) emits nothing", async () => {
    let n = 0;
    feed.on("changed", () => n++);
    watcher.emit("upsert", rec(1, { updatedAt: 5 }), rec(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(0);
  });

  it("stop() detaches from the watcher and cancels a pending nudge", async () => {
    let n = 0;
    feed.on("changed", () => n++);
    watcher.emit("upsert", rec(1), null);
    feed.stop();
    watcher.emit("upsert", rec(2), null);
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(0);
    expect(watcher.listenerCount("upsert")).toBe(0);
    expect(watcher.listenerCount("remove")).toBe(0);
  });
});

/** Read SSE frames off a streaming fetch body until `until` returns true or `ms` passes. */
async function readFrames(res: Response, until: (frames: string[]) => boolean, ms = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: string[] = [];
  const deadline = Date.now() + ms;
  while (!until(frames)) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), left)),
    ]);
    if (!chunk || chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  reader.cancel().catch(() => {});
  return frames;
}

describe("RosterFeed over HTTP — the launcher's SSE stream", () => {
  let server: Server;
  let base: string;
  let watcher: EventEmitter;
  let feed: RosterFeed;

  beforeEach(async () => {
    watcher = new EventEmitter();
    feed = new RosterFeed({ coalesceMs: 20 });
    feed.attach(watcher);
    server = createServer((req, res) => feed.subscribe(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    feed.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("answers as an event stream and says hello first, so a buffering proxy flushes", async () => {
    const res = await fetch(`${base}/sessions/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const frames = await readFrames(res, (f) => f.length >= 1);
    expect(frames[0]).toMatch(/^id: 1\nevent: hello\ndata: \{"version":1\}$/);
  });

  it("a registry change reaches every open stream as sessions-changed", async () => {
    const a = await fetch(`${base}/sessions/events`);
    const b = await fetch(`${base}/sessions/events`);
    await waitFor(() => feed.clientCount === 2);
    watcher.emit("upsert", rec(9, { status: "waiting", state: "waiting" }), rec(9));
    const [fa, fb] = await Promise.all([
      readFrames(a, (f) => f.some((x) => x.includes("sessions-changed"))),
      readFrames(b, (f) => f.some((x) => x.includes("sessions-changed"))),
    ]);
    for (const frames of [fa, fb]) {
      const ev = frames.find((x) => x.includes("event: sessions-changed"))!;
      expect(ev).toBeDefined();
      expect(JSON.parse(ev.split("data: ")[1])).toEqual({ pids: [9] });
    }
  });

  it("ping() writes a ping to every stream; a closed stream is dropped", async () => {
    const a = await fetch(`${base}/sessions/events`);
    await waitFor(() => feed.clientCount === 1);
    feed.ping();
    const frames = await readFrames(a, (f) => f.some((x) => x.includes("event: ping")));
    expect(frames.some((x) => x.includes("event: ping"))).toBe(true);
    // readFrames cancelled the body — the server side sees the close.
    await waitFor(() => feed.clientCount === 0);
  });
});

describe("RosterFeed + a real RegistryWatcher — end to end on a fixture seat", () => {
  let root: string;
  let seat: string;
  let w: RegistryWatcher;
  let feed: RosterFeed;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gdn-roster-feed-"));
    seat = join(root, ".claude", "sessions");
    await mkdir(seat, { recursive: true });
  });
  afterEach(async () => {
    feed?.stop();
    w?.stop();
    await w?.settle();
    await rm(root, { recursive: true, force: true });
  });

  it("CC flipping a record to waiting produces a nudge in well under a second (inotify, not reconcile)", async () => {
    const body = (status: string, t: number) => JSON.stringify({
      pid: 4321, sessionId: "00000000-0000-4000-8000-000000004321", cwd: "/tmp", status,
      updatedAt: t, statusUpdatedAt: t, tmux: "0:@1.%1",
    });
    await writeFile(join(seat, "4321.json"), body("idle", 1000));
    w = new RegistryWatcher([seat], { reconcileMs: 60_000 });
    await w.start();
    feed = new RosterFeed({ coalesceMs: 50 });
    feed.attach(w);
    const got: number[][] = [];
    feed.on("changed", (e: { pids: number[] }) => got.push(e.pids));

    await writeFile(join(seat, "4321.json"), body("waiting", 2000));
    const ms = await waitFor(() => got.length > 0);
    expect(ms).toBeLessThan(1000);
    expect(got[0]).toEqual([4321]);
  });
});
