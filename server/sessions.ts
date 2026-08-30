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
import { createHash } from "node:crypto";

const execFileP = promisify(execFile);

export interface ClaudeProc {
  pid: number;
  cwd: string;
  ageSec: number;
  /**
   * True when the session is Vertex-billed (gdn-kuhaku). The marker lives in one of two
   * places depending on how it was launched: the systemd/`-p` lane inherits
   * `CLAUDE_CODE_USE_VERTEX=1` in its ENVIRON; the `claudev`/`claudefv` shell wrappers
   * (the mit-commons block since 2026-08-02) set BOTH — an env prefix and `--settings`
   * JSON on the CMDLINE. Either surface suffices, so we check both.
   */
  vertexBilled: boolean;
  /**
   * `CLAUDE_CONFIG_DIR` from the process environ, when set (gdn-zahidu). This is the wallet:
   * the transcript farm is shared, but which Teams seat a session bills to is purely which
   * config dir's credential it spawned with. Absent/undefined = the default `~/.claude` seat.
   */
  configDir?: string;
  /**
   * The `cse_…` work id from an RC-server child's `--sdk-url` cmdline arg (gdn-zahidu).
   * Present exactly when this process is a phone-created session under a `claude-remote@`
   * server. One id, two prefixes: `session_<body>` (the claude.ai teleport handle) and
   * `cse_<body>` are the same identifier.
   */
  remoteSessionId?: string;
  /** The local transcript uuid derived from remoteSessionId (see teleportSessionUuid). */
  sessionUuid?: string;
}

/**
 * Local transcript uuid for an RC/teleport session id (gdn-zahidu). The harness names the
 * farm JSONL with uuid5(NAMESPACE, "https://api.anthropic.com/v1/code/sessions/cse_<body>")
 * — namespace and URL name-form read out of the CC bundle, verified 12/12 against real
 * sessions (trousse deglacer, 2026-08-28). RISK: both constants are CLIENT constants — a
 * future CC could move them, and the failure mode is a confidently WRONG uuid. Anything
 * that acts on this uuid (resume, index join) should cross-check against a real artefact
 * (transcript exists on disk) before trusting it.
 */
const TELEPORT_UUID_NAMESPACE = "3ab19d7e9f3545c2926e75e271cc60b3";

export function teleportSessionUuid(cseId: string): string {
  const name = `https://api.anthropic.com/v1/code/sessions/${cseId}`;
  const hash = createHash("sha1")
    .update(Buffer.from(TELEPORT_UUID_NAMESPACE, "hex"))
    .update(name, "utf8")
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-based, SHA-1)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Extract the `cse_…` work id from a /proc cmdline, if this is an RC-server child. */
export function extractRemoteSessionId(cmdlineRaw: string): string | undefined {
  // The id only ever appears in `--sdk-url https://…/v1/code/sessions/cse_<body>`.
  const m = /--sdk-url\0[^\0]*\/(cse_[A-Za-z0-9]+)/.exec(cmdlineRaw);
  return m?.[1];
}

/** True if `CLAUDE_CODE_USE_VERTEX` is set truthy in either environ or cmdline text. */
function hasVertexMarker(text: string): boolean {
  // Matches `CLAUDE_CODE_USE_VERTEX=1` (environ) and `CLAUDE_CODE_USE_VERTEX":"1"` (--settings JSON).
  return /CLAUDE_CODE_USE_VERTEX["\s]*[:=]["\s]*"?1/.test(text);
}

/**
 * `claude` subcommands that are INFRASTRUCTURE, not sessions (gdn-mimije, gdn-caguga):
 * - `daemon` — the CC daemon (`claude daemon run …`), spawned transiently by any session.
 * - `remote-control` — a Remote Control SERVER (registers a directory with claude.ai; the
 *   phone creates sessions in it on demand — e.g. tube's `claude-remote@` systemd units).
 *   Always-on: a roster row for it would offer End on a `Restart=always` service, and its
 *   permanent liveness would hide its repo from the launcher's repo list forever via the
 *   live-session filter (gdn-wuvujo).
 * - `remote` — the server alias. The binary rewrites it to `remote-control` in /proc
 *   (verified live 2026-07-25), so this entry is belt-and-braces for versions that don't.
 * - `rc` — a second server alias, seen UN-rewritten in /proc on 2.1.251 (2026-08-30: a
 *   commis-wallet `claude rc` server in ~ had spawned an --sdk-url session child — server
 *   behaviour, new alias; the gdn-caguga leak in fresh clothes).
 * - `agents` — the `claude agents` session-manager TUI (gdn-zahidu). A manager, not a
 *   session: it writes no transcript, and an End on it would kill the user's roster view.
 * - `bg-spare` — the daemon's pre-warmed spare-session pool (gdn-zahidu). Holds a claim
 *   socket, not a conversation.
 * - `bg-pty-host` — the daemon's pty host for a background session (gdn-zahidu). A terminal
 *   wrapper; the session it hosts is a separate process that rosters on its own merits.
 */
const INFRA_SUBCOMMANDS = new Set([
  "daemon", "remote-control", "remote", "rc", "agents", "bg-spare", "bg-pty-host",
]);

