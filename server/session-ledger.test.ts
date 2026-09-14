import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryWatcher, parseRegistryRecord, type RegistryRecord } from "./registry-watch.js";
import { teleportSessionUuid } from "./sessions.js";
import {
  SessionLedger, foldLedger, parseLedgerQuery, ledgerKey, defaultLedgerPath,
  type LedgerLine, type LedgerProblem,
} from "./session-ledger.js";

// ---- fixtures ----

const HOME = "/home/x";
const PRIMARY = join(HOME, ".claude", "sessions");
const COMMIS = join(HOME, ".claude-commis", "sessions");
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TELEPORT_BODY = "01PWHuGQTxpFk8jSEMiDpZxy";
const TELEPORT = "session_" + TELEPORT_BODY;
const PHONE_UUID = teleportSessionUuid("cse_" + TELEPORT_BODY);

/** A parsed record shaped like CC 2.1.270 writes it, minus the messaging socket path. */
function rec(pid: number, seatDir: string, over: Record<string, unknown> = {}): RegistryRecord {
  const text = JSON.stringify({
    pid, sessionId: UUID_A, cwd: "/home/x/repos/acme/widgets", startedAt: 1_789_330_000_000,
    version: "2.1.270", kind: "interactive", entrypoint: "cli", tmux: "0:@37.%37", name: "claude-76",
    status: "idle", updatedAt: 1_789_333_000_000, statusUpdatedAt: 1_789_333_000_000, bridgeSessionId: null,
    ...over,
  });
  return parseRegistryRecord(text, seatDir, pid)!;
}

/** Stands in for RegistryWatcher: same two events, same snapshot(). */
class FakeSource extends EventEmitter {
  live: RegistryRecord[] = [];
  snapshot(): RegistryRecord[] { return [...this.live]; }
  upsert(r: RegistryRecord, prev: RegistryRecord | null = null): void {
    this.live = this.live.filter((x) => x.pid !== r.pid || x.seatDir !== r.seatDir).concat(r);
    this.emit("upsert", r, prev);
  }
  remove(r: RegistryRecord): void {
    this.live = this.live.filter((x) => x.pid !== r.pid || x.seatDir !== r.seatDir);
    this.emit("remove", r);
  }
}

