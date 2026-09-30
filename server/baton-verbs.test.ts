import { describe, it, expect } from "vitest";
import { takeSession, releaseSession, type TakeDeps, type TakeRecord, type ReleaseDeps } from "./baton-verbs.js";
import type { Baton } from "./baton.js";

const ID = "0c6f6a8e-2d4b-4a57-9d51-3f1f5f0b7a11";
const OTHER = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const PID = 4242;

/** A fake world: a clock that sleep() advances, a registry, a process table, and a log of
 *  every effect in the order it happened. */
function takeWorld(rec: Partial<TakeRecord> = {}) {
  const w = {
    t: 0,
    log: [] as string[],
    batons: [] as Baton[],
    records: new Map<number, TakeRecord>([[PID, {
      sessionId: ID, state: "idle", cwd: "/repos/demo", tmuxPane: "0:@3.%3", ...rec,
    }]]),
    alive: new Set([PID]),
    /** What a signal does to the pid: by default SIGTERM ends it, as claude's handler does. */
    onSignal: (pid: number, sig: string) => { if (sig === "SIGTERM" || sig === "SIGKILL") w.alive.delete(pid); },
    onTick: (_t: number) => {},
    busy: false,
  };
  const deps: TakeDeps = {
    record: (pid) => w.records.get(pid),
    isLiveClaude: async (pid) => w.alive.has(pid),
    signal: (pid, sig) => { w.log.push(`${sig}@${w.t}`); w.onSignal(pid, sig); },
    sleep: async (ms) => { w.t += ms; w.onTick(w.t); },
    now: () => w.t,
    resolveFolder: (cwd) => (cwd.startsWith("/repos/") ? cwd : null),
    folderBusy: () => w.busy,
    writeBaton: (b) => { w.log.push(`baton:${b.holder}`); w.batons.push(b); },
    release: { url: "http://127.0.0.1:3013" },
    resume: async (folder, id) => {
      w.log.push(`resume:${id}${w.alive.has(PID) ? ":WHILE-T-ALIVE" : ""}`);
      return { folderName: folder.replace("/repos/", "") };
    },
  };
  return { w, deps };
}

