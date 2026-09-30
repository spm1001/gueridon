/**
 * The baton's two verbs (gdn-tamose slice 1): take a conversation from a terminal into
 * Guéridon, and release it back. The orchestration lives here with its effects injected, so
 * the ordering that keeps one writer per transcript is testable without a bridge or a real
 * claude; bridge.ts wires the real registry, signals and sessions.
 *
 * TAKE (Guéridon ← terminal): the registry record must name this pid AND this conversation,
 * the pid must still be a live claude, and the folder must be one Guéridon serves. Wait for
 * the record to read idle (slice 1 has no take-now), write the baton BEFORE signalling so the
 * terminal's wrapper sees "taken" the moment claude exits, SIGTERM (claude's graceful exit,
 * like /exit), SIGKILL after the grace, and resume in Guéridon only once the pid is gone.
 *
 * RELEASE (terminal ← Guéridon): wait for Guéridon's turn to finish, end G gracefully, then
 * hand the baton to the terminal. With no Guéridon session for the id, the conversation is
 * cold and the release is just the baton write.
 */

import type { Baton, BatonRelease } from "./baton.js";
import { isSessionId } from "./baton.js";
import type { LiveState } from "./registry-watch.js";

export type VerbResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; reason: string; state?: LiveState | "shell" };

/** The slice of a registry record the take reads. */
export interface TakeRecord {
  sessionId: string | null;
  state: LiveState;
  /** Raw status as CC wrote it; `shell` = at the prompt with a background shell running. */
  status?: string | null;
  cwd: string | null;
  tmuxPane: string | null;
}

export interface TakeDeps {
  record(pid: number): TakeRecord | undefined;
  isLiveClaude(pid: number): Promise<boolean>;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The absolute folder Guéridon would serve this cwd as, or null when it serves none. */
  resolveFolder(cwd: string): string | null;
  /** True when Guéridon already drives a live G in this folder. */
  folderBusy(folder: string, sessionId: string): boolean;
  /** The `bin/baton` wrapper running this terminal claude (its parent, holding a terminal
   *  baton), or null when the claude was started some other way. Only a wrapped terminal can
   *  be taken: nothing else in that window would take the conversation back, and a bare
   *  shell's `claude --resume` hint invites a second writer. */
  wrapper(pid: number): number | null;
  writeBaton(b: Baton): void;
  release: BatonRelease;
  /** Open the conversation in Guéridon (G spawns lazily, on the first prompt). */
  resume(folder: string, sessionId: string): Promise<{ folderName: string }>;
}

export interface TakeOpts {
  idleTimeoutMs?: number;
  pollMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

export async function takeSession(
  req: { pid?: unknown; sessionId?: unknown; force?: unknown },
  deps: TakeDeps,
  opts: TakeOpts = {},
): Promise<VerbResult<{ folder: string; sessionId: string; waitedMs: number }>> {
  const { idleTimeoutMs = 120_000, pollMs = 250, termGraceMs = 3_000, killGraceMs = 2_000 } = opts;
  const pid = req.pid;
  const sessionId = req.sessionId;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    return { ok: false, status: 400, reason: "pid must be a positive integer" };
  }
  if (!isSessionId(sessionId)) return { ok: false, status: 400, reason: "sessionId must be a uuid" };

  const rec = deps.record(pid);
  if (!rec) return { ok: false, status: 404, reason: "no registry record for that pid" };
  if (rec.sessionId !== sessionId) {
    return { ok: false, status: 409, reason: "that pid holds a different conversation" };
  }
  if (!(await deps.isLiveClaude(pid))) return { ok: false, status: 404, reason: "no live claude with that pid" };
  const folder = rec.cwd ? deps.resolveFolder(rec.cwd) : null;
  if (!folder) return { ok: false, status: 400, reason: "the session's folder is not one Guéridon serves" };
  if (deps.folderBusy(folder, sessionId)) {
    return { ok: false, status: 409, reason: "Guéridon already has a live session in that folder" };
  }
  const wrapper = deps.wrapper(pid);
  if (wrapper === null) {
    return { ok: false, status: 409, reason: "that terminal was not started through bin/baton, so nothing there could take it back" };
  }

