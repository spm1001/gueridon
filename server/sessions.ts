/**
 * Live `claude` session discovery (gdn-batogo).
 *
 * Scans /proc for running `claude` CLI processes so the launcher can show a roster of EVERY
 * live session — not just the RC sessions Guéridon spawned. Read-only: discovery only, no
 * control (Guéridon can drive only the pty sessions it owns; foreign/terminal sessions are
 * shown for awareness). Linux-only (/proc); the bridge runs on Linux.
 */

import { readdir, readFile, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ClaudeProc {
  pid: number;
  cwd: string;
  ageSec: number;
}

/**
 * Find live `claude` MAIN processes with their working directory and elapsed seconds.
 *
 * Identifies sessions by `comm === "claude"` (CC sets its process title) — this catches RC,
 * `-p`, and hand-started interactive sessions alike, while excluding `node`/`tsx` (the bridge
 * itself) and `bash` subshells. Task subagents run in-process, so they don't appear as
 * separate procs. Returns [] on any scan failure (e.g. non-Linux, no /proc).
 */
export async function scanClaudeSessions(): Promise<ClaudeProc[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return []; // no /proc (non-Linux) — roster degrades to empty, not an error
  }

  const pids: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const comm = (await readFile(`/proc/${e}/comm`, "utf-8")).trim();
      if (comm === "claude") pids.push(parseInt(e, 10));
    } catch {
      continue; // process exited mid-scan or comm unreadable
    }
  }
  if (pids.length === 0) return [];

  // Ages in one ps call — etimes is integer elapsed seconds, no clock-tick math.
  const ageByPid = new Map<number, number>();
  try {
    const { stdout } = await execFileP(
      "ps", ["-o", "pid=,etimes=", "-p", pids.join(",")], { timeout: 4000 },
    );
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ageByPid.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
  } catch {
    /* ages are best-effort; default to 0 below */
  }

  const procs: ClaudeProc[] = [];
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      continue; // can't resolve cwd (process gone / permissions) — skip it
    }
    procs.push({ pid, cwd, ageSec: ageByPid.get(pid) ?? 0 });
  }
  return procs;
}
