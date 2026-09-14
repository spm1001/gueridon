/**
 * Session ledger (gdn-daluto) — the registry watcher's second sink.
 *
 * CC's session registry (`<configDir>/sessions/<pid>.json`, see registry-watch.ts) is the
 * one place the estate's session join exists — the transcript uuid beside the claude.ai
 * teleport id (`bridgeSessionId`, `session_…`), the cwd, the tmux pane, and by which
 * directory the record sits in, the seat — and it is deleted seconds after the process
 * exits. Transcripts carry no account identity, so after death the seat is unrecoverable
 * from disk and the teleport id only by the uuid5 computation. This module keeps the join.
 *
 * Shape: an append-only JSONL at `~/.config/gueridon/session-ledger.jsonl`. Every line is a
 * full snapshot of ONE row plus `event` and `ts`; the folded view (last line per key wins) is
 * one row per (sessionId, seatDir). The key is never the pid — pids recycle, `/clear` and
 * `/resume` move a pid between session ids, and a resume keeps a sessionId across pids.
 * Field names follow the card: `first_seen` / `last_seen` / `ended_at` as spec'd, the
 * record-derived fields as RegistryRecord spells them.
 *
 * What appends a line: a key first seen (`open`), a session coming back under the same seat
 * (`reopen`), an identity field or pid changing (`update`), and an end (`end`, with a
 * reason). Status flips (idle/busy/waiting) do NOT append — they only move `last_seen` in
 * memory — or the file would grow by every turn of every session. The cost of that choice:
 * an open row's `last_seen` on disk is stale until its end line lands, and a session that
 * ends while the bridge is down is closed at the next boot with `ended_reason:
 * "absent-at-boot"` and `ended_at` = that boot, which is the honest answer, not the true
 * time. Growth is one to three lines per session; compaction is a later concern.
 *
 * The Vertex-vs-Teams tag is not on the record; it is read from /proc once at join time
 * (`vertexBilledForPid`). `seat` (from the directory) is certain; `wallet` is `seat` unless
 * Vertex was seen, and null when /proc could not be read — never a guess.
 *
 * Three questions this answers (`lookup`): which seat ran a uuid, which uuid a
 * `session_…`/`cse_…` id maps to, and whether anything is still holding the session. The
 * third has two halves, answered separately, because a registry record can outlive its
 * process (measured 2026-09-14: two phone-child records whose pids had been dead ~2 h, one
 * still saying `busy`): `live` = rows whose record is present, each with `pidAlive`; `held` =
 * some such pid is actually alive. Only `held` means a live driver — the case where a plain
 * `--resume` would put two writers on one JSONL (understanding.md, "ONE live driver per
 * session JSONL"). A row stays open while its record exists, stale or not; the file mirrors
 * the registry, and liveness is a question about now. Corollary: a stale record is swept
 * when the next `claude` starts on that seat (measured 2026-09-14, both seats), so its
 * `ended_at` is the sweep time, not the death — `last_seen` (CC's last write to the record)
 * is the better "when did it stop" for such a row.
 *
 * A teleport id does not imply a uuid5 transcript. Phone children are MINTED from the id, so
 * their sessionId is uuid5(cse body) — a v5 uuid; but an ordinary terminal session on a Teams
 * seat acquires a `bridgeSessionId` too (remote control on a `cli` session, seen seconds
 * after open on 2026-09-14) and its transcript is its own v4 uuid. So on a teleport query the
 * OBSERVED sessionId is the answer, the derivation is reported beside it, and `uuidMismatch`
 * fires only where the derivation was supposed to hold — a v5 sessionId that disagrees.
 *
 * The key embeds the seat directory's absolute path, so a ledger file copied between HOMEs
 * duplicates every row and closes the originals as absent-at-boot. Not a production path.
 *
 * CLI: `tsx server/session-ledger.ts <uuid | session_… | cse_…>` reads the file with no
 * bridge and probes each open row's record file and pid directly, so its `liveNow` is a
 * fact about now rather than the bridge's last observation.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RegistryRecord } from "./registry-watch.js";
import { claudePidAlive, teleportSessionUuid, vertexBilledForPid } from "./sessions.js";
import { walletLabel } from "./bridge-logic.js";
import { uuidVersionOf } from "./session-index.js";

export type LedgerEvent = "open" | "reopen" | "update" | "end";
export type EndedReason = "record-removed" | "session-changed" | "absent-at-boot";

export interface LedgerRow {
  sessionId: string;
  /** The registry directory the record was read from — names the seat. */
  seatDir: string;
  configDir: string;
  /** Seat label from the directory alone (`sameer@` / `family@` / basename) — always known. */
  seat: string;
  /** `vertex` when the /proc read saw the Vertex marker, else `seat`; null = /proc unreadable. */
  wallet: string | null;
  vertexBilled: boolean | null;
  /** The pid most recently holding this session; informational, never the key. */
  pid: number;
  /** Every pid seen holding this session under this seat, oldest first (bounded). */
  pids: number[];
  bridgeSessionId: string | null;
  cwd: string | null;
  entrypoint: string | null;
  kind: string | null;
  name: string | null;
  tmuxPane: string | null;
  version: string | null;
  /** CC's own `startedAt` from the record (ms epoch). */
  startedAt: number | null;
  /** Last raw `status` seen — informative on an ended row. */
  lastStatus: string | null;
  first_seen: number;
  last_seen: number;
  ended_at: number | null;
  ended_reason: EndedReason | null;
}

