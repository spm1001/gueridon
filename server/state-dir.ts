/**
 * Where this bridge keeps its own state: sse-sessions.json (orphan reaping), shutdown.json,
 * push keys and subscriptions, the session ledger, and the session batons.
 *
 * Defaults to `~/.config/gueridon`. `GUERIDON_STATE_DIR` moves it, which is what makes a
 * second bridge safe to run beside a live one: its boot calls reapOrphans(), which SIGTERMs
 * every pid recorded in the state dir's sse-sessions.json, so a dev bridge sharing the live
 * bridge's state dir would kill the live bridge's children. (The older recipe, a scratch
 * HOME, also hides ~/.claude from the claude processes the dev bridge spawns.)
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function gueridonStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.GUERIDON_STATE_DIR || join(home, ".config", "gueridon");
}
