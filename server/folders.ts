import { readdir, stat, readFile, writeFile, access, open as fsOpen } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveSessionInfo } from "./bridge-logic.js";
import { isSessionReadyFromTail } from "./bridge-logic.js";
import { emit, errorDetail } from "./event-bus.js";

const execFileP = promisify(execFile);

// --- Shared tail-read utility ---

/**
 * Read the last `bytes` of a file asynchronously.
 * Returns the tail as a UTF-8 string. If the file is smaller than `bytes`,
 * returns the entire file contents. Returns null if the file doesn't exist
 * or can't be read.
 */
export async function tailRead(filePath: string, bytes = 8192): Promise<string | null> {
  let fh;
  try {
    fh = await fsOpen(filePath, "r");
    const s = await fh.stat();
    if (!s.isFile() || s.size === 0) return null;
    const readSize = Math.min(bytes, s.size);
    const offset = s.size - readSize;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, offset);
    return buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// --- Types ---

export type FolderState = "active" | "paused" | "closed" | "fresh";

/** What the CC process is doing right now (only meaningful when state is "active"). */
export type FolderActivity = "working" | "waiting" | null;

export interface FolderInfo {
  name: string; // "gueridon"
  path: string; // "/home/user/Repos/gueridon"
  state: FolderState;
  activity: FolderActivity; // "working" = streaming, "waiting" = idle, null = no process
  sessionId: string | null; // most recent CC session UUID (for --resume)
  lastActive: string | null; // ISO timestamp from session file mtime
  handoffPurpose: string | null; // from latest handoff .md
  contextPct: number | null; // last-known context usage % (from result event)
  sessions: SessionListItem[]; // all sessions for this folder (most recent first)
  humanSessionCount: number; // sessions where user actually typed (not subagent-only)
}


// --- Config ---

export const SCAN_ROOT =
  process.env.SCAN_ROOT || join(homedir(), "Repos");
export const CC_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HANDOFFS_DIR = join(homedir(), ".claude", "handoffs");

// --- Path encoding ---

/** Encode an absolute path the same way CC does for project/handoff directories. */
export function encodePath(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Get the absolute path to a CC session JSONL file for a given folder and session ID. */
export function getSessionJSONLPath(folderPath: string, sessionId: string): string {
  return join(CC_PROJECTS_DIR, encodePath(folderPath), `${sessionId}.jsonl`);
}

// --- Exit marker ---

/**
 * Write a .exit marker file for a deliberately closed session.
 * Path: CC_PROJECTS_DIR/encodedPath/sessionId.exit
 */
export async function writeExitMarker(
  folderPath: string,
  sessionId: string,
): Promise<void> {
  const markerPath = join(
    CC_PROJECTS_DIR,
    encodePath(folderPath),
    `${sessionId}.exit`,
  );
  await writeFile(
    markerPath,
    JSON.stringify({ sessionId, timestamp: new Date().toISOString(), source: "bridge" }),
    "utf-8",
  );
}

/**
 * Check if a .exit marker exists for a session.
 */
export async function hasExitMarker(
  folderPath: string,
  sessionId: string,
): Promise<boolean> {
  const markerPath = join(
    CC_PROJECTS_DIR,
    encodePath(folderPath),
    `${sessionId}.exit`,
  );
  try {
    await access(markerPath);
    return true;
  } catch {
    return false;
  }
}

// --- Session file lookup ---

interface SessionInfo {
  id: string;
  lastActive: Date;
}

/**
 * Find the most recent CC session .jsonl file for a folder.
 * Returns null if no sessions exist.
 */
export async function getLatestSession(
  folderPath: string,
): Promise<SessionInfo | null> {
  const encoded = encodePath(folderPath);
  const dir = join(CC_PROJECTS_DIR, encoded);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null; // ENOENT or permission error
  }

  // Filter to .jsonl files only (skip directories like memory/, and other files)
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return null;

  // Find the most recent by mtime
  let latest: { name: string; mtime: Date } | null = null;
  for (const file of jsonlFiles) {
    try {
      const s = await stat(join(dir, file));
      if (!s.isFile()) continue;
      if (!latest || s.mtime > latest.mtime) {
        latest = { name: file, mtime: s.mtime };
      }
    } catch {
      continue; // skip unreadable files
    }
  }

  if (!latest) return null;

  // Extract UUID from filename: "abc-123.jsonl" → "abc-123"
  const id = basename(latest.name, ".jsonl");
  return { id, lastActive: latest.mtime };
}

// --- RC launch readiness (gdn-cumado) ---

/**
 * Does this folder have bon/handoff context worth auto-orienting to?
 * Auto-/open only makes sense where /open has something to read — a context-less repo
 * makes /open flail endlessly (gdn-cumado spike: an empty repo ran 14 tool calls and
 * never finished). The `.bon/` directory is the signal.
 */
export async function hasBonContext(folderPath: string): Promise<boolean> {
  try {
    await access(join(folderPath, ".bon"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a freshly launched RC session done orienting (ready for the user)? (gdn-cumado)
 *
 * Finds the JSONL the RC spawn created — the newest `*.jsonl` whose mtime is at/after
 * `spawnedAt` (minus a small clock skew) so a stale prior session in the same folder
 * can't read as ready — tails it, and asks isSessionReadyFromTail. Returns false if no
 * fresh JSONL exists yet (the session is still starting); the launcher's timeout fallback
 * bounds the wait, since /open latency is unbounded.
 */
export async function isRcSessionReady(
  folderPath: string,
  spawnedAt: number,
): Promise<boolean> {
  const dir = join(CC_PROJECTS_DIR, encodePath(folderPath));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false; // project dir not created yet
  }

  const SKEW_MS = 2000; // spawnedAt is the bridge clock; mtime is the same-host fs clock
  let newest: { path: string; mtime: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const p = join(dir, f);
      const s = await stat(p);
      if (!s.isFile()) continue;
      const m = s.mtime.getTime();
      if (m < spawnedAt - SKEW_MS) continue; // predates this spawn — not our session
      if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
    } catch {
      continue;
    }
  }
  if (!newest) return false;

  const tail = await tailRead(newest.path, 16384);
  if (!tail) return false;
  return isSessionReadyFromTail(tail);
}

// --- Per-folder session list ---

export interface SessionListItem {
  id: string;           // UUID (filename minus .jsonl)
  lastActive: string;   // ISO from mtime
  contextPct: number | null;  // from last assistant usage, null if no assistant events
  model: string | null;       // from last assistant message.model
  closed: boolean;            // .exit marker exists
  humanInteraction: boolean;  // true if has user-typed text (not just subagent Tool calls)
}

/**
 * List all CC sessions for a folder with metadata extracted from JSONL tails.
 *
 * Scans `~/.claude/projects/<encodedPath>/` for `*.jsonl` files.
 * For each: stat for mtime, tail last ~4KB to find the last `assistant` event,
 * extract model and usage → compute context_pct, check .exit marker.
 *
 * Returns sorted by mtime descending (most recent first).
 */
export async function getSessionsForFolder(
  folderPath: string,
): Promise<SessionListItem[]> {
  const encoded = encodePath(folderPath);
  const dir = join(CC_PROJECTS_DIR, encoded);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) return [];

  const items: (SessionListItem & { _mtime: number })[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(dir, file);
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;

      const id = basename(file, ".jsonl");
      const closed = await hasExitMarker(folderPath, id);

      // Tail last ~4KB to find the last assistant event with model/usage
      let model: string | null = null;
      let contextPct: number | null = null;
      let humanInteraction = false;

      const tail = await tailRead(filePath, 4096);
      if (tail) {
        // Split into lines; first line may be partial if we seeked mid-line
        const lines = tail.split("\n");

        // Walk backwards to find last assistant event
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "assistant" && evt.message) {
              if (!model) {
                model = evt.message.model ?? null;
                const usage = evt.message.usage;
                if (usage) {
                  const input = (usage.input_tokens ?? 0)
                    + (usage.cache_creation_input_tokens ?? 0)
                    + (usage.cache_read_input_tokens ?? 0);
                  // Transcripts don't record the context window, so infer it:
                  // Fable 5 always runs 1M, [1m]-suffixed models too, and any
                  // session whose input already exceeds 200K provably had 1M.
                  // Residual: a [1m] session still under 200K reads against
                  // 200K and overstates — bounded, never >100% absurd.
                  const window =
                    (model && /fable|\[1m\]/i.test(model)) || input > 200_000
                      ? 1_000_000
                      : 200_000;
                  contextPct = Math.round((input / window) * 100);
                }
              }
            }
            // Detect human interaction: user events with string content
            // (subagent sessions only have array content from tool results)
            if (evt.type === "user" && evt.message?.content && typeof evt.message.content === "string") {
              humanInteraction = true;
            }
          } catch {
            continue; // partial line or non-JSON
          }
        }
      }

      // For large sessions where the tail might miss early user events,
      // also check the head (first ~2KB) for user text
      if (!humanInteraction && s.size > 4096) {
        const headFh = await fsOpen(filePath, "r");
        try {
          const headBuf = Buffer.alloc(Math.min(2048, s.size));
          await headFh.read(headBuf, 0, headBuf.length, 0);
          const head = headBuf.toString("utf-8");
          const headLines = head.split("\n");
          for (const hl of headLines) {
            const trimmed = hl.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (evt.type === "user" && evt.message?.content && typeof evt.message.content === "string") {
                humanInteraction = true;
                break;
              }
            } catch { continue; }
          }
        } finally {
          await headFh.close();
        }
      }

      items.push({
        id,
        lastActive: s.mtime.toISOString(),
        contextPct,
        model,
        closed,
        humanInteraction,
        _mtime: s.mtime.getTime(),
      });
    } catch {
      continue;
    }
  }

  // Sort by mtime descending
  items.sort((a, b) => b._mtime - a._mtime);

  // Strip internal _mtime field
  return items.map(({ _mtime, ...rest }) => rest);
}