async function lines(path: string): Promise<LedgerLine[]> {
  const text = await readFile(path, "utf-8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
}

// A little settling room for the async upsert handler (one awaited resolver per event).
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("session ledger (gdn-daluto)", () => {
  let root: string;
  let path: string;
  let clock: number;
  const now = () => clock;
  let vertexTable: Map<number, boolean | null>;
  // `has` not `??`: a table entry of null must reach the ledger as null (unreadable /proc).
  const vertexFor = async (pid: number) => (vertexTable.has(pid) ? vertexTable.get(pid)! : false);
  let problems: LedgerProblem[];

  let deadPids: Set<number>;
  const alive = (pid: number) => !deadPids.has(pid);
  function ledger(): SessionLedger {
    return new SessionLedger({ path, vertexBilledForPid: vertexFor, pidAlive: alive, now, onProblem: (p) => problems.push(p) });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gdn-ledger-"));
    path = join(root, "state", "session-ledger.jsonl"); // parent dir does not exist yet — append must mkdir
    clock = 1_789_333_100_000;
    vertexTable = new Map();
    deadPids = new Set();
    problems = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("record appears → one row, keyed on (sessionId, seat), seat from the directory, wallet from /proc", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    vertexTable.set(4242, true);
    src.upsert(rec(4242, COMMIS, { bridgeSessionId: TELEPORT, entrypoint: "sdk-cli", tmux: undefined }));
    await tick(); await L.flush();

    const row = L.latestForSession(UUID_A)!;
    expect(row).toMatchObject({
      sessionId: UUID_A, seatDir: COMMIS, configDir: join(HOME, ".claude-commis"),
      seat: "family@", wallet: "vertex", vertexBilled: true,
      pid: 4242, pids: [4242], bridgeSessionId: TELEPORT, entrypoint: "sdk-cli", tmuxPane: null,
      cwd: "/home/x/repos/acme/widgets", kind: "interactive", name: "claude-76",
      ended_at: null, ended_reason: null,
    });
    expect(row.first_seen).toBe(1_789_330_000_000); // CC's own startedAt, earlier than the bridge saw it
    expect(row.last_seen).toBe(clock);
    const file = await lines(path);
    expect(file.map((l) => l.event)).toEqual(["open"]);
    expect(file[0]).toMatchObject({ sessionId: UUID_A, seatDir: COMMIS, wallet: "vertex" });
  });

  it("record vanishes → ended_at set with the reason, row KEPT with its identity intact", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    const r = rec(500, PRIMARY, { bridgeSessionId: TELEPORT, status: "busy" });
    src.upsert(r);
    await tick();
    clock += 60_000;
    src.remove(r);
    await L.flush();

    const row = L.latestForSession(UUID_A)!;
    expect(row.ended_at).toBe(clock);
    expect(row.ended_reason).toBe("record-removed");
    expect(row.lastStatus).toBe("busy");
    expect(row).toMatchObject({ seat: "sameer@", bridgeSessionId: TELEPORT, pid: 500 });
    expect((await lines(path)).map((l) => l.event)).toEqual(["open", "end"]);
    // The three questions still answer after death.
    const q = L.lookup(UUID_A);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].seat).toBe("sameer@");
    expect(q.teleport).toBe(TELEPORT);
    expect(q.live).toEqual([]);
  });

  it("same sessionId under two seat directories → two rows, never merged", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    src.upsert(rec(100, PRIMARY));
    src.upsert(rec(200, COMMIS));
    await tick(); await L.flush();

    const rows = L.rowsForSession(UUID_A);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seat).sort()).toEqual(["family@", "sameer@"]);
    expect(L.lookup(UUID_A).live.map((l) => l.pid).sort()).toEqual([100, 200]);
    // Ending one seat's record leaves the other's row open.
    src.remove(rec(100, PRIMARY));
    await L.flush();
    const after = L.lookup(UUID_A);
    expect(after.live.map((l) => l.pid)).toEqual([200]);
    expect(after.rows.find((r) => r.seat === "sameer@")!.ended_reason).toBe("record-removed");
  });

  it("pid reuse never merges sessions: remove then a new session on the same pid → two rows", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    const a = rec(777, PRIMARY, { sessionId: UUID_A });
    src.upsert(a);
    await tick();
    src.remove(a);
    src.upsert(rec(777, PRIMARY, { sessionId: UUID_B }));
    await tick(); await L.flush();

    expect(L.latestForSession(UUID_A)!.ended_reason).toBe("record-removed");
    expect(L.latestForSession(UUID_B)!.ended_at).toBeNull();
    expect(L.latestForSession(UUID_B)!.pids).toEqual([777]);
    expect(L.all()).toHaveLength(2);
  });

  it("pid reuse without a remove (a /clear, or a missed inotify delete) ends the old row and opens the new", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    const a = rec(778, PRIMARY, { sessionId: UUID_A });
    src.upsert(a);
    await tick();
    clock += 1000;
    src.upsert(rec(778, PRIMARY, { sessionId: UUID_B }), a); // prev names the old session
    await tick(); await L.flush();

    const oldRow = L.latestForSession(UUID_A)!;
    expect(oldRow.ended_reason).toBe("session-changed");
    expect(oldRow.ended_at).toBe(clock);
    expect(L.latestForSession(UUID_B)!.ended_at).toBeNull();
    expect((await lines(path)).map((l) => [l.event, l.sessionId])).toEqual([
      ["open", UUID_A], ["end", UUID_A], ["open", UUID_B],
    ]);
  });

  it("a resume under a new pid on the same seat keeps ONE row, appends its pid, and re-reads the wallet", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    const first = rec(900, PRIMARY);
    src.upsert(first);
    await tick();
    src.remove(first);
    await L.flush();
    expect(L.latestForSession(UUID_A)!.ended_at).not.toBeNull();

    clock += 5_000;
    vertexTable.set(901, true); // resumed via claudev this time
    src.upsert(rec(901, PRIMARY));
    await tick(); await L.flush();

    const rows = L.rowsForSession(UUID_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 901, pids: [900, 901], ended_at: null, wallet: "vertex" });
    expect((await lines(path)).map((l) => l.event)).toEqual(["open", "end", "reopen"]);
  });

  it("a late remove from the OLD pid does not close the row the new pid now holds", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    const old = rec(910, PRIMARY);
    src.upsert(old);
    await tick();
    src.upsert(rec(911, PRIMARY)); // resumed elsewhere before the old record's delete arrived
    await tick();
    src.remove(old);
    await L.flush();
    expect(L.latestForSession(UUID_A)).toMatchObject({ pid: 911, ended_at: null });
  });

  it("status flips update last_seen in memory only — no line per turn", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    src.upsert(rec(1000, PRIMARY, { status: "idle", updatedAt: 1 }));
    await tick();
    for (const [i, s] of ["busy", "idle", "waiting", "idle", "busy"].entries()) {
      clock += 1000;
      src.upsert(rec(1000, PRIMARY, { status: s, updatedAt: 2 + i, statusUpdatedAt: 2 + i }));
      await tick();
    }
    await L.flush();
    expect((await lines(path)).map((l) => l.event)).toEqual(["open"]);
    expect(L.latestForSession(UUID_A)).toMatchObject({ last_seen: clock, lastStatus: "busy" });
  });

  it("an identity change (bridgeSessionId arriving, tmux pane, cwd) appends an update", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    src.upsert(rec(1100, COMMIS, { bridgeSessionId: null }));
    await tick();
    src.upsert(rec(1100, COMMIS, { bridgeSessionId: TELEPORT }));
    await tick(); await L.flush();
    expect((await lines(path)).map((l) => [l.event, l.bridgeSessionId])).toEqual([["open", null], ["update", TELEPORT]]);
  });

  it("a record with no sessionId is not journaled (nothing to key on)", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    src.upsert(rec(1200, PRIMARY, { sessionId: undefined }));
    await tick(); await L.flush();
    expect(L.all()).toEqual([]);
    expect(await lines(path)).toEqual([]);
  });

  describe("boot backfill", () => {
    it("preserves first_seen for a row whose record is still present, and closes absent ones as absent-at-boot", async () => {
      // A previous bridge left three rows: K1 still running, K2 gone while we were down, K3 already ended.
      const earlier = clock - 3_600_000;
      const src0 = new FakeSource();
      const L0 = new SessionLedger({ path, vertexBilledForPid: vertexFor, now: () => earlier, onProblem: (p) => problems.push(p) });
      await L0.start(src0);
      src0.upsert(rec(11, PRIMARY, { sessionId: UUID_A }));
      src0.upsert(rec(22, COMMIS, { sessionId: UUID_B }));
      const k3 = rec(33, PRIMARY, { sessionId: UUID_B });
      src0.upsert(k3);
      await tick();
      src0.remove(k3);
      await L0.flush();
      const before = (await lines(path)).length;

      // New bridge: only K1's record exists now (same pid).
      const src = new FakeSource();
      src.live = [rec(11, PRIMARY, { sessionId: UUID_A })];
      const L = ledger();
      const summary = await L.start(src);

      expect(summary).toEqual({ rows: 3, open: 1, endedAtBoot: 1 });
      const k1 = L.rowsForSession(UUID_A)[0];
      expect(k1).toMatchObject({ pid: 11, ended_at: null });
      expect(k1.first_seen).toBe(earlier); // the earlier bridge's sighting survives the boot
      const k2 = L.rowsForSession(UUID_B).find((r) => r.seatDir === COMMIS)!;
      expect(k2).toMatchObject({ ended_at: clock, ended_reason: "absent-at-boot" });
      const k3row = L.rowsForSession(UUID_B).find((r) => r.seatDir === PRIMARY)!;
      expect(k3row.ended_reason).toBe("record-removed"); // untouched
      const after = await lines(path);
      expect(after.length - before).toBe(1); // exactly the one end line
      expect(after.at(-1)).toMatchObject({ event: "end", sessionId: UUID_B, seatDir: COMMIS, ended_reason: "absent-at-boot" });
    });

    it("a record present at boot under a NEW pid moves the row on and re-reads the wallet", async () => {
      const src0 = new FakeSource();
      const L0 = ledger();
      await L0.start(src0);
      src0.upsert(rec(44, PRIMARY));
      await tick(); await L0.flush();

      vertexTable.set(45, true);
      const src = new FakeSource();
      src.live = [rec(45, PRIMARY)];
      const L = ledger();
      await L.start(src);
      expect(L.latestForSession(UUID_A)).toMatchObject({ pid: 45, pids: [44, 45], wallet: "vertex", ended_at: null });
      expect((await lines(path)).map((l) => l.event)).toEqual(["open", "update"]);
    });

    it("tolerates a torn last line and junk, reports the skip count, and keeps every good row", async () => {
      await mkdir(join(root, "state"), { recursive: true });
      const good: Partial<LedgerLine> = {
        event: "open", ts: 1, sessionId: UUID_A, seatDir: PRIMARY, configDir: join(HOME, ".claude"),
        seat: "sameer@", wallet: "sameer@", vertexBilled: false, pid: 5, pids: [5], bridgeSessionId: null,
        cwd: "/x", entrypoint: "cli", kind: "interactive", name: null, tmuxPane: null, version: null,
        startedAt: null, lastStatus: null, first_seen: 1, last_seen: 1, ended_at: null, ended_reason: null,
      };
      await writeFile(path, JSON.stringify(good) + "\nnot json\n[1,2]\n" + JSON.stringify(good).slice(0, 40));
      const L = ledger();
      const summary = await L.start(new FakeSource());
      expect(summary.rows).toBe(1);
      expect(problems).toEqual([expect.objectContaining({ op: "load", skipped: 3 })]);
      // Its record is absent now → closed at boot, so the pre-existing row still counts.
      expect(L.latestForSession(UUID_A)!.ended_reason).toBe("absent-at-boot");
    });

    it("no file yet is a clean first boot, not a problem", async () => {
      const L = ledger();
      await L.start(new FakeSource());
      expect(problems).toEqual([]);
    });
  });

  describe("lookup — the three questions", () => {
    it("which seat ran this uuid (every seat it ran on, newest first)", async () => {
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      src.upsert(rec(1, PRIMARY));
      await tick();
      clock += 10_000;
      src.upsert(rec(2, COMMIS));
      await tick(); await L.flush();
      const q = L.lookup(UUID_A);
      expect(q.kind).toBe("uuid");
      expect(q.rows.map((r) => r.seat)).toEqual(["family@", "sameer@"]);
    });

    it("which uuid a session_… / cse_… phone-app id maps to, and its live holder", async () => {
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      src.upsert(rec(3, COMMIS, { sessionId: PHONE_UUID, bridgeSessionId: TELEPORT, entrypoint: "sdk-cli", tmux: undefined }));
      await tick(); await L.flush();

      for (const q of [TELEPORT, "cse_" + TELEPORT_BODY, "  " + TELEPORT + "\n"]) {
        const r = L.lookup(q);
        expect(r.kind).toBe("teleport");
        expect(r.uuid).toBe(PHONE_UUID);
        expect(r.teleport).toBe(TELEPORT);
        expect(r.uuidSource).toBe("observed");
        expect(r.derivedUuid).toBe(PHONE_UUID);
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].seat).toBe("family@");
        expect(r.live).toEqual([{ seat: "family@", wallet: "family@", pid: 3, pidAlive: true, tmuxPane: null, seatDir: COMMIS }]);
        expect(r.held).toBe(true);
        expect(r.uuidMismatch).toBe(false);
      }
      // And the uuid query finds the same row and reads the teleport id off it.
      const byUuid = L.lookup(PHONE_UUID);
      expect(byUuid.teleport).toBe(TELEPORT);
      expect(byUuid.uuidSource).toBe("given");
      expect(byUuid.derivedUuid).toBeNull();
    });

    it("a teleport id nobody has been seen with resolves to the derivation, labelled as such", () => {
      const L = ledger();
      const r = L.lookup(TELEPORT);
      expect(r).toMatchObject({ kind: "teleport", uuid: PHONE_UUID, uuidSource: "derived", derivedUuid: PHONE_UUID, rows: [], held: false, uuidMismatch: false });
    });

    it("a terminal session with remote control answers with ITS OWN v4 uuid, not the derivation, and is no mismatch", async () => {
      // Essayeur F1, 2026-09-14: a Teams-seat `cli` session acquired a bridgeSessionId seconds
      // after open; its transcript is its own v4 uuid. The derivation only holds for v5 sessions.
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      src.upsert(rec(8, PRIMARY, { sessionId: UUID_B, bridgeSessionId: TELEPORT, entrypoint: "cli" }));
      await tick(); await L.flush();
      const r = L.lookup(TELEPORT);
      expect(r.rows).toHaveLength(1);
      expect(r.uuid).toBe(UUID_B);              // what a resume command must use
      expect(r.uuidSource).toBe("observed");
      expect(r.derivedUuid).toBe(PHONE_UUID);   // reported beside it, never substituted
      expect(r.uuidMismatch).toBe(false);
      expect(L.lookup("cse_" + TELEPORT_BODY).uuid).toBe(UUID_B);
    });

    it("flags a v5 sessionId beside a teleport id that is NOT its uuid5 derivation (client constants moved)", async () => {
      const OTHER_V5 = teleportSessionUuid("cse_01SOMETHINGELSEENTIRELY00");
      expect(OTHER_V5.charAt(14)).toBe("5");
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      src.upsert(rec(4, PRIMARY, { sessionId: OTHER_V5, bridgeSessionId: TELEPORT, entrypoint: "sdk-cli" }));
      await tick(); await L.flush();
      const r = L.lookup(TELEPORT);
      expect(r.rows).toHaveLength(1);
      expect(r.uuid).toBe(OTHER_V5);            // still the observed one — the row is the truth
      expect(r.uuidSource).toBe("observed");
      expect(r.uuidMismatch).toBe(true);        // but the derivation should have held, and did not
    });

    it("is it still running — live empties the moment the record goes", async () => {
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      const r = rec(5, PRIMARY, { tmux: "0:@1.%9" });
      src.upsert(r);
      await tick();
      expect(L.lookup(UUID_A).live).toEqual([{ seat: "sameer@", wallet: "sameer@", pid: 5, pidAlive: true, tmuxPane: "0:@1.%9", seatDir: PRIMARY }]);
      expect(L.lookup(UUID_A).held).toBe(true);
      src.remove(r);
      await L.flush();
      expect(L.lookup(UUID_A).live).toEqual([]);
      expect(L.lookup(UUID_A).held).toBe(false);
      expect(L.lookup(UUID_A).rows).toHaveLength(1); // still findable
    });

    it("a stale record (present, pid dead) is live-but-not-held — no driver, safe to resume", async () => {
      const src = new FakeSource();
      const L = ledger();
      await L.start(src);
      src.upsert(rec(5555, COMMIS, { bridgeSessionId: TELEPORT, status: "busy" }));
      await tick();
      deadPids.add(5555); // CC left the record behind when the phone child died
      const r = L.lookup(TELEPORT);
      expect(r.live).toEqual([expect.objectContaining({ pid: 5555, pidAlive: false })]);
      expect(r.held).toBe(false);
      expect(r.rows[0].ended_at).toBeNull(); // the row mirrors the registry: still on disk
    });

    it("an unrecognised query matches nothing and says so", () => {
      const L = ledger();
      const r = L.lookup("adhd");
      expect(r).toMatchObject({ kind: "unknown", uuid: null, uuidSource: null, derivedUuid: null, teleport: null, rows: [], live: [], held: false });
    });
  });

  it("an unreadable /proc leaves wallet null (not a Teams guess) while the seat stays certain", async () => {
    const src = new FakeSource();
    const L = ledger();
    await L.start(src);
    vertexTable.set(6, null);
    src.upsert(rec(6, COMMIS));
    await tick(); await L.flush();
    expect(L.latestForSession(UUID_A)).toMatchObject({ seat: "family@", wallet: null, vertexBilled: null });
  });

  it("an append failure is reported, not swallowed", async () => {
    await writeFile(join(root, "nope"), ""); // a FILE where the ledger's parent dir must be → mkdir fails
    const bad = new SessionLedger({ path: join(root, "nope", "ledger.jsonl"), vertexBilledForPid: vertexFor, pidAlive: alive, now, onProblem: (p) => problems.push(p) });
    const src = new FakeSource();
    await bad.start(src);
    src.upsert(rec(7, PRIMARY));
    await tick(); await bad.flush();
    expect(problems.some((p) => p.op === "append")).toBe(true);
  });
});

