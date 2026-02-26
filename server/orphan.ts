/**
 * Orphan reaping and session persistence for the Guéridon bridge.
 *
 * Tracks spawned CC processes to disk so a restarted bridge can
 * kill leftover children. Also provides debounced session persistence
 * for crash recovery.
 */

import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { KILL_ESCALATION_MS } from "./bridge-logic.js";
import { emit } from "./event-bus.js";

export const SESSION_FILE = join(homedir(), ".config", "gueridon", "sse-sessions.json");

interface SessionRecord {
  sessionId: string;
  folder: string;
  pid: number;
  spawnedAt: number;
}

/** Minimal session shape needed by persistSessions. */
export interface PersistableSession {
  id: string;
  folder: string;
  process: { pid?: number | undefined; exitCode: number | null } | null;
  spawnedAt: number | null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write of active sessions to disk. */
export function persistSessions(sessions: Iterable<PersistableSession>): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const records: SessionRecord[] = [];
    for (const s of sessions) {
      if (s.process?.pid) {
        records.push({
          sessionId: s.id,
          folder: s.folder,
          pid: s.process.pid,
          spawnedAt: s.spawnedAt ?? Date.now(),
        });
      }
    }
    try {
      mkdirSync(join(homedir(), ".config", "gueridon"), { recursive: true });
      await writeFile(SESSION_FILE, JSON.stringify(records, null, 2), "utf-8");
    } catch (err) {
      emit({ type: "server:persist-error", error: String(err) });
    }
  }, 500);
}

/** Walk /proc to collect all descendant PIDs (children, grandchildren, etc). */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    try {
      const childrenStr = readFileSync(`/proc/${p}/task/${p}/children`, "utf-8").trim();
      if (!childrenStr) continue;
      for (const c of childrenStr.split(/\s+/)) {
        const cpid = parseInt(c, 10);
        if (cpid && cpid !== pid) {
          descendants.push(cpid);
          queue.push(cpid);
        }
      }
    } catch {
      // Process gone or /proc not available
    }
  }
  return descendants;
}

/** Reap orphaned CC processes from a previous bridge instance. */
export function reapOrphans(): void {
  if (!existsSync(SESSION_FILE)) return;

  let records: SessionRecord[];
  try {
    records = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return;
  }

  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  let reaped = 0;
  for (const rec of records) {
    if (rec.spawnedAt && Date.now() - rec.spawnedAt > MAX_AGE_MS) {
      emit({ type: "orphan:skip", pid: rec.pid, folder: basename(rec.folder), ageHours: Math.round((Date.now() - rec.spawnedAt) / 3600000) });
      continue;
    }
    try {
      process.kill(rec.pid, 0); // check alive
    } catch {
      continue; // already dead
    }
    // Collect child PIDs before killing parent (children re-parent to init on parent death)
    const children = getDescendantPids(rec.pid);
    emit({ type: "orphan:reap", pid: rec.pid, folder: basename(rec.folder), sessionId: rec.sessionId, children: children.length });
    const allPids = [rec.pid, ...children];
    for (const p of allPids) {
      try { process.kill(p, "SIGTERM"); } catch { /* already dead */ }
    }
    reaped++;

    // Escalate: SIGKILL after KILL_ESCALATION_MS for anything that survived
    setTimeout(() => {
      for (const p of allPids) {
        try {
          process.kill(p, 0); // still alive?
          process.kill(p, "SIGKILL");
          emit({ type: "orphan:sigkill", pid: p });
        } catch { /* already dead */ }
      }
    }, KILL_ESCALATION_MS);
  }

  try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }
  if (reaped > 0) {
    emit({ type: "orphan:summary", reaped });
  }
}
