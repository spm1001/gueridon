/**
 * Content hash computation and file watcher for stale-client detection.
 *
 * Computes a SHA-256 hash of client-facing files and watches for changes.
 * When files change on disk, recomputes the hash and calls the onChange
 * callback so the bridge can notify connected SSE clients.
 */

import { readFileSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { CLIENT_FILES } from "./bridge-logic.js";

const DEBOUNCE_MS = 200;

let currentHash = "";
let watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Compute SHA-256 hash (12 hex chars) of all CLIENT_FILES relative to projectRoot. */
export function computeContentHash(projectRoot: string): string {
  const h = createHash("sha256");
  for (const f of CLIENT_FILES) {
    try { h.update(readFileSync(join(projectRoot, f))); } catch { /* file mid-write */ }
  }
  return h.digest("hex").slice(0, 12);
}

/** Current content hash. */
export function getContentHash(): string {
  return currentHash;
}

/**
 * Start watching CLIENT_FILES for changes.
 * Calls onChange(newHash) when the hash changes after debounce.
 */
export function startWatcher(
  projectRoot: string,
  onChange: (newHash: string) => void,
): void {
  currentHash = computeContentHash(projectRoot);

  // Group files by parent directory — watch dirs, not files (editors do write-rename)
  const dirs = new Map<string, Set<string>>();
  for (const f of CLIENT_FILES) {
    const abs = join(projectRoot, f);
    const dir = dirname(abs);
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir)!.add(basename(abs));
  }

  for (const [dir, names] of dirs) {
    try {
      const w = watch(dir, (_, filename) => {
        if (!filename || !names.has(filename)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const newHash = computeContentHash(projectRoot);
          if (newHash !== currentHash) {
            currentHash = newHash;
            onChange(newHash);
          }
        }, DEBOUNCE_MS);
      });
      w.on("error", () => { /* watcher died — non-fatal, falls back to reconnect detection */ });
      watchers.push(w);
    } catch {
      // Directory missing or no permissions — non-fatal
    }
  }
}

/** Stop all watchers and clear debounce timer. */
export function stopWatcher(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  for (const w of watchers) {
    try { w.close(); } catch { /* already closed */ }
  }
  watchers = [];
}