describe("foldLedger / parseLedgerQuery / paths", () => {
  it("last line per key wins and keys include the seat", () => {
    const base = { seatDir: PRIMARY, sessionId: UUID_A, pid: 1 };
    const text = [
      JSON.stringify({ ...base, event: "open", ended_at: null }),
      JSON.stringify({ ...base, seatDir: COMMIS, event: "open", ended_at: null }),
      JSON.stringify({ ...base, event: "end", ended_at: 99 }),
    ].join("\n");
    const { rows, skipped } = foldLedger(text);
    expect(skipped).toBe(0);
    expect(rows.size).toBe(2);
    expect(rows.get(ledgerKey(UUID_A, PRIMARY))!.ended_at).toBe(99);
    expect(rows.get(ledgerKey(UUID_A, COMMIS))!.ended_at).toBeNull();
    expect("event" in rows.get(ledgerKey(UUID_A, PRIMARY))!).toBe(false);
  });

  it("reads a uuid, either teleport prefix, and refuses the rest", () => {
    expect(parseLedgerQuery(UUID_A.toUpperCase())).toEqual({ kind: "uuid", uuid: UUID_A, teleport: null });
    expect(parseLedgerQuery("cse_" + TELEPORT_BODY)).toEqual({ kind: "teleport", uuid: PHONE_UUID, teleport: TELEPORT });
    expect(parseLedgerQuery(TELEPORT)).toEqual({ kind: "teleport", uuid: PHONE_UUID, teleport: TELEPORT });
    expect(parseLedgerQuery("session_").kind).toBe("unknown");
    expect(parseLedgerQuery("").kind).toBe("unknown");
  });

  it("the ledger lives under Guéridon's own state dir, not either seat's", () => {
    expect(defaultLedgerPath("/home/x")).toBe("/home/x/.config/gueridon/session-ledger.jsonl");
  });
});

