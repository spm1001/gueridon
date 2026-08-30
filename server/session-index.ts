/**
 * Session index (gdn-vucube) — the uuid-keyed layer under the pid-keyed roster.
 *
 * The roster (sessions.ts) sees what is ALIVE; this module sees what EXISTS: recent
 * transcripts in the farm (~/.claude/projects), each with the best human title we can
 * scavenge. A session whose process died stays visible here — which is the whole point
 * (gdn-jibudu's --badly: "I lose good thinking because I lose sight of the session").
 *
 * Standalone by design (cede-ground doctrine): if the substrate ships a cross-wallet
 * session index, this module deletes cleanly.
 *
 * Schema facts from the deglacer reference (trousse), all measured:
 * - Farm layout: ~/.claude/projects/{encoded-cwd}/{uuid}.jsonl. The dirname encoding is
 *   ONE-WAY (every "/" became "-") — never decode it; read `.cwd` off the transcript.
 * - Top-level uuid-named .jsonl files are main sessions. Subagent transcripts live in
 *   subdirectories; workflow journal.jsonl files have non-uuid names — both excluded by
 *   the uuid-filename filter.
 * - `ai-title` is its own entry type (what `claude --resume` shows). v5 (programmatic)
 *   sessions never get one (0/12 measured); the fallback chain is Cowork sidecar title →
 *   bridge-log derived title → first human prompt.
 * - A human message is a `user` entry whose content is a STRING and not isMeta.
 */

import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { teleportSessionUuid } from "./sessions.js";

const execFileP = promisify(execFile);

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export interface RecentSession {
  uuid: string;
  cwd: string;
  mtimeMs: number;
  sizeBytes: number;
  entrypoint: string | null;   // "cli" | "sdk-cli" | "claude-desktop" | null (old sessions)
  uuidVersion: number;         // 4 = interactive, 5 = programmatically spawned
  title: string | null;
  titleSource: "ai-title" | "cowork" | "bridge-log" | "first-prompt" | null;
  /** The human's opening words — the subtitle that de-enigmatises a terse ai-title. */
  firstPrompt: string | null;
}

/** Version nibble of a uuid string (position 14: "xxxxxxxx-xxxx-Vxxx-…"). */
export function uuidVersionOf(uuid: string): number {
  return parseInt(uuid.charAt(14), 16);
}

export interface HeadFields {
  cwd: string | null;
  entrypoint: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
}

/**
 * Pull the index fields out of raw transcript text (head + tail chunks, line-oriented).
 * Cheap substring prefilters before JSON.parse — a transcript line can be hundreds of KB
 * of tool output, and we only care about four shapes. Lines that fail to parse (e.g. the
 * cut first line of a tail chunk) are skipped.
 */
export function parseHeadFields(text: string): HeadFields {
  const out: HeadFields = { cwd: null, entrypoint: null, aiTitle: null, firstPrompt: null };
  for (const line of text.split("\n")) {
    if (!line) continue;
    const wantCwd = out.cwd === null && line.includes('"cwd":');
    const wantEntry = out.entrypoint === null && line.includes('"entrypoint":');
    const wantTitle = line.includes('"type":"ai-title"'); // later ai-title wins (retitles)
    const wantPrompt = out.firstPrompt === null && line.includes('"type":"user"');
    if (!wantCwd && !wantEntry && !wantTitle && !wantPrompt) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e !== "object" || e === null) continue;
    if (out.cwd === null && typeof e.cwd === "string") out.cwd = e.cwd;
    if (out.entrypoint === null && typeof e.entrypoint === "string") out.entrypoint = e.entrypoint;
    if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle) out.aiTitle = e.aiTitle;
    if (out.firstPrompt === null && e.type === "user" && (e.isMeta ?? false) !== true) {
      const msg = e.message as { content?: unknown } | undefined;
      const c = msg?.content;
      // Human message = string content (tool results / injections are arrays). Skip
      // slash-command records and the caveat preamble — neither is what the human "said".
      if (typeof c === "string" && c.trim() && !c.startsWith("<command-") && !c.startsWith("Caveat:")) {
        out.firstPrompt = c.trim().replace(/\s+/g, " ").slice(0, 100);
      }
    }
  }
  return out;
}

