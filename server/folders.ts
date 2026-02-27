import { readdir, stat, readFile, writeFile, access, open as fsOpen } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ActiveSessionInfo } from "./bridge-logic.js";
import { emit } from "./event-bus.js";

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
  path: string; // "/Users/modha/Repos/gueridon"
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
                  // 200K is the standard context window
                  contextPct = Math.round((input / 200_000) * 100);
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
 * Find the most recent handoff .md file for a folder.
 * Extracts session_id (line 3) and purpose (line 4).
 * Returns null if no handoffs exist or file is malformed.
 */
export async function getLatestHandoff(
  folderPath: string,
): Promise<HandoffInfo | null> {
  const encoded = encodePath(folderPath);
  const dir = join(HANDOFFS_DIR, encoded);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  // Filter to .md files, skip symlinks
  const mdFiles: string[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    try {
      const s = await stat(join(dir, file));
      if (s.isFile()) mdFiles.push(file);
    } catch {
      continue;
    }
  }

  if (mdFiles.length === 0) return null;

  // Find most recent by mtime
  let latest: { name: string; mtime: Date } | null = null;
  for (const file of mdFiles) {
    try {
      const s = await stat(join(dir, file));
      if (!latest || s.mtime > latest.mtime) {
        latest = { name: file, mtime: s.mtime };
      }
    } catch {
      continue;
    }
  }

  if (!latest) return null;

  // Read first 5 lines and extract metadata
  try {
    const content = await readFile(join(dir, latest.name), "utf-8");
    const lines = content.split("\n", 5);

    // Line 3 (index 2): "session_id: <value>"
    const sessionIdMatch = lines[2]?.match(/^session_id:\s*(.+)$/);
    // Line 4 (index 3): "purpose: <value>"
    const purposeMatch = lines[3]?.match(/^purpose:\s*(.+)$/);

    if (!sessionIdMatch || !purposeMatch) return null;

    return {
      sessionId: sessionIdMatch[1].trim(),
      purpose: purposeMatch[1].trim(),
      mtime: latest.mtime,
    };
  } catch {
    return null;
  }
}

// --- Main scan ---

/**
 * Scan SCAN_ROOT for directories and enrich each with session state.
 *
 * @param activeSessions - Map of folder path → session info for currently
 *   running CC processes (from the bridge's runtime state).
 */
export async function scanFolders(
  activeSessions: Map<string, ActiveSessionInfo>,
): Promise<FolderInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(SCAN_ROOT);
  } catch (err) {
    emit({ type: "folders:scan-error", scanRoot: SCAN_ROOT, error: String(err) });
    return [];
  }

  // Process all folders concurrently (gdn-fisimu). Each folder's stat,
  // session lookup, handoff, and exit marker checks run in parallel.
  const visible = entries.filter((name) => !name.startsWith("."));

  async function processFolder(name: string): Promise<FolderInfo | null> {
    const fullPath = join(SCAN_ROOT, name);

    // stat follows symlinks — includes things like claude-config -> ~/.claude
    try {
      const s = await stat(fullPath);
      if (!s.isDirectory()) return null;
    } catch {
      return null; // skip broken symlinks or permission errors
    }

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

  const results = await Promise.allSettled(visible.map(processFolder));
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
