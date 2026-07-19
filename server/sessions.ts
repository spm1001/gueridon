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
  /**
   * True when the session is Vertex-billed (gdn-kuhaku). The marker lives in one of two
   * places depending on how it was launched: the systemd/`-p` lane inherits
   * `CLAUDE_CODE_USE_VERTEX=1` in its ENVIRON; the `claudev`/`claudefv` shell wrappers pass
   * it inside the `--settings` JSON on the CMDLINE. So we check both.
   */
  vertexBilled: boolean;
}

/** True if `CLAUDE_CODE_USE_VERTEX` is set truthy in either environ or cmdline text. */
function hasVertexMarker(text: string): boolean {
  // Matches `CLAUDE_CODE_USE_VERTEX=1` (environ) and `CLAUDE_CODE_USE_VERTEX":"1"` (--settings JSON).
  return /CLAUDE_CODE_USE_VERTEX["\s]*[:=]["\s]*"?1/.test(text);
}

/**
 * True if a /proc cmdline is the Claude Code daemon (`claude daemon run …`), not a session
 * (gdn-mimije). /proc/<pid>/cmdline is NUL-separated argv; the daemon's argv[1] is `daemon`
 * (e.g. `/…/claude\0daemon\0run\0--origin\0transient\0…`), and it can be spawned transiently
 * by any session — so it shares comm=="claude" and would otherwise show as an End-able roster
 * row (tapping End would SIGTERM the daemon, not a session). No interactive/-p/RC session has
 * `daemon` as its subcommand (they are `claude`, `claude --resume …`, `claude -p …`,
 * `claude --remote-control …`, `claude /open`, `claude --settings …`), so this never excludes
 * a real session. Empty/unreadable cmdline → not a daemon (fail open: keep the row).
 */
export function isDaemonCmdline(cmdlineRaw: string): boolean {
  const argv = cmdlineRaw.split("\0").filter(Boolean);
  return argv[1] === "daemon";
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
    // Read cmdline once: it lets us (a) exclude the CC daemon (`claude daemon run …`,
    // gdn-mimije — infrastructure, not a session; an End on it would kill the daemon), and
    // (b) detect Vertex billing for wrapper-launched sessions (--settings JSON on the cmdline).
    let cmdline = "";
    try { cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8"); } catch { /* unreadable — treat as session */ }
    if (isDaemonCmdline(cmdline)) continue; // the daemon is not a session — keep it out of the roster

    // Vertex detection: cmdline (wrapper --settings) OR environ (systemd/-p lane, env-var launch).
    let vertexBilled = hasVertexMarker(cmdline);
    if (!vertexBilled) {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, "utf-8");
        if (hasVertexMarker(environ)) vertexBilled = true;
      } catch {
        /* unreadable (race / permissions) — leave as not-detected */
      }
    }
    procs.push({ pid, cwd, ageSec: ageByPid.get(pid) ?? 0, vertexBilled });
  }
  return procs;
}

/**
 * True iff `pid` is a live process whose `comm` is `claude` (gdn-racuca) — the guard for
 * SIGTERM-by-pid. Confirms the pid is a real claude session (roster membership) and rules out
 * a recycled or foreign pid before we signal it. False on any error (process gone, non-Linux,
 * permissions) — fail closed, so a bad pid never gets signalled.
 */
export async function isLiveClaudePid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const comm = (await readFile(`/proc/${pid}/comm`, "utf-8")).trim();
    return comm === "claude";
  } catch {
    return false; // process exited, or /proc unreadable
  }
}