/** Title precedence: the session's own ai-title, else Cowork sidecar, else bridge log, else first prompt. */
export function resolveTitle(
  head: HeadFields,
  coworkTitle: string | undefined,
  bridgeLogTitle: string | undefined,
): { title: string | null; titleSource: RecentSession["titleSource"] } {
  if (head.aiTitle) return { title: head.aiTitle, titleSource: "ai-title" };
  if (coworkTitle) return { title: coworkTitle, titleSource: "cowork" };
  if (bridgeLogTitle) return { title: bridgeLogTitle, titleSource: "bridge-log" };
  if (head.firstPrompt) return { title: head.firstPrompt, titleSource: "first-prompt" };
  return { title: null, titleSource: null };
}

/** Read the first `headBytes` and last `tailBytes` of a file (ai-title entries land late). */
async function readHeadTail(path: string, headBytes: number, tailBytes: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    if (size <= headBytes + tailBytes) {
      return (await fh.readFile("utf-8")) as string;
    }
    const head = Buffer.alloc(headBytes);
    await fh.read(head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    await fh.read(tail, 0, tailBytes, size - tailBytes);
    // The tail chunk starts mid-line; drop its first fragment so JSON.parse skips cleanly.
    const tailText = tail.toString("utf-8");
    return head.toString("utf-8") + "\n" + tailText.slice(tailText.indexOf("\n") + 1);
  } finally {
    await fh.close();
  }
}

/**
 * Cowork sidecar titles: ~/.config/Claude/claude-code-sessions/<acct>/<ws>/local_<id>.json,
 * whose `cliSessionId` IS the farm uuid (21/21 measured 2026-08-28). Returns uuid → title.
 * Path shape is a sample of one at each nesting level — hence the two-level walk, tolerant
 * of anything missing.
 */
export async function loadCoworkTitles(
  sidecarRoot = join(homedir(), ".config/Claude/claude-code-sessions"),
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let accounts: string[];
  try { accounts = await readdir(sidecarRoot); } catch { return titles; }
  for (const acct of accounts) {
    let workspaces: string[];
    try { workspaces = await readdir(join(sidecarRoot, acct)); } catch { continue; }
    for (const ws of workspaces) {
      let files: string[];
      try { files = await readdir(join(sidecarRoot, acct, ws)); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(await readFile(join(sidecarRoot, acct, ws, f), "utf-8"));
          if (typeof s.cliSessionId === "string" && typeof s.title === "string" && s.title) {
            titles.set(s.cliSessionId, s.title);
          }
        } catch { /* one bad sidecar never sinks the index */ }
      }
    }
  }
  return titles;
}

/**
 * Teleport-session titles scraped from the RC server logs: "derived title for
 * session_<body>: <first prompt>" lines are the ONLY surviving title record once the
 * bridge transcript is gone (deglacer reference). Keyed by the derived local uuid.
 * Skips any log over `maxBytes` — this is a best-effort garnish, never a stall.
 */
export async function loadBridgeLogTitles(
  logsDir = join(homedir(), ".claude/logs"),
  maxBytes = 8 * 1024 * 1024,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let files: string[];
  try { files = await readdir(logsDir); } catch { return titles; }
  for (const f of files) {
    if (!/^claude-remote-.*\.log$/.test(f)) continue;
    try {
      const fh = await open(join(logsDir, f), "r");
      try {
        if ((await fh.stat()).size > maxBytes) continue;
        const text = (await fh.readFile("utf-8")) as string;
        for (const m of text.matchAll(/derived title for session_([A-Za-z0-9]+): (.+)$/gm)) {
          titles.set(teleportSessionUuid("cse_" + m[1]), m[2].trim().slice(0, 100));
        }
      } finally {
        await fh.close();
      }
    } catch { /* unreadable log — skip */ }
  }
  return titles;
}

/**
 * Scan the farm for recent main-session transcripts and index them.
 *
 * `maxFiles` bounds the head-read IO per call (files are examined newest-first, so the
 * bound trims the oldest). Sessions with no human prompt AND no title are dropped —
 * warmups, empty spawns and probe shells, not conversations.
 *
 * `minBytes` is the SUBSTANCE FLOOR (Sameer's screenshot review, 2026-08-30): the band
 * was filling with auto-generated probe sessions — hublot test drives, ardoise cold
 * reads, gouteur gate probes. Measured that evening: every such probe was ≤75KB while
 * every human session was ≥140KB, so 100KB splits them cleanly. Sessions titled from a
 * HUMAN surface (Cowork sidecar, RC bridge log) are exempt — those were launched by a
 * person whatever their size. Known survivor: robot SDK spawns that do real work
 * (a 383KB marmite session) — smarter robot-tagging waits for the wallet journal
 * (gdn-miseso).
 */