describe("on the real RegistryWatcher (inotify on fixture seat dirs)", () => {
  let root: string;
  let primary: string;
  let commis: string;
  let w: RegistryWatcher | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gdn-ledger-live-"));
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

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`waitFor: still false after ${ms}ms`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it("a record written then deleted leaves a row with seat and phone-app id, ended", async () => {
    const path = join(root, "ledger.jsonl");
    // One record already there at boot (backfill), one arriving after (watch).
    await writeFile(join(primary, "100.json"), JSON.stringify({
      pid: 100, sessionId: UUID_A, cwd: "/x", entrypoint: "cli", kind: "interactive", status: "idle", updatedAt: 1,
    }));
    w = new RegistryWatcher([primary, commis], { reconcileMs: 60_000 });
    await w.start();
    const L = new SessionLedger({ path, vertexBilledForPid: async () => false, pidAlive: () => true });
    const summary = await L.start(w);
    expect(summary).toMatchObject({ rows: 1, open: 1, endedAtBoot: 0 });

    await writeFile(join(commis, "200.json"), JSON.stringify({
      pid: 200, sessionId: PHONE_UUID, bridgeSessionId: TELEPORT, cwd: "/y", entrypoint: "sdk-cli",
      kind: "interactive", status: "busy", updatedAt: 2,
    }));
    await waitFor(() => L.lookup(TELEPORT).live.length === 1);
    expect(L.lookup(TELEPORT).live[0]).toMatchObject({ seat: "family@", pid: 200 });

    await rm(join(commis, "200.json"));
    await waitFor(() => L.lookup(TELEPORT).live.length === 0);
    await L.flush();
    const q = L.lookup(TELEPORT);
    expect(q.uuid).toBe(PHONE_UUID);
    expect(q.rows[0]).toMatchObject({ seat: "family@", bridgeSessionId: TELEPORT, ended_reason: "record-removed" });
    const file = (await readFile(path, "utf-8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
    expect(file.map((l) => [l.event, l.pid])).toEqual([["open", 100], ["open", 200], ["end", 200]]);
  });
});