/**
 * True if a /proc cmdline is Claude Code INFRA rather than a session — the daemon or a
 * Remote Control server. /proc/<pid>/cmdline is NUL-separated argv; infra carries its
 * subcommand at argv[1] (e.g. `/…/claude\0daemon\0run\0…`, `/…/claude\0remote-control\0
 * --no-create-session-in-dir\0`). Both share comm=="claude" and would otherwise show as
 * End-able roster rows. No real session has an INFRA_SUBCOMMANDS argv[1] — sessions are
 * `claude`, `claude --resume …`, `claude -p …`, `claude /open`, `claude --settings …`, and
 * critically the Teams lane's FLAG form `claude --remote-control <name>` (dashes, so it
 * does not match the `remote-control` subcommand) — so this never excludes a real session.
 * A server's session CHILDREN are real sessions and deliberately stay in the roster
 * (gdn-caguga: they are live work; End on them is the same graceful SIGTERM as any foreign
 * session). Empty/unreadable cmdline → not infra (fail open: keep the row).
 */
export function isInfraCmdline(cmdlineRaw: string): boolean {
  const argv = cmdlineRaw.split("\0").filter(Boolean);
  // Some infra rewrites its process title, folding the subcommand INTO argv[0] as one
  // token with a space — "claude bg-spare\0--bg-spare\0…" (measured 2026-08-30; the tr-based
  // eyeball view renders space and NUL identically, which is how this hid). So the
  // subcommand is argv[0]'s second word when the title was rewritten, else argv[1].
  const argv0Words = (argv[0] ?? "").split(" ").filter(Boolean);
  const sub = argv0Words.length > 1 ? argv0Words[1] : (argv[1] ?? "");
  return INFRA_SUBCOMMANDS.has(sub);
}

/**
 * True if an exe symlink target is the Claude Code binary. CC installs versioned binaries
 * at `~/.local/share/claude/versions/<v>`; `/proc/<pid>/exe` resolves there for EVERY
 * flavour — terminal, RC server, RC child, daemon, bg-spare, any config dir (measured
 * 2026-08-29, gdn-zahidu).
 */
function isClaudeExe(exePath: string): boolean {
  return /\/claude\/versions\/[^/]+$/.test(exePath);
}

/**
 * Find live `claude` MAIN processes with their working directory and elapsed seconds.
 *
 * Identifies sessions by `comm === "claude"` OR by `/proc/<pid>/exe` resolving to a CC
 * versioned binary (gdn-zahidu). The comm check alone is a measured LIVE BUG: an RC-server
 * child's argv[0] is the versioned binary itself, so its comm is e.g. "2.1.251" — the
 * comm-only scan missed every phone-created session. comm stays as the cheap first test;
 * exe is the authoritative fallback. Excludes `node`/`tsx` (the bridge itself) and `bash`
 * subshells by construction. Task subagents run in-process, so they don't appear as
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
      if (comm === "claude") {
        pids.push(parseInt(e, 10));
        continue;
      }
      // Versioned-binary processes (RC-server children) — comm is "2.1.251", exe tells truth.
      const exe = await readlink(`/proc/${e}/exe`);
      if (isClaudeExe(exe)) pids.push(parseInt(e, 10));
    } catch {
      continue; // process exited mid-scan, or comm/exe unreadable (not ours) — skip
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
    // Read cmdline once: it lets us (a) exclude claude INFRA — the CC daemon (gdn-mimije),
    // Remote Control servers (gdn-caguga), the agents TUI and bg-spare pool (gdn-zahidu) —
    // which are claude processes but not sessions, (b) detect Vertex billing for
    // wrapper-launched sessions (--settings JSON on the cmdline), and (c) spot RC-server
    // children by their `--sdk-url …/cse_…` arg.
    let cmdline = "";
    try { cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8"); } catch { /* unreadable — treat as session */ }
    if (isInfraCmdline(cmdline)) continue; // daemon / RC server / agents TUI / bg-spare — infra

    // Environ read (once): Vertex marker for the systemd/-p lane, and CLAUDE_CONFIG_DIR —
    // the wallet a session bills to (gdn-zahidu).
    let environ = "";
    try { environ = await readFile(`/proc/${pid}/environ`, "utf-8"); } catch { /* race / permissions */ }
    const vertexBilled = hasVertexMarker(cmdline) || hasVertexMarker(environ);
    const cfgMatch = /(?:^|\0)CLAUDE_CONFIG_DIR=([^\0]+)/.exec(environ);

    const remoteSessionId = extractRemoteSessionId(cmdline);
    procs.push({
      pid, cwd, ageSec: ageByPid.get(pid) ?? 0, vertexBilled,
      ...(cfgMatch && { configDir: cfgMatch[1] }),
      ...(remoteSessionId && {
        remoteSessionId,
        sessionUuid: teleportSessionUuid(remoteSessionId),
      }),
    });
  }
  return procs;
}

/**
 * True iff `pid` is a live Claude Code process (gdn-racuca) — the guard for SIGTERM-by-pid.
 * Confirms the pid is a real claude process (roster membership) and rules out a recycled or
 * foreign pid before we signal it. Same discriminator as the scan (gdn-zahidu): comm ==
 * "claude", or exe resolving to a CC versioned binary — a versioned-comm child must pass the
 * same guard its roster row came from. False on any error (process gone, non-Linux,
 * permissions) — fail closed, so a bad pid never gets signalled.
 */
export async function isLiveClaudePid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const comm = (await readFile(`/proc/${pid}/comm`, "utf-8")).trim();
    if (comm === "claude") return true;
    return isClaudeExe(await readlink(`/proc/${pid}/exe`));
  } catch {
    return false; // process exited, or /proc unreadable
  }
}