export async function scanRecentSessions(opts: {
  projectsDir?: string;
  sidecarRoot?: string;
  logsDir?: string;
  days?: number;
  maxFiles?: number;
  headBytes?: number;
  tailBytes?: number;
  minBytes?: number;
} = {}): Promise<RecentSession[]> {
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude/projects");
  const days = opts.days ?? 5;
  const maxFiles = opts.maxFiles ?? 60;
  const headBytes = opts.headBytes ?? 64 * 1024;
  const tailBytes = opts.tailBytes ?? 16 * 1024;
  const minBytes = opts.minBytes ?? 100 * 1024;
  const cutoff = Date.now() - days * 86_400_000;

  let dirs: string[];
  try { dirs = await readdir(projectsDir); } catch { return []; }

  const candidates: { path: string; uuid: string; mtimeMs: number; sizeBytes: number }[] = [];
  for (const d of dirs) {
    let files: string[];
    try { files = await readdir(join(projectsDir, d)); } catch { continue; }
    for (const f of files) {
      const m = UUID_FILE_RE.exec(f);
      if (!m) continue; // subagent dirs, workflow journals, anything non-session
      const path = join(projectsDir, d, f);
      try {
        const fh = await open(path, "r");
        const st = await fh.stat();
        await fh.close();
        if (st.mtimeMs >= cutoff) {
          candidates.push({ path, uuid: m[1], mtimeMs: st.mtimeMs, sizeBytes: st.size });
        }
      } catch { continue; }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const bounded = candidates.slice(0, maxFiles);

  const [coworkTitles, bridgeTitles] = await Promise.all([
    loadCoworkTitles(opts.sidecarRoot),
    loadBridgeLogTitles(opts.logsDir),
  ]);

  const out: RecentSession[] = [];
  for (const c of bounded) {
    let head: HeadFields;
    try {
      head = parseHeadFields(await readHeadTail(c.path, headBytes, tailBytes));
    } catch { continue; }
    if (!head.cwd) continue; // no cwd = not a conversation transcript we understand
    const { title, titleSource } = resolveTitle(head, coworkTitles.get(c.uuid), bridgeTitles.get(c.uuid));
    if (!head.firstPrompt && !title) continue; // warmup/empty session — not worth a row
    // Substance floor: drop probe-sized sessions unless a human surface titled them.
    const humanSurface = titleSource === "cowork" || titleSource === "bridge-log";
    if (c.sizeBytes < minBytes && !humanSurface) continue;
    out.push({
      uuid: c.uuid, cwd: head.cwd, mtimeMs: c.mtimeMs, sizeBytes: c.sizeBytes,
      entrypoint: head.entrypoint, uuidVersion: uuidVersionOf(c.uuid),
      title, titleSource, firstPrompt: head.firstPrompt,
    });
  }
  return out;
}

/**
 * Session uuids the per-wallet `claude agents --json` registries know to be LIVE
 * (gdn-vucube liveness join). Each registry is per-config-dir — sameer@'s is blind to
 * family@'s and vice versa (measured 2026-08-29) — so we ask each seat. Tolerant of
 * every failure mode: a missing CLI, a timeout, bad JSON each yield [] for that seat.
 * The estate's seats are hardcoded to match walletLabel; both move to config together
 * when the wallet sheet lands (gdn-merozu).
 */
export async function agentsRegistryUuids(
  configDirs: (string | null)[] = [null, join(homedir(), ".claude-commis")],
): Promise<string[]> {
  const uuids: string[] = [];
  await Promise.all(configDirs.map(async (dir) => {
    try {
      const env = { ...process.env };
      if (dir) env.CLAUDE_CONFIG_DIR = dir; else delete env.CLAUDE_CONFIG_DIR;
      const { stdout } = await execFileP("claude", ["agents", "--json"], { env, timeout: 10_000 });
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (typeof a?.sessionId === "string") uuids.push(a.sessionId);
        }
      }
    } catch { /* seat unreadable — its sessions just can't be excluded this round */ }
  }));
  return uuids;
}
