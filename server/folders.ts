import { readdir, stat, readFile, writeFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ActiveSessionInfo } from "./bridge-logic.js";

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
    console.warn(`[folders] Cannot read ${SCAN_ROOT}:`, err);
    return [];
  }

  const folders: FolderInfo[] = [];

  for (const name of entries) {
    // Skip hidden directories
    if (name.startsWith(".")) continue;

    const fullPath = join(SCAN_ROOT, name);

    // stat follows symlinks — includes things like claude-config -> ~/.claude
    try {
      const s = await stat(fullPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue; // skip broken symlinks or permission errors
    }

    // Check runtime state first (active processes)
    const activeInfo = activeSessions.get(fullPath);
    if (activeInfo) {
      const handoff = await getLatestHandoff(fullPath);
      folders.push({
        name,
        path: fullPath,
        state: "active",
        activity: activeInfo.activity,
        sessionId: activeInfo.sessionId,
        lastActive: new Date().toISOString(),
        handoffPurpose: handoff?.purpose ?? null,
      });
      continue;
    }

    // Check .exit marker, handoff, and session files.
    // .exit = deliberate close via /exit command (definitive).
    // Handoff = intentional close via /close (existing signal).
    // Session files without either = abandoned mid-work (paused).
    // Session .jsonl files persist forever — they're not cleaned up by /close.
    const session = await getLatestSession(fullPath);
    const exited = session ? await hasExitMarker(fullPath, session.id) : false;
    const handoff = await getLatestHandoff(fullPath);

    if (exited) {
      // Deliberately closed via /exit — definitive closed state
      folders.push({
        name,
        path: fullPath,
        state: "closed",
        sessionId: session!.id,
        lastActive: session!.lastActive.toISOString(),
        handoffPurpose: handoff?.purpose ?? null,
      });
    } else if (handoff && (!session || handoff.sessionId === session.id)) {
      // Handoff matches latest session (or no session) → intentionally closed.
      // Stale handoff from session N doesn't block session N+1 from showing as paused.
      folders.push({
        name,
        path: fullPath,
        state: "closed",
        activity: null,
        sessionId: session?.id ?? null,
        lastActive: (session?.lastActive ?? handoff.mtime).toISOString(),
        handoffPurpose: handoff.purpose,
      });
    } else if (session) {
      // Session files but no handoff — abandoned without /close (truly paused)
      folders.push({
        name,
        path: fullPath,
        state: "paused",
        activity: null,
        sessionId: session.id,
        lastActive: session.lastActive.toISOString(),
        handoffPurpose: null,
      });
    } else {
      folders.push({
        name,
        path: fullPath,
        state: "fresh",
        activity: null,
        sessionId: null,
        lastActive: null,
        handoffPurpose: null,
      });
    }
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
