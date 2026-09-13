import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryWatcher, classifyStatus, parseRegistryRecord, defaultRegistryDirs,
  type RegistryRecord,
} from "./registry-watch.js";

// A record shaped like CC 2.1.270 writes it (fields measured 2026-09-08..13), minus the
// messaging socket path and the sibling `.key` secret this test never touches.
function record(pid: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid, sessionId: `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
    cwd: "/home/x/repos/acme/widgets", startedAt: 1789330156656, version: "2.1.270",
    kind: "interactive", entrypoint: "cli", tmux: "0:@37.%37", name: "claude-76",
    status: "idle", updatedAt: 1789333409871, statusUpdatedAt: 1789333409871,
    bridgeSessionId: null,
    ...over,
  });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor: still false after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
  return Date.now() - t0;
}

describe("classifyStatus — waiting is the value the phone must never miss", () => {
  it("maps CC's values onto the four-way chip", () => {
    expect(classifyStatus("waiting")).toBe("waiting");
    expect(classifyStatus("busy")).toBe("busy");
    expect(classifyStatus("idle")).toBe("idle");
  });
  it("treats any other written status as fine (idle), not as a fifth chip", () => {
    expect(classifyStatus("shell")).toBe("idle");        // seen 2026-09-13, unprobed
    expect(classifyStatus("something-new")).toBe("idle"); // whatever CC adds next
  });
  it("absent status is UNKNOWN, never idle — sdk-cli sessions write none", () => {
    expect(classifyStatus(undefined)).toBe("unknown");
    expect(classifyStatus(null)).toBe("unknown");
    expect(classifyStatus("")).toBe("unknown");
    expect(classifyStatus(42)).toBe("unknown");
  });
});

describe("parseRegistryRecord", () => {
  const seat = "/home/x/.claude-commis/sessions";
  it("reads the fields the roster and the ledger need, and names the seat from the dir", () => {
    const r = parseRegistryRecord(record(4242, { status: "waiting", bridgeSessionId: "session_01ABC" }), seat, 4242)!;
    expect(r).toMatchObject({
      pid: 4242, seatDir: seat, configDir: "/home/x/.claude-commis",
      sessionId: "00000000-0000-4000-8000-000000004242",
      status: "waiting", state: "waiting", statusUpdatedAt: 1789333409871, updatedAt: 1789333409871,
      tmuxPane: "0:@37.%37", cwd: "/home/x/repos/acme/widgets", entrypoint: "cli",
      kind: "interactive", name: "claude-76", bridgeSessionId: "session_01ABC", version: "2.1.270",
    });
  });
  it("an sdk-cli record with no status parses to unknown with a null raw status", () => {
    const r = parseRegistryRecord(record(7, { status: undefined, tmux: undefined, entrypoint: "sdk-cli" }), seat, 7)!;
    expect(r.status).toBeNull();
    expect(r.state).toBe("unknown");
    expect(r.tmuxPane).toBeNull();
    expect(r.entrypoint).toBe("sdk-cli");
  });
  it("falls back to the filename's pid when the body has none, and refuses junk", () => {
    expect(parseRegistryRecord(JSON.stringify({ status: "busy" }), seat, 99)?.pid).toBe(99);
    expect(parseRegistryRecord("{\"pid\": 12, \"status\": \"bu", seat, 12)).toBeNull(); // half-written
    expect(parseRegistryRecord("", seat, 12)).toBeNull();
    expect(parseRegistryRecord("[1,2]", seat, 12)).toBeNull();
    expect(parseRegistryRecord(JSON.stringify({ pid: 0 }), seat)).toBeNull();
    expect(parseRegistryRecord(JSON.stringify({ status: "idle" }), seat)).toBeNull(); // no pid anywhere
  });
});

describe("defaultRegistryDirs", () => {
  it("names both seats under the given home", () => {
    expect(defaultRegistryDirs("/home/x")).toEqual([
      "/home/x/.claude/sessions", "/home/x/.claude-commis/sessions",
    ]);
  });
});

describe("RegistryWatcher (inotify on fixture seat dirs)", () => {
  let root: string;
  let primary: string;
  let commis: string;
  let w: RegistryWatcher | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gdn-registry-"));
    primary = join(root, ".claude", "sessions");
    commis = join(root, ".claude-commis", "sessions");
    await mkdir(primary, { recursive: true });
    await mkdir(commis, { recursive: true });
  });

  afterEach(async () => {
    w?.stop();
    await w?.settle();
    w = null;
    await rm(root, { recursive: true, force: true });
  });

  it("loads existing records from both seats at start, one state per status incl. absent", async () => {
    await writeFile(join(primary, "100.json"), record(100, { status: "idle" }));
    await writeFile(join(primary, "101.json"), record(101, { status: "busy" }));
    await writeFile(join(commis, "200.json"), record(200, { status: "waiting" }));
    await writeFile(join(commis, "201.json"), record(201, { status: "shell", tmux: null }));
    await writeFile(join(commis, "202.json"), record(202, { status: undefined, tmux: undefined, entrypoint: "sdk-cli" }));
    // Neighbours that must never be opened or counted: the messaging secret and stray files.
    await writeFile(join(primary, "100.abcdef0123.key"), "SECRET");
    await writeFile(join(primary, "notes.txt"), "not a record");

    w = new RegistryWatcher([primary, commis], { reconcileMs: 60_000 });
    await w.start();

    const by = w.byPid();
    expect([...by.keys()].sort()).toEqual([100, 101, 200, 201, 202]);
    expect(by.get(100)).toMatchObject({ state: "idle", configDir: join(root, ".claude") });
    expect(by.get(101)).toMatchObject({ state: "busy" });
    expect(by.get(200)).toMatchObject({ state: "waiting", configDir: join(root, ".claude-commis") });
    expect(by.get(201)).toMatchObject({ state: "idle", status: "shell", tmuxPane: null });
    expect(by.get(202)).toMatchObject({ state: "unknown", status: null, entrypoint: "sdk-cli" });
  });

  it("a record appearing after start is seen within a second, via the watch not the reconcile", async () => {
    w = new RegistryWatcher([primary, commis], { reconcileMs: 60_000 });
    await w.start();
    const seen: RegistryRecord[] = [];
    w.on("upsert", (rec: RegistryRecord) => seen.push(rec));

    await writeFile(join(commis, "300.json"), record(300, { status: "waiting" }));
    const ms = await waitFor(() => seen.some((r) => r.pid === 300));
    expect(ms).toBeLessThan(1000);
    expect(w.byPid().get(300)).toMatchObject({ state: "waiting", seatDir: commis });
  });

  it("a status change emits upsert with the previous record, and the chip follows", async () => {
    await writeFile(join(primary, "400.json"), record(400, { status: "idle", updatedAt: 1000, statusUpdatedAt: 1000 }));
    w = new RegistryWatcher([primary], { reconcileMs: 60_000 });
    await w.start();
    const changes: Array<[RegistryRecord, RegistryRecord | null]> = [];
    w.on("upsert", (rec: RegistryRecord, prev: RegistryRecord | null) => changes.push([rec, prev]));

    await writeFile(join(primary, "400.json"), record(400, { status: "waiting", updatedAt: 2000, statusUpdatedAt: 2000 }));
    await waitFor(() => w!.byPid().get(400)?.state === "waiting");
    const [rec, prev] = changes.at(-1)!;
    expect(prev?.state).toBe("idle");
    expect(rec.state).toBe("waiting");
    expect(rec.statusUpdatedAt).toBe(2000);

    await writeFile(join(primary, "400.json"), record(400, { status: "idle", updatedAt: 3000, statusUpdatedAt: 3000 }));
    await waitFor(() => w!.byPid().get(400)?.state === "idle");
  });

  it("a vanishing record removes the row's live state and emits remove with the last record", async () => {
    await writeFile(join(primary, "500.json"), record(500, { status: "busy" }));
    w = new RegistryWatcher([primary], { reconcileMs: 60_000 });
    await w.start();
    expect(w.byPid().has(500)).toBe(true);
    const removed: RegistryRecord[] = [];
    w.on("remove", (rec: RegistryRecord) => removed.push(rec));

    await rm(join(primary, "500.json"));
    await waitFor(() => !w!.byPid().has(500));
    expect(removed.map((r) => r.pid)).toEqual([500]);
    expect(removed[0].state).toBe("busy"); // the ledger's ended_at row wants the last known state
  });

  it("a half-written file leaves the previous state in place until the write completes", async () => {
    await writeFile(join(primary, "600.json"), record(600, { status: "busy", updatedAt: 1 }));
    w = new RegistryWatcher([primary], { reconcileMs: 60_000 });
    await w.start();

    await writeFile(join(primary, "600.json"), "{\"pid\": 600, \"status\": \"wai");
    await new Promise((r) => setTimeout(r, 150));
    expect(w.byPid().get(600)?.state).toBe("busy");

    await writeFile(join(primary, "600.json"), record(600, { status: "waiting", updatedAt: 2 }));
    await waitFor(() => w!.byPid().get(600)?.state === "waiting");
  });

  it("an older updatedAt never overwrites a newer one (out-of-order reads)", async () => {
    await writeFile(join(primary, "700.json"), record(700, { status: "waiting", updatedAt: 5000, statusUpdatedAt: 5000 }));
    w = new RegistryWatcher([primary], { reconcileMs: 60_000 });
    await w.start();

    await writeFile(join(primary, "700.json"), record(700, { status: "idle", updatedAt: 4000, statusUpdatedAt: 4000 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(w.byPid().get(700)).toMatchObject({ state: "waiting", updatedAt: 5000 });
  });

  it("a seat directory that does not exist yet is reported missing, then picked up when it appears", async () => {
    const late = join(root, ".claude-late", "sessions");
    w = new RegistryWatcher([primary, late], { reconcileMs: 100 });
    const watchEvents: Array<[string, string]> = [];
    w.on("watch", (dir: string, status: string) => watchEvents.push([dir, status]));
    await w.start(); // must not throw
    expect(watchEvents).toContainEqual([primary, "armed"]);
    expect(watchEvents).toContainEqual([late, "missing"]);

    await mkdir(late, { recursive: true });
    await writeFile(join(late, "800.json"), record(800, { status: "busy" }));
    await waitFor(() => w!.byPid().has(800));
    expect(watchEvents).toContainEqual([late, "armed"]);
  });

  it("the reconcile pass sweeps a record whose delete event was missed", async () => {
    await writeFile(join(primary, "900.json"), record(900));
    w = new RegistryWatcher([primary], { reconcileMs: 100 });
    await w.start();
    expect(w.byPid().has(900)).toBe(true);
    // Simulate a lost inotify event by removing the file while the watch is closed.
    w.stop();
    await w.settle();
    await rm(join(primary, "900.json"));
    await w.start();
    expect(w.byPid().has(900)).toBe(false);
  });

  it("after stop(), no events fire", async () => {
    w = new RegistryWatcher([primary], { reconcileMs: 60_000 });
    await w.start();
    let fired = 0;
    w.on("upsert", () => fired++);
    w.stop();
    await writeFile(join(primary, "1000.json"), record(1000));
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(0);
    expect(w.byPid().has(1000)).toBe(false);
  });
});