  // Wait for idle. A record that vanishes, or a pid that dies, means the terminal let go on
  // its own: nothing left to stop, so carry on to the resume.
  const started = deps.now();
  let current: TakeRecord | undefined = rec;
  let gone = false;
  while (true) {
    current = deps.record(pid);
    if (!current || !(await deps.isLiveClaude(pid))) { gone = true; break; }
    if (current.sessionId !== sessionId) {
      return { ok: false, status: 409, reason: "that pid moved to a different conversation" };
    }
    if (current.state === "idle") break;
    if (deps.now() - started >= idleTimeoutMs) {
      return { ok: false, status: 409, reason: "still not idle", state: current.state };
    }
    await deps.sleep(pollMs);
  }
  const waitedMs = deps.now() - started;
  // A take stops the terminal claude, and its background shells with it (measured by the rig,
  // 2026-09-30: the resumed claude found `[killed]`). Say so and let the person choose.
  if (!gone && current?.status === "shell" && req.force !== true) {
    return { ok: false, status: 409, reason: "a background shell is running in the terminal; taking it would end that shell", state: "shell" };
  }
  // The wait can be long: a G may have started in the folder meanwhile.
  if (deps.folderBusy(folder, sessionId)) {
    return { ok: false, status: 409, reason: "Guéridon already has a live session in that folder" };
  }

  deps.writeBaton({
    v: 1, sessionId, holder: "gueridon", since: new Date(deps.now()).toISOString(),
    pid: null, cwd: rec.cwd, pane: rec.tmuxPane, release: deps.release, takenFrom: pid, wrapper,
  });

  if (!gone) {
    deps.signal(pid, "SIGTERM");
    if (!(await waitForDeath(pid, termGraceMs, pollMs, deps))) {
      deps.signal(pid, "SIGKILL");
      if (!(await waitForDeath(pid, killGraceMs, pollMs, deps))) {
        return { ok: false, status: 500, reason: "the terminal claude would not exit" };
      }
    }
  }

  const { folderName } = await deps.resume(folder, sessionId);
  return { ok: true, folder: folderName, sessionId, waitedMs };
}

async function waitForDeath(
  pid: number, withinMs: number, pollMs: number,
  deps: Pick<TakeDeps, "isLiveClaude" | "sleep" | "now">,
): Promise<boolean> {
  const t0 = deps.now();
  while (await deps.isLiveClaude(pid)) {
    if (deps.now() - t0 >= withinMs) return false;
    await deps.sleep(pollMs);
  }
  return true;
}

/** A live claude OTHER than `ownPid` that the registry says holds `sessionId`: the guard that
 *  keeps Guéridon from spawning G on a conversation a terminal is still writing. */
export function foreignHolder<R extends { pid: number; sessionId: string | null }>(
  records: Iterable<R>, sessionId: string, ownPid: number | null | undefined, alive: (pid: number) => boolean,
): R | null {
  for (const rec of records) {
    if (rec.sessionId === sessionId && rec.pid !== ownPid && alive(rec.pid)) return rec;
  }
  return null;
}

/** The slice of a Guéridon session the release reads, plus how to end it. */
export interface ReleaseSession {
  turnInProgress(): boolean;
  cwd: string;
  /** Refuse new prompts from now on, so no turn starts between "idle" and the end. */
  freeze(): void;
  /** Undo freeze() when the release gives up. */
  unfreeze(): void;
  /** End G gracefully (stdin closed, exit awaited, escalation behind it) and drop the session. */
  end(): Promise<void>;
}

export interface ReleaseDeps {
  session(sessionId: string): ReleaseSession | undefined;
  readBaton(sessionId: string): Baton | null;
  writeBaton(b: Baton): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function releaseSession(
  req: { sessionId: unknown; pane?: unknown },
  deps: ReleaseDeps,
  opts: { turnTimeoutMs?: number; pollMs?: number } = {},
): Promise<VerbResult<{ ended: boolean }>> {
  const { turnTimeoutMs = 300_000, pollMs = 250 } = opts;
  const sessionId = req.sessionId;
  if (!isSessionId(sessionId)) return { ok: false, status: 400, reason: "sessionId must be a uuid" };
  const pane = typeof req.pane === "string" && req.pane !== "" ? req.pane : null;

  const s = deps.session(sessionId);
  if (s) {
    s.freeze();
    const started = deps.now();
    while (s.turnInProgress()) {
      if (deps.now() - started >= turnTimeoutMs) {
        s.unfreeze();
        return { ok: false, status: 409, reason: "Guéridon is still mid-reply", state: "busy" };
      }
      await deps.sleep(pollMs);
    }
    await s.end();
  }

  const prev = deps.readBaton(sessionId);
  deps.writeBaton({
    v: 1, sessionId, holder: "terminal", since: new Date(deps.now()).toISOString(),
    pid: null, cwd: s?.cwd ?? prev?.cwd ?? null, pane: pane ?? prev?.pane ?? null, release: null,
    wrapper: prev?.wrapper ?? null,
  });
  return { ok: true, ended: !!s };
}