/** One line of the file: a row snapshot plus what happened and when. */
export interface LedgerLine extends LedgerRow {
  event: LedgerEvent;
  ts: number;
}

export interface LedgerProblem {
  op: "load" | "append";
  path: string;
  error: string;
  /** For `load`: how many lines were skipped as unparseable (a torn tail is the normal case). */
  skipped?: number;
}

/** What the ledger needs from the watcher — structural, so tests can drive a fake. */
export interface RegistrySource {
  on(event: "upsert", listener: (rec: RegistryRecord, prev: RegistryRecord | null) => void): unknown;
  on(event: "remove", listener: (rec: RegistryRecord) => void): unknown;
  snapshot(): RegistryRecord[];
}

export interface SessionLedgerOptions {
  path?: string;
  /** Resolve the Vertex tag for a pid; defaults to the /proc read. Tests inject a table. */
  vertexBilledForPid?: (pid: number) => Promise<boolean | null>;
  /** Is this pid a living Claude Code process? Defaults to `claudePidAlive` (kill -0 plus the
   *  comm/exe check). Tests inject, since fixture pids are fiction. */
  pidAlive?: (pid: number) => boolean;
  /** Where a problem line goes (the bridge maps it onto its event bus). Default: nothing. */
  onProblem?: (p: LedgerProblem) => void;
  now?: () => number;
}

const MAX_PIDS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEPORT_RE = /^(session|cse)_([A-Za-z0-9]+)$/;

export function defaultLedgerPath(home: string = homedir()): string {
  return join(home, ".config", "gueridon", "session-ledger.jsonl");
}

export function ledgerKey(sessionId: string, seatDir: string): string {
  return `${sessionId} ${seatDir}`; // uuid first: it never contains a space
}

/** Fold JSONL text into rows, last line per key wins. Tolerates a torn tail and junk lines. */
export function foldLedger(text: string): { rows: Map<string, LedgerRow>; skipped: number } {
  const rows = new Map<string, LedgerRow>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { skipped++; continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) { skipped++; continue; }
    const l = e as Partial<LedgerLine>;
    if (typeof l.sessionId !== "string" || typeof l.seatDir !== "string") { skipped++; continue; }
    const { event: _event, ts: _ts, ...row } = l as LedgerLine;
    rows.set(ledgerKey(row.sessionId, row.seatDir), row);
  }
  return { rows, skipped };
}