// --- Handoff lookup ---

interface HandoffInfo {
  sessionId: string;
  purpose: string;
  mtime: Date; // When the handoff file was last modified
}

/**
 * Resolve the ordered list of directories to search for handoffs, walking up
 * from folderPath. Mirrors bon's lib-handoff.sh `handoff_read_dirs`: at each
 * level a VISIBLE `handoffs/` is preferred over that level's legacy
 * `.bon/handoffs/` (the "legible substrate" convention — prose lives visible at
 * the room where work happens). Stops at the first `.bon/handoffs/` (the board
 * root) or a `.git` boundary, so the walk never climbs into a parent container.
 * Nearest-room dirs come first; the caller picks the first non-empty.
 */
async function findHandoffDirs(folderPath: string): Promise<string[]> {
  const dirs: string[] = [];
  let walk = folderPath;
  while (walk !== dirname(walk)) {
    try {
      await access(join(walk, "handoffs"));
      dirs.push(join(walk, "handoffs"));
    } catch {
      // no visible handoffs/ at this level
    }
    try {
      await access(join(walk, ".bon", "handoffs"));
      dirs.push(join(walk, ".bon", "handoffs"));
      break; // board root reached — stop climbing
    } catch {
      // no .bon/handoffs/ here
    }
    try {
      await access(join(walk, ".git"));
      break; // repo boundary — don't climb into a parent container
    } catch {
      // not a repo root — keep climbing
    }
    walk = dirname(walk);
  }
  return dirs;
}

