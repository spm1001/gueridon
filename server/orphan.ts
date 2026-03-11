/**
 * Orphan reaping and session persistence for the Guéridon bridge.
 *
 * Tracks spawned CC processes to disk so a restarted bridge can
 * kill leftover children. Also provides debounced session persistence
 * for crash recovery.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { KILL_ESCALATION_MS } from "./bridge-logic.js";
import { emit, errorDetail } from "./event-bus.js";

export const SESSION_FILE = join(homedir(), ".config", "gueridon", "sse-sessions.json");

interface SessionRecord {
  sessionId: string;
  folder: string;
  pid: number;
  spawnedAt: number;
  turnInProgress?: boolean;
}

/** Minimal session shape needed by persistSessions. */
export interface PersistableSession {
  id: string;
  folder: string;
  process: { pid?: number | undefined; exitCode: number | null } | null;
  spawnedAt: number | null;
  turnInProgress: boolean;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancel any pending debounced persist — call before persistSessionsSync in shutdown. */
export function cancelPendingPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

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
          turnInProgress: s.turnInProgress,
        });
      }
    }
    try {
      mkdirSync(join(homedir(), ".config", "gueridon"), { recursive: true });
      await writeFile(SESSION_FILE, JSON.stringify(records, null, 2), "utf-8");
    } catch (err) {
      emit({ type: "server:persist-error", error: errorDetail(err) });
    }
  }, 500);
}

/** Synchronous write for shutdown — must complete before process exits. */
export function persistSessionsSync(sessions: Iterable<PersistableSession>): void {
  const records: SessionRecord[] = [];
  for (const s of sessions) {
    if (s.process?.pid) {
      records.push({
        sessionId: s.id,
        folder: s.folder,
        pid: s.process.pid,
        spawnedAt: s.spawnedAt ?? Date.now(),
        turnInProgress: s.turnInProgress,
      });
    }
  }
  try {
    mkdirSync(join(homedir(), ".config", "gueridon"), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(records, null, 2), "utf-8");
  } catch { /* best effort */ }
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

/** Info about sessions from the previous bridge instance. */
export interface PriorSessionInfo {
  sessionId: string;
  folder: string;
  turnInProgress: boolean;
}

/** Reap orphaned CC processes from a previous bridge instance.
 *  Returns metadata about the sessions that were running — the bridge uses
 *  `turnInProgress` to decide whether bystander sessions auto-resume. */
export function reapOrphans(): PriorSessionInfo[] {
  if (!existsSync(SESSION_FILE)) {
    emit({ type: "orphan:no-file" });
    return [];
  }

  let records: SessionRecord[];
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    records = JSON.parse(raw);
    emit({ type: "orphan:loaded", count: records.length, turnFlags: records.map(r => ({ folder: basename(r.folder), turnInProgress: r.turnInProgress ?? false })) });
  } catch {
    emit({ type: "orphan:parse-error" });
    return [];
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

  return records.map(r => ({
    sessionId: r.sessionId,
    folder: r.folder,
    turnInProgress: r.turnInProgress ?? false,
  }));
}