export interface LedgerLookup {
  query: string;
  /** How the query was read: a transcript uuid, or a teleport id in either prefix form. */
  kind: "uuid" | "teleport" | "unknown";
  /** The transcript uuid: as given; else the sessionId OBSERVED on a row carrying the queried
   *  teleport id; else the uuid5 derivation of the teleport id (a guess until a row confirms it). */
  uuid: string | null;
  uuidSource: "given" | "observed" | "derived" | null;
  /** The uuid5 derivation of a teleport query, always reported so the two can be compared. */
  derivedUuid: string | null;
  /** The `session_…` handle — as given (normalised from `cse_`), or read off a matching row. */
  teleport: string | null;
  /** Every row that names this session, most recently seen first — one per seat it ran on. */
  rows: LedgerRow[];
  /** Rows whose registry record is present (no `ended_at`), each saying whether its pid is
   *  alive AND a Claude Code process — a stale record (dead or recycled pid) is not a driver. */
  live: Array<{ seat: string; wallet: string | null; pid: number; pidAlive: boolean; tmuxPane: string | null; seatDir: string }>;
  /** True iff some live row's pid is a living claude: a driver exists, so do not plain-`--resume`. */
  held: boolean;
  /** True when a row carrying the queried teleport id has a v5 sessionId that is NOT the uuid5
   *  derivation — the tripwire for CC's client constants moving (understanding.md, session
   *  identity). A v4 sessionId beside a teleport id is a terminal session with remote control,
   *  not a mismatch. */
  uuidMismatch: boolean;
}

/** Interpret a query string: transcript uuid, or teleport id in either prefix. */
export function parseLedgerQuery(q: string): { kind: LedgerLookup["kind"]; uuid: string | null; teleport: string | null } {
  const s = q.trim();
  if (UUID_RE.test(s)) return { kind: "uuid", uuid: s.toLowerCase(), teleport: null };
  const m = TELEPORT_RE.exec(s);
  if (m) return { kind: "teleport", uuid: teleportSessionUuid("cse_" + m[2]), teleport: "session_" + m[2] };
  return { kind: "unknown", uuid: null, teleport: null };
}

export class SessionLedger {
  readonly path: string;
  private readonly rows = new Map<string, LedgerRow>();
  private readonly resolveVertex: (pid: number) => Promise<boolean | null>;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly onProblem: (p: LedgerProblem) => void;
  private readonly now: () => number;
  private writeQueue: Promise<void> = Promise.resolve();
  private source: RegistrySource | null = null;
  private started = false;