/**
 * Find the most recent handoff .md file for a folder.
 * Checks visible handoffs/ then .bon/handoffs/ (walk up from folder), then
 * legacy ~/.claude/handoffs/. Extracts session_id (line 3) and purpose (line 4).
 * Returns null if no handoffs exist or file is malformed.
 */
export async function getLatestHandoff(
  folderPath: string,
): Promise<HandoffInfo | null> {
  // Primary: visible handoffs/ then .bon/handoffs/ (walk up from project)
  // Fallback: legacy ~/.claude/handoffs/{encoded}
  const handoffDirs = await findHandoffDirs(folderPath);
  const legacyDir = join(HANDOFFS_DIR, encodePath(folderPath));

  // Search dirs in preference order (visible-first), de-duplicated.
  const dirs = [...new Set([...handoffDirs, legacyDir])];

  // Rank the newest handoff ACROSS all dirs by the header date
  // ("# Handoff — YYYY-MM-DD"), with mtime only breaking same-day ties. mtime
  // alone is unreliable: a fresh clone flattens every file's mtime to checkout
  // time, so mtime-first would pick an arbitrary handoff. Mirrors bon's
  // open-context.sh reader. On a full (date + mtime) tie the first dir seen
  // wins — dirs are in visible-first order, so a visible handoffs/ beats a
  // legacy .bon/handoffs/ on an exact tie.
  let best: { date: string; mtime: Date; content: string } | null = null;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(path);
      } catch {
        continue;
      }
      if (!s.isFile()) continue;
      let content: string;
      try {
        content = await readFile(path, "utf-8");
      } catch {
        continue;
      }
      // Header date from the first line; header-less files sort to the bottom.
      const dateMatch = content.match(/^# Handoff — (\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : "0000-00-00";
      if (
        !best ||
        date > best.date ||
        (date === best.date && s.mtime > best.mtime)
      ) {
        best = { date, mtime: s.mtime, content };
      }
    }
  }

  if (!best) return null;

  // Extract metadata from the winner's first 5 lines.
  const lines = best.content.split("\n", 5);
  // Line 3 (index 2): "session_id: <value>"
  const sessionIdMatch = lines[2]?.match(/^session_id:\s*(.+)$/);
  // Line 4 (index 3): "purpose: <value>"
  const purposeMatch = lines[3]?.match(/^purpose:\s*(.+)$/);

  if (!sessionIdMatch || !purposeMatch) return null;

  return {
    sessionId: sessionIdMatch[1].trim(),
    purpose: purposeMatch[1].trim(),
    mtime: best.mtime,
  };
}

