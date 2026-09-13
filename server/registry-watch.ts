/**
 * Session-registry watcher (gdn-fusijo) — live idle / busy / waiting for every session.
 *
 * Claude Code (≥ 2.1.265, measured 2026-09-08/09) writes one JSON record per live session
 * to `<configDir>/sessions/<pid>.json` and deletes it within seconds of the process ending.
 * The record carries `status` (`idle` at the prompt, `busy` mid-turn, `waiting` while an
 * AskUserQuestion, a plan approval or a tool-permission dialog is up — and at least one
 * more value, `shell`, seen 2026-09-13), `statusUpdatedAt`, the `tmux` pane holding it,
 * `sessionId`, `cwd`, `entrypoint`, and `bridgeSessionId` when remote-control-attached.
 * Each wallet has its own directory (`~/.claude/sessions`, `~/.claude-commis/sessions`), so
 * the directory a record sits in names the seat.
 *
 * This is state from CC's own state machine — the source the roster wanted all along.
 * Hooks lost because an interrupted turn fires no Stop hook, and screen scrapers lost
 * because a rendered view is a lossy readout of the same state (understanding.md, "Observe
 * CC from outside via structured substrate, never the TUI"). `sdk-cli` sessions (bridge
 * children, `-p`, phone sessions) write a record WITHOUT `status`, so absent means
 * UNKNOWN, never idle.
 *
 * Two sinks by design: the roster reads `byPid()` for live state now; a journal (gdn-daluto)
 * subscribes to `upsert`/`remove` to keep the wallet + teleport-id join after CC deletes
 * the record. Write the watcher once; never a second reader.
 *
 * Mechanics: `fs.watch` (inotify) on each directory for the sub-second signal, plus a slow
 * reconcile pass that re-lists the directories — inotify events can coalesce or be missed,
 * and a directory that does not exist yet (the commis seat on a fresh atelier home) can
 * only be picked up by retrying. Only `<pid>.json` files are read; the sibling
 * `<pid>.<hash>.key` files are messaging secrets and are never opened.
 */

import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** The roster's four-way chip. Anything CC writes that is not `waiting`/`busy` is "fine". */
export type LiveState = "idle" | "busy" | "waiting" | "unknown";

export interface RegistryRecord {
  pid: number;
  /** The registry directory the record was read from — names the seat. */
  seatDir: string;
  /** `dirname(seatDir)`: the CLAUDE_CONFIG_DIR whose credential this session runs on. */
  configDir: string;
  sessionId: string | null;
  /** Raw `status` as CC wrote it (`idle|busy|waiting|shell|…`); null when absent. */
  status: string | null;
  state: LiveState;
  /** ms epoch of the last status change, when CC stamped one. */
  statusUpdatedAt: number | null;
  /** ms epoch of the last record write — the monotone guard against out-of-order reads. */
  updatedAt: number | null;
  /** tmux pane id (e.g. `0:@37.%37`) when the session runs in one. */
  tmuxPane: string | null;
  cwd: string | null;
  entrypoint: string | null;
  kind: string | null;
  name: string | null;
  bridgeSessionId: string | null;
  version: string | null;
  startedAt: number | null;
}

const RECORD_FILE_RE = /^(\d+)\.json$/;

/**
 * Map CC's status string onto the chip. Deliberately not an exhaustive switch: `waiting`
 * is the one value the phone must never miss ("blocked — wants to make progress but
 * can't"), `busy` is worth its own colour, and everything else CC might write — `idle`,
 * `shell`, whatever comes next — is "fine" and renders idle. Absent/non-string → unknown.
 */
export function classifyStatus(status: unknown): LiveState {
  if (typeof status !== "string" || status === "") return "unknown";
  if (status === "waiting") return "waiting";
  if (status === "busy") return "busy";
  return "idle";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse one registry file's text into a record. Returns null for anything that is not a
 * JSON object with a usable pid (a half-written file, an empty file, junk) — the caller
 * keeps the previous state and waits for the next event.
 */
export function parseRegistryRecord(text: string, seatDir: string, filePid?: number): RegistryRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pid = num(r.pid) ?? filePid ?? null;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  const status = str(r.status);
  return {
    pid, seatDir, configDir: dirname(seatDir),
    sessionId: str(r.sessionId),
    status, state: classifyStatus(status),
    statusUpdatedAt: num(r.statusUpdatedAt),
    updatedAt: num(r.updatedAt),
    tmuxPane: str(r.tmux),
    cwd: str(r.cwd),
    entrypoint: str(r.entrypoint),
    kind: str(r.kind),
    name: str(r.name),
    bridgeSessionId: str(r.bridgeSessionId),
    version: str(r.version),
    startedAt: num(r.startedAt),
  };
}

/** The estate's two seats. Both hardcoded to match `walletLabel` until the wallet sheet lands (gdn-merozu). */
export function defaultRegistryDirs(home: string = homedir()): string[] {
  return [join(home, ".claude", "sessions"), join(home, ".claude-commis", "sessions")];
}

export interface RegistryWatcherOptions {
  /** How often to re-list the directories (and re-arm any missing watch). Default 10s. */
  reconcileMs?: number;
}

export type RegistryWatchStatus = "armed" | "missing" | "error";