  constructor(opts: SessionLedgerOptions = {}) {
    this.path = opts.path ?? defaultLedgerPath();
    this.resolveVertex = opts.vertexBilledForPid ?? vertexBilledForPid;
    this.pidAlive = opts.pidAlive ?? claudePidAlive;
    this.onProblem = opts.onProblem ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load the file, subscribe to the watcher, then backfill from its snapshot: every record
   * present becomes/refreshes a row; every open row whose record is absent is closed as
   * `absent-at-boot`. Call after the watcher's own `start()` has resolved, so the snapshot
   * is the first full pass and not an empty map.
   */
  async start(source: RegistrySource): Promise<{ rows: number; open: number; endedAtBoot: number }> {
    await this.load();
    this.source = source;
    // Subscribe BEFORE reading the snapshot: the emitter is synchronous, so nothing can
    // land between the two in one tick, and any event during the async load above is
    // covered by the snapshot pass.
    source.on("upsert", (rec, prev) => { void this.onUpsert(rec, prev); });
    source.on("remove", (rec) => { this.onRemove(rec); });
    this.started = true;
    const present = new Set<string>();
    const joins: Promise<void>[] = [];
    for (const rec of source.snapshot()) {
      if (!rec.sessionId) continue;
      present.add(ledgerKey(rec.sessionId, rec.seatDir));
      joins.push(this.observe(rec));
    }
    await Promise.all(joins);
    let endedAtBoot = 0;
    for (const [key, row] of this.rows) {
      if (row.ended_at === null && !present.has(key)) {
        this.end(row, "absent-at-boot");
        endedAtBoot++;
      }
    }
    await this.flush();
    let open = 0;
    for (const r of this.rows.values()) if (r.ended_at === null) open++;
    return { rows: this.rows.size, open, endedAtBoot };
  }

  /** Wait for every queued append to land — tests and shutdown call this. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  // ---- reads ----

  /** All rows for a transcript uuid (one per seat it ran on), most recently seen first. */
  rowsForSession(sessionId: string): LedgerRow[] {
    const out: LedgerRow[] = [];
    for (const r of this.rows.values()) if (r.sessionId === sessionId) out.push(r);
    return out.sort((a, b) => b.last_seen - a.last_seen);
  }

  /** The most recent row for a uuid, or null — what a cold RECENT row shows. */
  latestForSession(sessionId: string): LedgerRow | null {
    return this.rowsForSession(sessionId)[0] ?? null;
  }

  /** Every row, most recently seen first. */
  all(): LedgerRow[] {
    return [...this.rows.values()].sort((a, b) => b.last_seen - a.last_seen);
  }

  lookup(query: string): LedgerLookup {
    const parsed = parseLedgerQuery(query);
    const matches: LedgerRow[] = [];
    for (const r of this.rows.values()) {
      if (parsed.uuid && r.sessionId === parsed.uuid) { matches.push(r); continue; }
      if (parsed.teleport && r.bridgeSessionId === parsed.teleport) matches.push(r);
    }
    matches.sort((a, b) => b.last_seen - a.last_seen);
    const teleport = parsed.teleport ?? matches.find((r) => r.bridgeSessionId)?.bridgeSessionId ?? null;
    // On a teleport query the observed sessionId wins over the derivation (module doc: a cli
    // session with remote control carries the id beside its own v4 uuid).
    const byTeleport = parsed.kind === "teleport" ? matches.filter((r) => r.bridgeSessionId === parsed.teleport) : [];
    const observed = byTeleport[0]?.sessionId ?? null;
    const uuid = parsed.kind === "uuid" ? parsed.uuid : observed ?? parsed.uuid;
    const uuidSource: LedgerLookup["uuidSource"] = parsed.kind === "uuid" ? "given"
      : observed ? "observed" : parsed.uuid ? "derived" : null;
    const uuidMismatch = byTeleport.some((r) => uuidVersionOf(r.sessionId) === 5 && r.sessionId !== parsed.uuid);
    const live = matches.filter((r) => r.ended_at === null)
      .map((r) => ({ seat: r.seat, wallet: r.wallet, pid: r.pid, pidAlive: this.pidAlive(r.pid), tmuxPane: r.tmuxPane, seatDir: r.seatDir }));
    return {
      query, kind: parsed.kind, uuid, uuidSource,
      derivedUuid: parsed.kind === "teleport" ? parsed.uuid : null,
      teleport, rows: matches,
      live, held: live.some((l) => l.pidAlive),
      uuidMismatch,
    };
  }

  // ---- watcher events ----

  private async onUpsert(rec: RegistryRecord, prev: RegistryRecord | null): Promise<void> {
    // The pid moved on to another session id (`/clear`, `/resume`, or a recycled pid whose
    // remove event was missed): the previous session's row ends — its transcript no longer
    // has this writer — and the new one opens. Never merged.
    if (prev && prev.sessionId && prev.seatDir === rec.seatDir && prev.sessionId !== rec.sessionId) {
      const old = this.rows.get(ledgerKey(prev.sessionId, prev.seatDir));
      if (old && old.ended_at === null && old.pid === prev.pid) this.end(old, "session-changed");
    }
    if (!rec.sessionId) return; // a record with no session id has nothing to journal
    await this.observe(rec);
  }

  private onRemove(rec: RegistryRecord): void {
    if (!rec.sessionId) return;
    const row = this.rows.get(ledgerKey(rec.sessionId, rec.seatDir));
    // Only the pid that holds the row may end it: a resume under a new pid has already
    // moved the row on, and the old pid's late remove must not close the new holder.
    if (!row || row.ended_at !== null || row.pid !== rec.pid) return;
    row.lastStatus = rec.status ?? row.lastStatus;
    row.last_seen = Math.max(row.last_seen, rec.updatedAt ?? 0, this.now());
    this.end(row, "record-removed");
  }

  /** A record exists now: open, reopen, update, or just touch the row it belongs to. */
  private async observe(rec: RegistryRecord): Promise<void> {
    if (!rec.sessionId) return;
    const key = ledgerKey(rec.sessionId, rec.seatDir);
    const now = this.now();
    const seen = Math.max(now, rec.updatedAt ?? 0);
    const existing = this.rows.get(key);

    if (!existing) {
      const vertexBilled = await this.resolveVertex(rec.pid);
      const row = this.rowFrom(rec, vertexBilled, now, seen);
      // The await above yields; someone may have opened this key meanwhile. Last writer wins
      // only if nothing exists — otherwise fall through as an update against what landed.
      if (!this.rows.has(key)) {
        this.rows.set(key, row);
        this.append("open", row);
        return;
      }
      return this.observe(rec);
    }

    const row = existing;
    const identityChanged = row.bridgeSessionId !== rec.bridgeSessionId || row.cwd !== rec.cwd
      || row.name !== rec.name || row.kind !== rec.kind || row.tmuxPane !== rec.tmuxPane
      || row.entrypoint !== rec.entrypoint;
    const pidChanged = row.pid !== rec.pid;
    const reopened = row.ended_at !== null;

    if (pidChanged) {
      // A new process holds this session (a resume): re-read the billing tag — the resume
      // may well be on the other lane, which is the whole point of the wallet switch.
      const vertexBilled = await this.resolveVertex(rec.pid);
      if (this.rows.get(key) !== row) return this.observe(rec); // superseded mid-await
      row.pid = rec.pid;
      if (!row.pids.includes(rec.pid)) row.pids = [...row.pids, rec.pid].slice(-MAX_PIDS);
      if (vertexBilled !== null) {
        row.vertexBilled = vertexBilled;
        row.wallet = walletLabel(row.configDir, vertexBilled);
      }
    }
    row.bridgeSessionId = rec.bridgeSessionId;
    row.cwd = rec.cwd;
    row.name = rec.name;
    row.kind = rec.kind;
    row.tmuxPane = rec.tmuxPane;
    row.entrypoint = rec.entrypoint;
    row.version = rec.version ?? row.version;
    row.startedAt = rec.startedAt ?? row.startedAt;
    row.lastStatus = rec.status ?? row.lastStatus;
    row.last_seen = Math.max(row.last_seen, seen);
    if (reopened) {
      row.ended_at = null;
      row.ended_reason = null;
      this.append("reopen", row);
    } else if (identityChanged || pidChanged) {
      this.append("update", row);
    }
    // Otherwise a status flip or a heartbeat: memory only, no line.
  }

  private rowFrom(rec: RegistryRecord, vertexBilled: boolean | null, now: number, seen: number): LedgerRow {
    const seat = walletLabel(rec.configDir, false);
    return {
      sessionId: rec.sessionId!,
      seatDir: rec.seatDir,
      configDir: rec.configDir,
      seat,
      wallet: vertexBilled === null ? null : walletLabel(rec.configDir, vertexBilled),
      vertexBilled,
      pid: rec.pid,
      pids: [rec.pid],
      bridgeSessionId: rec.bridgeSessionId,
      cwd: rec.cwd,
      entrypoint: rec.entrypoint,
      kind: rec.kind,
      name: rec.name,
      tmuxPane: rec.tmuxPane,
      version: rec.version,
      startedAt: rec.startedAt,
      lastStatus: rec.status,
      // CC's own startedAt is the truer first sighting — the session may predate the bridge.
      first_seen: rec.startedAt && rec.startedAt > 0 ? Math.min(now, rec.startedAt) : now,
      last_seen: seen,
      ended_at: null,
      ended_reason: null,
    };
  }

  private end(row: LedgerRow, reason: EndedReason): void {
    row.ended_at = this.now();
    row.ended_reason = reason;
    this.append("end", row);
  }

  // ---- file ----

  /** Read the file into memory without subscribing to anything — `start()` calls this;
   *  the CLI calls it alone. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // first boot: no ledger yet
      this.onProblem({ op: "load", path: this.path, error: String((err as Error).message ?? err) });
      return;
    }
    const { rows, skipped } = foldLedger(text);
    for (const [k, r] of rows) this.rows.set(k, r);
    if (skipped) this.onProblem({ op: "load", path: this.path, error: `${skipped} unparseable line(s) skipped`, skipped });
  }

  private append(event: LedgerEvent, row: LedgerRow): void {
    const line: LedgerLine = { ...row, pids: [...row.pids], event, ts: this.now() };
    const text = JSON.stringify(line) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, text, "utf-8");
      } catch (err) {
        this.onProblem({ op: "append", path: this.path, error: String((err as Error).message ?? err) });
      }
    });
  }
}

// ---- CLI: read the file, no bridge needed ----
//
// `tsx server/session-ledger.ts <uuid | session_… | cse_…> [--path <file>]`
// Liveness here is a direct probe per open row — does `<seatDir>/<pid>.json` still exist and
// still name this sessionId, AND is that pid alive — so the answer is honest even when the
// bridge is down and its ledger has not yet observed an end, and a stale record does not
// read as a driver.

async function recordStillHolds(row: LedgerRow): Promise<{ recordPresent: boolean; pidAlive: boolean }> {
  let recordPresent = false;
  try {
    const raw = JSON.parse(await readFile(join(row.seatDir, `${row.pid}.json`), "utf-8")) as { sessionId?: unknown };
    recordPresent = raw?.sessionId === row.sessionId;
  } catch { /* gone or unreadable */ }
  return { recordPresent, pidAlive: recordPresent && claudePidAlive(row.pid) };
}