// --- Main scan ---

/**
 * Check if a directory is a project or a container whose children are projects.
 * A container is a directory without .git that has at least one child with .git
 * (e.g. ~/Repos/batterie/ containing bon/, gueridon/, trousse/).
 * Everything else is a project — with or without .git.
 */
async function classifyDir(dirPath: string): Promise<"project" | "container"> {
  try {
    await access(join(dirPath, ".git"));
    return "project";
  } catch {
    // No .git — check if any visible child directory has .git
    try {
      const children = await readdir(dirPath);
      for (const child of children) {
        if (child.startsWith(".")) continue;
        try {
          const cs = await stat(join(dirPath, child));
          if (!cs.isDirectory()) continue;
          await access(join(dirPath, child, ".git"));
          return "container"; // at least one child is a git repo
        } catch { continue; }
      }
    } catch { /* empty */ }
    return "project"; // no git-repo children — treat as leaf project
  }
}

/**
 * Enumerate launchable repos under SCAN_ROOT: direct project folders (have .git)
 * plus one level into container dirs (e.g. spm1001/, itv/). Shared by scanFolders
 * (session-decorated) and listRepos (lean) so the membership logic lives once.
 */
export async function collectRepoCandidates(): Promise<{ name: string; fullPath: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(SCAN_ROOT);
  } catch (err) {
    emit({ type: "folders:scan-error", scanRoot: SCAN_ROOT, error: errorDetail(err) });
    return [];
  }
  const visible = entries.filter((name) => !name.startsWith("."));
  const candidates: { name: string; fullPath: string }[] = [];
  await Promise.allSettled(
    visible.map(async (name) => {
      const fullPath = join(SCAN_ROOT, name);
      try {
        const s = await stat(fullPath);
        if (!s.isDirectory()) return;
      } catch {
        return;
      }
      const kind = await classifyDir(fullPath);
      if (kind === "project") {
        candidates.push({ name, fullPath });
      } else if (kind === "container") {
        // Scan children of the container (one level deeper)
        try {
          const children = await readdir(fullPath);
          for (const child of children) {
            if (child.startsWith(".")) continue;
            const childPath = join(fullPath, child);
            try {
              const cs = await stat(childPath);
              if (cs.isDirectory()) {
                candidates.push({ name: `${name}/${child}`, fullPath: childPath });
              }
            } catch { continue; }
          }
        } catch { /* skip unreadable containers */ }
      }
    }),
  );
  return candidates;
}

export interface RepoInfo {
  name: string;            // "spm1001/gueridon"
  path: string;            // absolute path
  lastCommit: number | null; // unix seconds of last git commit (repo recency)
}

/**
 * Lean launcher listing (gdn-todidu): repos under SCAN_ROOT, ordered by LAST GIT
 * COMMIT time — repo recency, not session mtime (Sameer #4, 2026-06-29). Deliberately
 * skips all the session/handoff/exit-marker enrichment scanFolders does: faster, and
 * subagent sessions never surface because we never read sessions (Sameer #1). Falls
 * back to dir mtime when a repo has no commits.
 */
