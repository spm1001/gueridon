/**
 * The session baton (gdn-tamose): one conversation, one holder.
 *
 * A conversation can be held by Guéridon (a `claude -p` it spawned) or by a terminal (a
 * `claude` in a tmux window, started through `bin/baton`). Never both: two processes on one
 * transcript interleave their writes. The baton file says who holds it, so each end can tell
 * "I was taken" from "I exited", and the terminal end knows where to ask for it back.
 *
 * One file per conversation, `<state dir>/batons/<sessionId>.json`, written whole and renamed
 * into place so a reader never sees half a file. Both ends write it: Guéridon on take and
 * release, `bin/baton` (bash + jq) each time it starts claude. The shape below is the whole
 * contract between them, and `bin/baton.test.ts` binds the bash reader to it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BatonHolder = "gueridon" | "terminal";

/** How the terminal end reaches the Guéridon that holds a conversation: an HTTP base URL or
 *  a Unix socket, plus the identity header value when the bridge requires one. */
export interface BatonRelease {
  url?: string;
  socket?: string;
  user?: string;
}

export interface Baton {
  v: 1;
  sessionId: string;
  holder: BatonHolder;
  /** ISO time the current holder took it. */
  since: string;
  /** The holding claude's pid when known (Guéridon's G once spawned; null before its first prompt). */
  pid: number | null;
  cwd: string | null;
  /** tmux pane of the terminal end, as the registry or $TMUX_PANE names it. */
  pane: string | null;
  /** Set while Guéridon holds it; null when the terminal does. */
  release: BatonRelease | null;
  /** The terminal claude's pid a take stopped, for the record. */
  takenFrom?: number | null;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A conversation id is a uuid. Anything else is refused before it reaches a path. */
export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_RE.test(v);
}

export function batonDir(stateDir: string): string {
  return join(stateDir, "batons");
}

export function batonPath(dir: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`not a session id: ${JSON.stringify(sessionId)}`);
  return join(dir, `${sessionId}.json`);
}

/** The baton for a conversation, or null when none has been written. A file that exists but
 *  does not parse as a baton throws: that is a broken writer, not a free conversation. */
export function readBaton(dir: string, sessionId: string): Baton | null {
  let text: string;
  try {
    text = readFileSync(batonPath(dir, sessionId), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const b = JSON.parse(text) as Baton;
  if (!b || b.sessionId !== sessionId || (b.holder !== "gueridon" && b.holder !== "terminal")) {
    throw new Error(`malformed baton for ${sessionId}`);
  }
  return b;
}

export function writeBaton(dir: string, baton: Baton): void {
  const path = batonPath(dir, baton.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(baton, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