async function cliMain(argv: string[]): Promise<number> {
  const pathIdx = argv.indexOf("--path");
  const path = pathIdx >= 0 ? argv[pathIdx + 1] : defaultLedgerPath();
  const query = argv.filter((a, i) => a !== "--path" && i !== pathIdx + 1)[0];
  if (!query) {
    process.stderr.write("usage: session-ledger <uuid | session_… | cse_…> [--path <ledger.jsonl>]\n");
    return 2;
  }
  const ledger = new SessionLedger({
    path,
    onProblem: (p) => process.stderr.write(`ledger ${p.op}: ${p.error}\n`),
  });
  await ledger.load(); // no watcher: the file is the whole source here
  const result = ledger.lookup(query);
  const rows = await Promise.all(result.rows.map(async (r) => {
    const probe = r.ended_at === null ? await recordStillHolds(r) : { recordPresent: false, pidAlive: false };
    return { ...r, recordPresent: probe.recordPresent, liveNow: probe.pidAlive };
  }));
  const out = {
    ...result,
    live: rows.filter((r) => r.recordPresent).map((r) => ({ seat: r.seat, wallet: r.wallet, pid: r.pid, pidAlive: r.liveNow, tmuxPane: r.tmuxPane, seatDir: r.seatDir })),
    held: rows.some((r) => r.liveNow),
    rows,
    note: "recordPresent/liveNow are direct probes (registry file, then kill -0). ended_at null with recordPresent false means the bridge has not observed the end yet; recordPresent true with liveNow false is a stale record CC left behind — no driver.",
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return result.rows.length ? 0 : 1;
}

const IS_CLI = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href || fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (IS_CLI) {
  cliMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