describe("takeSession", () => {
  it("idle terminal: writes the baton, then SIGTERMs, then resumes once the pid is gone", async () => {
    const { w, deps } = takeWorld();
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r).toMatchObject({ ok: true, folder: "demo", sessionId: ID, waitedMs: 0 });
    expect(w.log).toEqual(["baton:gueridon", "SIGTERM@0", `resume:${ID}`]);
    expect(w.batons[0]).toMatchObject({
      holder: "gueridon", sessionId: ID, pane: "0:@3.%3", cwd: "/repos/demo",
      takenFrom: PID, release: { url: "http://127.0.0.1:3013" },
    });
  });

  it("busy terminal: waits for idle and signals nothing until then", async () => {
    const { w, deps } = takeWorld({ state: "busy" });
    w.onTick = (t) => { if (t >= 1000) w.records.get(PID)!.state = "idle"; };
    const r = await takeSession({ pid: PID, sessionId: ID }, deps, { pollMs: 250 });
    expect(r).toMatchObject({ ok: true, waitedMs: 1000 });
    expect(w.log).toEqual(["baton:gueridon", "SIGTERM@1000", `resume:${ID}`]);
  });

  it("a waiting dialog is not idle either", async () => {
    const { w, deps } = takeWorld({ state: "waiting" });
    const r = await takeSession({ pid: PID, sessionId: ID }, deps, { idleTimeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, status: 409, state: "waiting" });
    expect(w.log).toEqual([]);
  });

  it("gives up when the terminal never goes idle, touching nothing", async () => {
    const { w, deps } = takeWorld({ state: "busy" });
    const r = await takeSession({ pid: PID, sessionId: ID }, deps, { idleTimeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "still not idle", state: "busy" });
    expect(w.log).toEqual([]);
  });

  it("refuses a pid whose registry record names a different conversation", async () => {
    const { w, deps } = takeWorld({ sessionId: OTHER });
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(w.log).toEqual([]);
  });

  it("refuses a pid that is not a live claude (a recycled or dead pid)", async () => {
    const { w, deps } = takeWorld();
    w.alive.clear();
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(w.log).toEqual([]);
  });

  it("refuses when the pid moves to another conversation while waited on (/clear)", async () => {
    const { w, deps } = takeWorld({ state: "busy" });
    w.onTick = (t) => { if (t >= 500) Object.assign(w.records.get(PID)!, { sessionId: OTHER, state: "idle" }); };
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r).toMatchObject({ ok: false, status: 409, reason: "that pid moved to a different conversation" });
    expect(w.log).toEqual([]);
  });

  it("refuses a pid with no registry record", async () => {
    const { w, deps } = takeWorld();
    w.records.clear();
    expect(await takeSession({ pid: PID, sessionId: ID }, deps)).toMatchObject({ ok: false, status: 404 });
    expect(w.log).toEqual([]);
  });

  it("refuses a folder Guéridon does not serve", async () => {
    const { w, deps } = takeWorld({ cwd: "/etc" });
    expect(await takeSession({ pid: PID, sessionId: ID }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(w.log).toEqual([]);
  });

  it("refuses when Guéridon already drives a live session in that folder", async () => {
    const { w, deps } = takeWorld();
    w.busy = true;
    expect(await takeSession({ pid: PID, sessionId: ID }, deps)).toMatchObject({ ok: false, status: 409 });
    expect(w.log).toEqual([]);
  });

  it("rejects malformed input before looking anything up", async () => {
    const { w, deps } = takeWorld();
    for (const req of [{ pid: "4242", sessionId: ID }, { pid: 1, sessionId: ID }, { pid: PID, sessionId: "../x" }, {}]) {
      expect(await takeSession(req, deps)).toMatchObject({ ok: false, status: 400 });
    }
    expect(w.log).toEqual([]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored, and still resumes only after death", async () => {
    const { w, deps } = takeWorld();
    w.onSignal = (pid, sig) => { if (sig === "SIGKILL") w.alive.delete(pid); };
    const r = await takeSession({ pid: PID, sessionId: ID }, deps, { termGraceMs: 3000, pollMs: 250 });
    expect(r.ok).toBe(true);
    expect(w.log).toEqual(["baton:gueridon", "SIGTERM@0", "SIGKILL@3000", `resume:${ID}`]);
  });

  it("never resumes while the terminal claude is still alive", async () => {
    const { w, deps } = takeWorld();
    w.onSignal = () => {}; // unkillable
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(w.log.some((l) => l.startsWith("resume"))).toBe(false);
  });

  it("a terminal that exits on its own while waited on is resumed without a signal", async () => {
    const { w, deps } = takeWorld({ state: "busy" });
    w.onTick = (t) => { if (t >= 500) { w.records.delete(PID); w.alive.delete(PID); } };
    const r = await takeSession({ pid: PID, sessionId: ID }, deps);
    expect(r.ok).toBe(true);
    expect(w.log).toEqual(["baton:gueridon", `resume:${ID}`]);
  });
});

function releaseWorld(opts: { session?: boolean; turnFor?: number; prev?: Partial<Baton> } = {}) {
  const w = { t: 0, log: [] as string[], batons: [] as Baton[], frozen: false };
  const deps: ReleaseDeps = {
    session: (id) => (opts.session === false || id !== ID ? undefined : {
      cwd: "/repos/demo",
      turnInProgress: () => w.t < (opts.turnFor ?? 0),
      freeze: () => { w.frozen = true; w.log.push("freeze"); },
      unfreeze: () => { w.frozen = false; w.log.push("unfreeze"); },
      end: async () => { w.log.push(`end@${w.t}`); },
    }),
    readBaton: () => (opts.prev ? { v: 1, sessionId: ID, holder: "gueridon", since: "", pid: null, cwd: null, pane: null, release: null, ...opts.prev } : null),
    writeBaton: (b) => { w.log.push(`baton:${b.holder}`); w.batons.push(b); },
    sleep: async (ms) => { w.t += ms; },
    now: () => w.t,
  };
  return { w, deps };
}

describe("releaseSession", () => {
  it("freezes, waits for Guéridon's turn to finish, ends G, then hands the baton to the terminal", async () => {
    const { w, deps } = releaseWorld({ turnFor: 1000 });
    const r = await releaseSession({ sessionId: ID, pane: "%7" }, deps);
    expect(r).toEqual({ ok: true, ended: true });
    expect(w.log).toEqual(["freeze", "end@1000", "baton:terminal"]);
    expect(w.batons[0]).toMatchObject({ holder: "terminal", pane: "%7", cwd: "/repos/demo", release: null });
  });

  it("gives up mid-reply without ending G or moving the baton, and unfreezes", async () => {
    const { w, deps } = releaseWorld({ turnFor: 1e9 });
    const r = await releaseSession({ sessionId: ID }, deps, { turnTimeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, status: 409, state: "busy" });
    expect(w.log).toEqual(["freeze", "unfreeze"]);
    expect(w.frozen).toBe(false);
  });

  it("a cold conversation (no Guéridon session) is just the baton write, keeping what it knew", async () => {
    const { w, deps } = releaseWorld({ session: false, prev: { cwd: "/repos/demo", pane: "%3" } });
    const r = await releaseSession({ sessionId: ID }, deps);
    expect(r).toEqual({ ok: true, ended: false });
    expect(w.log).toEqual(["baton:terminal"]);
    expect(w.batons[0]).toMatchObject({ cwd: "/repos/demo", pane: "%3" });
  });

  it("rejects an id that is not a uuid", async () => {
    const { w, deps } = releaseWorld();
    expect(await releaseSession({ sessionId: "../../etc/passwd" }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(w.log).toEqual([]);
  });
});