/**
 * Events:
 *  - `upsert` (record: RegistryRecord, prev: RegistryRecord | null) — a record appeared or changed
 *  - `remove` (record: RegistryRecord) — the file is gone; `record` is the last state seen
 *  - `watch` (dir: string, status: RegistryWatchStatus, detail?: string) — watcher lifecycle
 */
export class RegistryWatcher extends EventEmitter {
  private readonly dirs: string[];
  private readonly reconcileMs: number;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly records = new Map<number, RegistryRecord>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** In-flight refreshes, so stop() can let them drain before callers tear down fixtures. */
  private pending = new Set<Promise<void>>();

  constructor(dirs: string[] = defaultRegistryDirs(), opts: RegistryWatcherOptions = {}) {
    super();
    this.dirs = dirs;
    this.reconcileMs = opts.reconcileMs ?? 10_000;
  }

  /** Arm the watches and load whatever records already exist. Resolves after the first full pass. */
  async start(): Promise<void> {
    this.stopped = false;
    for (const dir of this.dirs) this.arm(dir);
    await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.reconcileMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const [dir, w] of this.watchers) { w.close(); this.watchers.delete(dir); }
  }

  /** Wait for in-flight reads to settle — tests call this before removing fixture dirs. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Live records keyed by pid — the roster's merge key against the /proc scan. */
  byPid(): Map<number, RegistryRecord> {
    return new Map(this.records);
  }

  snapshot(): RegistryRecord[] {
    return [...this.records.values()];
  }

  private arm(dir: string): void {
    if (this.stopped || this.watchers.has(dir)) return;
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false }, (_event, filename) => {
        // filename is null when the kernel could not attribute the event — re-list the dir.
        if (typeof filename === "string") this.track(this.refresh(dir, filename));
        else void this.reconcileDir(dir);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.emit("watch", dir, code === "ENOENT" ? "missing" : "error", code ?? String(err));
      return;
    }
    w.on("error", (err) => {
      // The directory went away under us (or inotify ran out of watches). Drop the watch;
      // the reconcile timer re-arms it when it can and sweeps the records meanwhile.
      this.watchers.delete(dir);
      w.close();
      this.emit("watch", dir, "error", (err as NodeJS.ErrnoException).code ?? String(err));
    });
    this.watchers.set(dir, w);
    this.emit("watch", dir, "armed");
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Re-read one file after an inotify event; ENOENT means the record was deleted. */
  private async refresh(dir: string, filename: string): Promise<void> {
    const m = RECORD_FILE_RE.exec(filename);
    if (!m) return; // `.key` secrets, temp files, anything not a <pid>.json — never opened
    const filePid = parseInt(m[1], 10);
    const path = join(dir, filename);
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.drop(filePid, dir);
      return; // EACCES or a race — keep what we had
    }
    const rec = parseRegistryRecord(text, dir, filePid);
    if (!rec) return; // half-written; the completing write fires another event
    this.upsert(rec);
  }

  private upsert(rec: RegistryRecord): void {
    const prev = this.records.get(rec.pid) ?? null;
    // Monotone guard: two events can be in flight for one file and complete out of order.
    // A record CC stamped earlier never overwrites one it stamped later.
    if (prev && prev.seatDir === rec.seatDir && prev.updatedAt !== null && rec.updatedAt !== null
      && rec.updatedAt < prev.updatedAt) return;
    if (prev && sameRecord(prev, rec)) return; // no change worth an event
    this.records.set(rec.pid, rec);
    this.emit("upsert", rec, prev);
  }

  private drop(pid: number, dir: string): void {
    const prev = this.records.get(pid);
    if (!prev || prev.seatDir !== dir) return; // a pid can be reused under another seat; only drop ours
    this.records.delete(pid);
    this.emit("remove", prev);
  }

  /** Full pass: re-list every directory, re-arm any watch that is not up. */
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    for (const dir of this.dirs) {
      this.arm(dir);
      await this.reconcileDir(dir);
    }
  }

  private async reconcileDir(dir: string): Promise<void> {
    if (this.stopped) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // Directory absent (seat not provisioned yet) — every record we hold for it is stale.
      for (const rec of [...this.records.values()]) if (rec.seatDir === dir) this.drop(rec.pid, dir);
      return;
    }
    const seen = new Set<number>();
    const reads: Promise<void>[] = [];
    for (const name of names) {
      const m = RECORD_FILE_RE.exec(name);
      if (!m) continue;
      seen.add(parseInt(m[1], 10));
      const p = this.refresh(dir, name);
      this.track(p);
      reads.push(p);
    }
    await Promise.allSettled(reads);
    for (const rec of [...this.records.values()]) {
      if (rec.seatDir === dir && !seen.has(rec.pid)) this.drop(rec.pid, dir);
    }
  }
}

function sameRecord(a: RegistryRecord, b: RegistryRecord): boolean {
  return a.seatDir === b.seatDir && a.sessionId === b.sessionId && a.status === b.status
    && a.statusUpdatedAt === b.statusUpdatedAt && a.updatedAt === b.updatedAt
    && a.tmuxPane === b.tmuxPane && a.cwd === b.cwd && a.name === b.name
    && a.bridgeSessionId === b.bridgeSessionId && a.kind === b.kind;
}