export async function listRepos(): Promise<RepoInfo[]> {
  const candidates = await collectRepoCandidates();
  const repos = await Promise.all(
    candidates.map(async ({ name, fullPath }): Promise<RepoInfo> => {
      let lastCommit: number | null = null;
      try {
        const { stdout } = await execFileP(
          "git", ["-C", fullPath, "log", "-1", "--format=%ct"], { timeout: 4000 },
        );
        const ts = parseInt(stdout.trim(), 10);
        if (!Number.isNaN(ts)) lastCommit = ts;
      } catch {
        try { lastCommit = Math.floor((await stat(fullPath)).mtimeMs / 1000); } catch { /* null */ }
      }
      return { name, path: fullPath, lastCommit };
    }),
  );
  repos.sort((a, b) => (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
  return repos;
}

/**
 * Scan SCAN_ROOT for directories and enrich each with session state.
 * Supports two-level hierarchy: direct project folders (have .git) and
 * container directories whose children are project folders (e.g. batterie/).
 *
 * @param activeSessions - Map of folder path → session info for currently
 *   running CC processes (from the bridge's runtime state).
 */
export async function scanFolders(
  activeSessions: Map<string, ActiveSessionInfo>,
): Promise<FolderInfo[]> {
  // Membership logic shared with listRepos (collectRepoCandidates).
  const candidates = await collectRepoCandidates();

  // Process all folders concurrently (gdn-fisimu). Each folder's stat,
  // session lookup, handoff, and exit marker checks run in parallel.
  async function processFolder(candidate: { name: string; fullPath: string }): Promise<FolderInfo | null> {
    const { name, fullPath } = candidate;

    // Fetch all sessions for this folder (used in all branches)
    const folderSessions = await getSessionsForFolder(fullPath);

    const humanSessionCount = folderSessions.filter(s => s.humanInteraction).length;

    // Check runtime state first (active processes)
    const activeInfo = activeSessions.get(fullPath);
    if (activeInfo) {
      const handoff = await getLatestHandoff(fullPath);
      return {
        name,
        path: fullPath,
        state: "active",
        activity: activeInfo.activity,
        sessionId: activeInfo.sessionId,
        lastActive: new Date().toISOString(),
        handoffPurpose: handoff?.purpose ?? null,
        contextPct: activeInfo.contextPct,
        sessions: folderSessions,
        humanSessionCount,
      };
    }

    // Check .exit marker, handoff, and session files.
    const session = await getLatestSession(fullPath);
    const exited = session ? await hasExitMarker(fullPath, session.id) : false;
    const handoff = await getLatestHandoff(fullPath);

    if (exited) {
      return {
        name,
        path: fullPath,
        state: "closed",
        activity: null,
        sessionId: session!.id,
        lastActive: session!.lastActive.toISOString(),
        handoffPurpose: handoff?.purpose ?? null,
        contextPct: null,
        sessions: folderSessions,
        humanSessionCount,
      };
    } else if (handoff && (!session || handoff.sessionId === session.id)) {
      return {
        name,
        path: fullPath,
        state: "closed",
        activity: null,
        sessionId: session?.id ?? null,
        lastActive: (session?.lastActive ?? handoff.mtime).toISOString(),
        handoffPurpose: handoff.purpose,
        contextPct: null,
        sessions: folderSessions,
        humanSessionCount,
      };
    } else if (session) {
      return {
        name,
        path: fullPath,
        state: "paused",
        activity: null,
        sessionId: session.id,
        lastActive: session.lastActive.toISOString(),
        handoffPurpose: null,
        contextPct: null,
        sessions: folderSessions,
        humanSessionCount,
      };
    } else {
      return {
        name,
        path: fullPath,
        state: "fresh",
        activity: null,
        sessionId: null,
        lastActive: null,
        handoffPurpose: null,
        contextPct: null,
        sessions: folderSessions,
        humanSessionCount,
      };
    }
  }

  const results = await Promise.allSettled(candidates.map(processFolder));
  const folders: FolderInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      folders.push(result.value);
    }
    // rejected promises (broken folders) silently skipped
  }

  // Sort: active first, paused (most recent), closed (alphabetical), fresh (alphabetical)
  const stateOrder: Record<FolderState, number> = {
    active: 0,
    paused: 1,
    closed: 2,
    fresh: 3,
  };

  folders.sort((a, b) => {
    const stateCompare = stateOrder[a.state] - stateOrder[b.state];
    if (stateCompare !== 0) return stateCompare;

    // Within same state: sort by lastActive (most recent first) or name
    if (a.lastActive && b.lastActive) {
      return b.lastActive.localeCompare(a.lastActive);
    }
    return a.name.localeCompare(b.name);
  });

  return folders;
}
