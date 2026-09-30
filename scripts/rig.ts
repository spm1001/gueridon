/**
 * rig — drive Guéridon's phone view and a tmux terminal side by side, and watch the
 * one-writer rule while doing it (gdn-tamose test rig).
 *
 *   npx tsx scripts/rig.ts up                 private dev bridge + tmux session `rig` + a phone tab
 *   npx tsx scripts/rig.ts down               stop all of it
 *   npx tsx scripts/rig.ts loop a|b           run a whole scripted cycle (see LOOPS below)
 *   npx tsx scripts/rig.ts report             write the run report to ~/scratch/gueridon-rig/
 *   phone:  open | new | take <id> | say <text> | read | tap <n> | upload <path> | shot <name>
 *   term:   start | wait <id> | say <text> | key <k> | read | idle
 *   status                                    registry + batons for the rig's folder
 *
 * Realism choices. The phone is the real Chrome on tube (passe's :9223 backend) emulating an
 * iPhone 14 Pro at 393 px, driven by DOM verbs rather than pixels; the page is read from its
 * own state (liveState), never from screen text. The terminal is a real interactive claude in
 * a tmux window, started through bin/baton, driven with send-keys and read with capture-pane.
 * Waits are on Claude Code's own session registry (idle/busy/waiting), not on sleeps.
 *
 * Isolation. The bridge runs from this checkout on RIG_PORT (3013) with its own
 * GUERIDON_STATE_DIR, so it never reaps or writes the live bridge's state; the folder it
 * serves is a scratch repo under ~/.local/state/gueridon-rig, passed as EXTRA_FOLDERS. Rows
 * and conversations are always picked by id, so nothing outside that folder is ever touched.
 *
 * The watchdog (spawned by `up`) polls the registry every 100 ms and logs, for the rig's
 * folder, every change in who holds each conversation, and a VIOLATION line whenever two live
 * claude processes share one conversation id.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const ROOT = process.env.RIG_ROOT || join(HOME, ".local", "state", "gueridon-rig");
const BOX = join(ROOT, "rigbox");           // the folder conversations live in (stable → trusted once)
const STATE = join(ROOT, "bridge-state");   // the dev bridge's GUERIDON_STATE_DIR
const BATONS = join(STATE, "batons");
const RUN = join(ROOT, "run");              // logs, shots, the run file
const PORT = parseInt(process.env.RIG_PORT || "3013", 10);
const BASE = `http://localhost:${PORT}`;
const TMUX = "rig";
const MODEL = process.env.RIG_MODEL || "haiku";
const DEVICE = ["--device", "iPhone 14 Pro", "--dpr", "1"];
const REGISTRY_DIRS = [join(HOME, ".claude", "sessions"), join(HOME, ".claude-commis", "sessions")];
const PROJECT_DIR = join(HOME, ".claude", "projects", BOX.replace(/[^A-Za-z0-9]/g, "-"));

// ---------- small utilities ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function log(line: string): void {
  mkdirSync(RUN, { recursive: true });
  appendFileSync(join(RUN, "steps.log"), `${now()} ${line}\n`);
  console.log(line);
}

function sh(cmd: string, args: string[], opts: { input?: string; allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { input: opts.input, encoding: "utf-8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || "").slice(-600)}`);
  }
  return r.stdout ?? "";
}

function tmux(...args: string[]): string {
  return sh("tmux", args);
}

// ---------- the session registry ----------

interface Rec { pid: number; sessionId: string | null; status: string | null; cwd: string | null; tmux: string | null; entrypoint: string | null; statusUpdatedAt: number | null }

function liveClaude(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "claude") return true;
    return /\/claude\/versions\//.test(execFileSync("readlink", [`/proc/${pid}/exe`], { encoding: "utf-8" }));
  } catch {
    return false;
  }
}

/** Live registry records in the rig's folder. */
function records(): Rec[] {
  const out: Rec[] = [];
  for (const dir of REGISTRY_DIRS) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, n), "utf-8"));
        if (r.cwd !== BOX || !liveClaude(r.pid)) continue;
        out.push({ pid: r.pid, sessionId: r.sessionId ?? null, status: r.status ?? null, cwd: r.cwd, tmux: r.tmux ?? null, entrypoint: r.entrypoint ?? null, statusUpdatedAt: r.statusUpdatedAt ?? null });
      } catch { /* half-written; next poll */ }
    }
  }
  return out;
}

/** At the prompt: Claude Code writes `idle`, or `shell` while a background shell runs (the
 *  turn is over either way). `busy` and `waiting` are not; no status is not either. */
const atPrompt = (r?: Rec) => !!r && r.status !== null && r.status !== "busy" && r.status !== "waiting";

function termPane(): string {
  return tmux("display-message", "-p", "-t", `${TMUX}:term`, "#{pane_id}").trim();
}

/** The terminal claude's registry record (its tmux field ends with the term window's pane id). */
function termRecord(): Rec | undefined {
  const pane = termPane();
  return records().find((r) => r.tmux?.endsWith(`.${pane}`) || r.tmux === pane);
}

async function until<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 60_000, everyMs = 200): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}

// ---------- batons ----------

function batons(): { sessionId: string; holder: string; pid: number | null; wrapper?: number | null; since: string }[] {
  try {
    return readdirSync(BATONS).filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(join(BATONS, n), "utf-8")));
  } catch { return []; }
}

// ---------- the phone (passe) ----------

function passe(script: string, opts: { first?: boolean } = {}): { i: number; verb: string; result?: unknown }[] {
  const tabArgs = opts.first ? ["--keep-tab"] : ["--reuse-tab", "--tab", `localhost:${PORT}`];
  const r = spawnSync("passe", [...DEVICE, "run", ...tabArgs, "-"], { input: script, encoding: "utf-8" });
  // Step lines go to stderr; the final summary to stdout.
  const steps = `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").filter((l) => l.startsWith("{\"i\""))
    .map((l) => JSON.parse(l));
  if (r.status !== 0) throw new Error(`passe failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
  return steps;
}

/** Evaluate JS in the phone tab; the expression may return a promise, which is awaited. */
function phoneEval<T = unknown>(expr: string): T {
  const steps = passe(`eval ${expr.replace(/\n\s*/g, " ")}`);
  const raw = steps.find((s) => s.verb === "eval")?.result;
  // passe renders results Python-style: booleans arrive as "True"/"False", null as "None".
  if (raw === "True" || raw === "False") return (raw === "True") as T;
  if (raw === "None") return null as T;
  try { return JSON.parse(String(raw)) as T; } catch { return raw as T; }
}

/** Wait inside the page for a condition on its own state; polls every 150 ms. */
function phoneWait(cond: string, timeoutMs = 60_000): void {
  // passe gives one eval 15 s, so wait in slices of up to 10 s.
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const slice = Math.min(10_000, timeoutMs - (Date.now() - t0));
    const ok = phoneEval<boolean>(`new Promise(r => { const t0 = Date.now(); const f = () => { let v = false; try { v = (${cond}); } catch {} if (v) r(true); else if (Date.now() - t0 > ${slice}) r(false); else setTimeout(f, 150); }; f(); })`);
    if (ok === true) return;
  }
  throw new Error(`phone: timed out waiting for ${cond}`);
}

/** Wait for a condition across a navigation: each probe is its own eval, and a probe that dies
 *  with the page it ran in just counts as "not yet". */
async function phoneWaitNav(cond: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (phoneEval<boolean>(`(() => { try { return !!(${cond}); } catch { return false; } })()`) === true) return;
      lastErr = "";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err); // a probe that died mid-navigation
    }
    await sleep(300);
  }
  throw new Error(`phone: timed out waiting for ${cond}${lastErr ? ` (last probe error: ${lastErr.slice(0, 300)})` : ""}`);
}

const CONNECTED = `location.hash === '#rigbox' && typeof liveState !== 'undefined' && liveState.connection === 'connected'`;

/** After an action that starts a turn: wait until a reply newer than message `before` is in and the turn is over. */
function phoneAwaitReply(before: number, timeoutMs: number): void {
  phoneWait(`liveState.messages.length > ${before} && liveState.status === 'idle' && liveState.messages[liveState.messages.length - 1].role === 'assistant'`, timeoutMs);
}

const phone = {
  open(): void {
    passe(`goto ${BASE}/launch.html\nwait 1.5`, { first: true });
    log("phone: launcher open");
  },
  /** Launcher → the rig's folder → Vertex lane (a fresh Guéridon session). */
  async new(): Promise<void> {
    passe(`goto ${BASE}/launch.html\nwait 1.5`);
    await phoneWaitNav(`[...document.querySelectorAll('#repos .repo')].some(e => e.querySelector('.name').textContent === 'rigbox')`, 20_000);
    phoneEval(`(() => { const b = [...document.querySelectorAll('#repos .repo')].find(e => e.querySelector('.name').textContent === 'rigbox'); b.click(); setTimeout(() => document.getElementById('launchVertex').click(), 100); return 'ok'; })()`);
    await phoneWaitNav(CONNECTED, 20_000);
    log("phone: new session in rigbox");
  },
  async take(sessionId: string): Promise<void> {
    passe(`goto ${BASE}/launch.html\nwait 1.5`);
    await phoneWaitNav(`!!document.querySelector('.run-row[data-session="${sessionId}"] .take')`, 30_000);
    phoneEval(`(() => { document.querySelector('.run-row[data-session="${sessionId}"] .take').click(); return 1; })()`);
    await phoneWaitNav(CONNECTED, 150_000);
    log(`phone: took ${sessionId}`);
  },
  /** Type and send, then wait for the turn to finish (status back to idle with a reply after ours). */
  say(text: string, timeoutMs = 120_000): string {
    const before = phoneEval<number>(`liveState.messages.length`);
    phoneEval(`(() => { const ta = document.querySelector('.input-field'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('sendBtn').click(); return 1; })()`);
    const refused = phoneEval<string | null>(`new Promise(r => setTimeout(() => r((document.querySelector('.staged-error') || {}).textContent || null), 800))`);
    if (refused) { log(`phone: said ${JSON.stringify(text)} → REFUSED: ${refused}`); return `REFUSED: ${refused}`; }
    phoneAwaitReply(before, timeoutMs);
    const reply = phone.lastReply();
    log(`phone: said ${JSON.stringify(text)} → ${JSON.stringify(reply.slice(0, 200))}`);
    return reply;
  },
  /** Type and send without waiting for the reply. */
  send(text: string): void {
    phoneEval(`(() => { const ta = document.querySelector('.input-field'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('sendBtn').click(); return 1; })()`);
    log(`phone: sent ${JSON.stringify(text)}`);
  },
  /** Tap the row's button again without reloading (it reads "Take anyway" after a shell refusal). */
  async takeAgain(sessionId: string): Promise<void> {
    await phoneWaitNav(`(document.querySelector('.run-row[data-session="${sessionId}"] .take') || {}).textContent === 'Take anyway'`, 15_000);
    phoneEval(`(() => { document.querySelector('.run-row[data-session="${sessionId}"] .take').click(); return 1; })()`);
    await phoneWaitNav(CONNECTED, 150_000);
    log(`phone: took ${sessionId} anyway`);
  },
  /** Tap Take and expect the bridge to refuse: returns the launcher's note. */
  async takeRefused(sessionId: string, timeoutMs = 60_000): Promise<string> {
    passe(`goto ${BASE}/launch.html\nwait 1.5`);
    await phoneWaitNav(`!!document.querySelector('.run-row[data-session="${sessionId}"] .take')`, 30_000);
    phoneEval(`(() => { document.querySelector('.run-row[data-session="${sessionId}"] .take').click(); return 1; })()`);
    await phoneWaitNav(`document.getElementById('note').className.includes('warn')`, timeoutMs);
    const note = phoneEval<string>(`JSON.stringify(document.getElementById('note').textContent)`);
    log(`phone: take refused → ${note}`);
    return note;
  },
  lastReply(): string {
    return phoneEval<string>(`JSON.stringify((() => { const m = [...liveState.messages].reverse().find(m => m.role === 'assistant'); if (!m) return ''; return typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(' '); })())`);
  },
  read(): unknown {
    return phoneEval(`JSON.stringify({ hash: location.hash, connection: typeof liveState !== 'undefined' ? liveState.connection : null, status: typeof liveState !== 'undefined' ? liveState.status : null, ask: !!document.querySelector('.ask-option'), messages: typeof liveState === 'undefined' ? [] : liveState.messages.slice(-6).map(m => ({ role: m.role, text: (typeof m.content === 'string' ? m.content : (m.content || []).map(b => b.text || (b.type === 'tool_use' ? '[' + b.name + ']' : '')).join(' ')).slice(0, 160) })) })`);
  },
  /** Answer an AskUserQuestion overlay by option number (1-based), then send. */
  tap(n: number, timeoutMs = 90_000): string {
    phoneWait(`!!document.querySelector('.ask-option')`, 60_000);
    const before = phoneEval<number>(`liveState.messages.length`);
    phoneEval(`(() => { const o = document.querySelectorAll('.ask-option')[${n - 1}]; o.click(); const c = document.querySelector('.ask-confirm[data-visible="true"]'); if (c) c.click(); return o.dataset.label; })()`);
    phoneAwaitReply(before, timeoutMs);
    const reply = phone.lastReply();
    log(`phone: tapped option ${n} → ${JSON.stringify(reply.slice(0, 200))}`);
    return reply;
  },
  /** Stage a file through the page's own file input (DataTransfer → change), as a picker would. */
  upload(path: string): void {
    const b64 = readFileSync(path).toString("base64");
    const name = basename(path);
    phoneEval(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(name)})); const inp = document.querySelector('body > input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', {bubbles: true})); return 1; })()`);
    phoneWait(`stagedDeposits.length > 0`, 20_000);
    log(`phone: staged ${name}`);
  },
  shot(name: string): string {
    const out = join(RUN, "shots", `${Date.now()}-${name}.jpg`);
    mkdirSync(dirname(out), { recursive: true });
    passe(`screenshot --fast ${out}`);
    return out;
  },
};

// ---------- the terminal (tmux) ----------

async function answerTrust(): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const screen = tmux("capture-pane", "-p", "-t", `${TMUX}:term`);
    if (/trust this folder/i.test(screen)) {
      tmux("send-keys", "-t", `${TMUX}:term`, "Down");
      await sleep(300);
      tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
      log("term: answered the folder-trust dialog");
      return;
    }
    if (termRecord()) return;
    await sleep(300);
  }
}

const term = {
  async start(extra: string[] = []): Promise<string> {
    tmux("send-keys", "-t", `${TMUX}:term`, "-l", `BATON_DIR=${BATONS} ${join(REPO, "bin", "baton")} run --model ${MODEL} ${extra.join(" ")}`);
    tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
    await answerTrust();
    const rec = await until("the terminal claude's registry record", () => termRecord(), 45_000);
    await until("the terminal claude to be idle", () => atPrompt(termRecord()), 45_000);
    log(`term: claude up, pid ${rec.pid}, conversation ${rec.sessionId}`);
    return rec.sessionId!;
  },
  /** The placeholder alone, for a conversation Guéridon holds. */
  wait(sessionId: string): void {
    tmux("send-keys", "-t", `${TMUX}:term`, "-l", `BATON_DIR=${BATONS} ${join(REPO, "bin", "baton")} wait ${sessionId}`);
    tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
    log(`term: baton wait ${sessionId}`);
  },
  /** Type a line and submit. The TUI can swallow the first Enter sent straight after typed
   *  text (measured 30 Sep), so a second one goes if the claude has not turned busy. */
  async say(text: string, timeoutMs = 120_000): Promise<string> {
    const rec0 = await until("a terminal claude", () => termRecord(), 30_000);
    const t0 = Date.now();
    tmux("send-keys", "-t", `${TMUX}:term`, "-l", text);
    await sleep(400);
    tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
    const busy = () => { const r = termRecord(); return r && !atPrompt(r) && (r.statusUpdatedAt ?? 0) >= t0 - 500; };
    try { await until("busy", busy, 2_500, 100); } catch {
      tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
      await until("busy after a second Enter", busy, 5_000, 100);
    }
    await until("idle again", () => { const r = termRecord(); return r && atPrompt(r) && (r.statusUpdatedAt ?? 0) > t0; }, timeoutMs);
    const reply = term.lastReply();
    log(`term: said ${JSON.stringify(text)} (pid ${rec0.pid}) → ${JSON.stringify(reply.slice(0, 200))}`);
    return reply;
  },
  /** Type and submit without waiting for the reply; returns once the claude is busy. */
  async send(text: string): Promise<void> {
    const t0 = Date.now();
    tmux("send-keys", "-t", `${TMUX}:term`, "-l", text);
    await sleep(400);
    tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
    const busy = () => { const r = termRecord(); return r && !atPrompt(r) && (r.statusUpdatedAt ?? 0) >= t0 - 500; };
    try { await until("busy", busy, 2_500, 100); } catch {
      tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
      await until("busy after a second Enter", busy, 5_000, 100);
    }
    log(`term: sent ${JSON.stringify(text)} (now ${termRecord()?.status})`);
  },
  /** /exit the terminal claude; bin/baton then exits and the window is back at its shell. */
  async exit(): Promise<void> {
    tmux("send-keys", "-t", `${TMUX}:term`, "-l", "/exit");
    await sleep(400);
    tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
    await until("the terminal claude gone", () => !termRecord(), 20_000);
    log("term: /exit");
  },
  key(k: string): void {
    tmux("send-keys", "-t", `${TMUX}:term`, k);
    log(`term: key ${k}`);
  },
  read(lines = 30): string {
    return tmux("capture-pane", "-p", "-t", `${TMUX}:term`).split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
  },
  /** The last "● …" block on screen: the assistant's latest reply as the TUI shows it. */
  lastReply(): string {
    const lines = tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", `${TMUX}:term`).split("\n");
    let i = lines.map((l) => l.startsWith("●")).lastIndexOf(true);
    if (i < 0) return "";
    const out: string[] = [];
    for (; i < lines.length && !/^(❯|─{8,}|✻)/.test(lines[i]); i++) out.push(lines[i].replace(/^●\s*/, "").trim());
    return out.filter(Boolean).join(" ");
  },
  async screenHas(re: RegExp, timeoutMs = 20_000): Promise<string> {
    return until(`terminal screen to match ${re}`, () => { const s = term.read(40); return re.test(s) ? s : false; }, timeoutMs, 250);
  },
};

// ---------- the watchdog ----------

async function watchdog(): Promise<void> {
  const out = join(RUN, "watchdog.log");
  let last = "";
  const w = (l: string) => appendFileSync(out, `${now()} ${l}\n`);
  w("start");
  for (;;) {
    const byId = new Map<string, Rec[]>();
    for (const r of records()) {
      if (!r.sessionId) continue;
      byId.set(r.sessionId, [...(byId.get(r.sessionId) ?? []), r]);
    }
    const snapshot = [...byId.entries()].sort().map(([id, rs]) =>
      `${id.slice(0, 8)}=${rs.map((r) => `${r.pid}(${r.entrypoint ?? "?"})`).sort().join("+")}`).join(" ");
    if (snapshot !== last) { w(`holders ${snapshot || "(none)"}`); last = snapshot; }
    for (const [id, rs] of byId) {
      if (rs.length > 1) w(`VIOLATION ${id} held by ${rs.map((r) => `${r.pid}(${r.entrypoint})`).join(" and ")}`);
    }
    await sleep(100);
  }
}

// ---------- up / down ----------

function portOpen(): boolean {
  return spawnSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${PORT}`]).status === 0;
}

async function up(): Promise<void> {
  if (portOpen()) throw new Error(`port ${PORT} is already in use: run \`rig down\` first`);
  for (const d of [BOX, STATE, RUN]) mkdirSync(d, { recursive: true });
  if (!existsSync(join(BOX, ".git"))) {
    sh("git", ["init", "-q", BOX]);
    writeFileSync(join(BOX, "README.md"), "# rigbox\n\nScratch folder for Guéridon's test rig (scripts/rig.ts).\n");
  }
  const runStamp = now();
  writeFileSync(join(RUN, "run.json"), JSON.stringify({ startedAt: runStamp }, null, 2));
  for (const f of ["steps.log", "watchdog.log", "checks.log"]) writeFileSync(join(RUN, f), "");
  sh("tmux", ["kill-session", "-t", TMUX], { allowFail: true });
  // Windows start from the tmux server's own environment: a clean login shell, not this process's.
  tmux("new-session", "-d", "-s", TMUX, "-n", "bridge", "-c", REPO);
  const env = [
    `GUERIDON_STATE_DIR=${STATE}`, `BRIDGE_PORT=${PORT}`, `SCAN_ROOT=${join(ROOT, "no-scan")}`,
    `EXTRA_FOLDERS=${BOX}`, "GUERIDON_ENABLE_ROSTER=1", `CC_MODEL=${MODEL}`, "GUERIDON_TAKE_IDLE_MS=25000",
  ].join(" ");
  tmux("send-keys", "-t", `${TMUX}:bridge`, "-l", `${env} npx tsx server/bridge.ts > ${join(RUN, "bridge.log")} 2>&1`);
  tmux("send-keys", "-t", `${TMUX}:bridge`, "Enter");
  tmux("new-window", "-d", "-t", TMUX, "-n", "term", "-c", BOX);
  tmux("new-window", "-d", "-t", TMUX, "-n", "watchdog", "-c", REPO);
  tmux("send-keys", "-t", `${TMUX}:watchdog`, "-l", `npx tsx scripts/rig.ts watchdog`);
  tmux("send-keys", "-t", `${TMUX}:watchdog`, "Enter");
  mkdirSync(join(ROOT, "no-scan"), { recursive: true });
  await until(`the dev bridge on :${PORT}`, () => portOpen(), 30_000, 300);
  phone.open();
  log(`up: bridge :${PORT}, folder ${BOX}, tmux session '${TMUX}' (windows bridge, term, watchdog)`);
}

function down(): void {
  sh("passe", ["tabs", "close", "--matching", `localhost:${PORT}`], { allowFail: true });
  // Ctrl-C lets the bridge run its shutdown (it ends its own claude children cleanly).
  sh("tmux", ["send-keys", "-t", `${TMUX}:bridge`, "C-c"], { allowFail: true });
  sh("tmux", ["send-keys", "-t", `${TMUX}:watchdog`, "C-c"], { allowFail: true });
  const t0 = Date.now();
  while (portOpen() && Date.now() - t0 < 8_000) spawnSync("sleep", ["0.3"]);
  sh("tmux", ["kill-session", "-t", TMUX], { allowFail: true });
  log(`down: port ${PORT} ${portOpen() ? "STILL OPEN" : "closed"}`);
}

/** Back to a clean slate between loops: Guéridon's session in the folder closed, no claude
 *  in the terminal window, the window at its shell prompt. */
async function reset(): Promise<void> {
  await fetch(`${BASE}/exit/rigbox`, { method: "POST" }).catch(() => undefined);
  if (termRecord()) await term.exit();
  tmux("send-keys", "-t", `${TMUX}:term`, "C-c");
  await sleep(300);
  tmux("send-keys", "-t", `${TMUX}:term`, "-l", "clear");
  tmux("send-keys", "-t", `${TMUX}:term`, "Enter");
  await until("no claude left in the rig folder", () => records().length === 0, 20_000);
  passe(`goto ${BASE}/launch.html\nwait 1`);
  log("reset: folder clear");
}

// ---------- checks and the report ----------

/** The transcript's surface sequence: entrypoint runs collapsed, e.g. cli → sdk-cli → cli. */
function surfaces(sessionId: string): string[] {
  const f = join(PROJECT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(f)) return [];
  const seq: string[] = [];
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if ((e.type === "user" || e.type === "assistant") && e.entrypoint && seq[seq.length - 1] !== e.entrypoint) seq.push(e.entrypoint);
    } catch { /* torn tail */ }
  }
  return seq;
}

function violations(): string[] {
  try { return readFileSync(join(RUN, "watchdog.log"), "utf-8").split("\n").filter((l) => l.includes("VIOLATION")); } catch { return []; }
}

function check(label: string, ok: boolean, detail = ""): boolean {
  log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  appendFileSync(join(RUN, "checks.log"), `${ok ? "PASS" : "FAIL"}\t${label}\t${detail}\n`);
  return ok;
}

function report(): string {
  const dir = join(HOME, "scratch", "gueridon-rig");
  mkdirSync(dir, { recursive: true });
  const read = (f: string) => { try { return readFileSync(join(RUN, f), "utf-8"); } catch { return ""; } };
  const convs = existsSync(PROJECT_DIR) ? readdirSync(PROJECT_DIR).filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ id: n.replace(".jsonl", ""), mtime: statSync(join(PROJECT_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 6) : [];
  const shots = existsSync(join(RUN, "shots")) ? readdirSync(join(RUN, "shots")).sort() : [];
  const v = violations();
  const md = [
    `# Guéridon rig run — ${now()}`,
    "",
    `**One-writer watchdog:** ${v.length === 0 ? "no violations" : `${v.length} VIOLATION line(s)`}`,
    "",
    "## Checks",
    "", "```", read("checks.log").trim() || "(none)", "```",
    "",
    "## Conversations in rigbox (newest first) and the surfaces each transcript passed through",
    "",
    ...convs.map((c) => `- \`${c.id}\`: ${surfaces(c.id).join(" → ") || "(no turns)"}`),
    "",
    "## Steps", "", "```", read("steps.log").trim(), "```",
    "",
    "## Watchdog (who held each conversation, as it changed)", "", "```", read("watchdog.log").trim(), "```",
    "",
    "## Screenshots", "",
    ...shots.map((s) => `- ${join(RUN, "shots", s)}`),
    "",
  ].join("\n");
  const out = join(dir, `${now().slice(0, 16).replace(/[:T]/g, "-")}.md`);
  writeFileSync(out, md);
  return out;
}

// ---------- the loops ----------

/** Wait until the terminal window shows the placeholder, i.e. the take landed there. */
async function placeholderShown(): Promise<void> {
  await term.screenHas(/In Guéridon since/, 20_000);
}

async function loopA(): Promise<void> {
  await reset();
  log("=== LOOP A: start in the terminal, take it in Guéridon, hand it back ===");
  const id = await term.start();
  const r1 = await term.say("Remember the word PAMPLEMOUSSE. Reply with just: noted.");
  check("A1 terminal replies", /noted/i.test(r1), r1);
  await term.say("Reply with a markdown table of three fruits and their colours, then a python code block that prints the first one. Nothing else.");

  await phone.take(id);
  await placeholderShown();
  check("A2 placeholder in the terminal after the take", true);
  phone.shot("a-taken");
  const r2 = phone.say("What word did I ask you to remember? One word.");
  check("A3 Guéridon remembers the terminal's context", /pamplemousse/i.test(r2), r2);
  const hist = JSON.stringify(phone.read());
  check("A4 phone shows the terminal's table turn in its history", /fruit|colou?r/i.test(hist), hist.slice(0, 200));

  // An AskUserQuestion on the phone: buttons, tapped.
  phone.say("Use the AskUserQuestion tool to ask me to pick a colour: Red, Green or Blue. After I answer, reply with just the colour.", 120_000);
  const r3 = phone.tap(2);
  check("A5 phone AskUserQuestion answered by tapping", /green/i.test(r3), r3);

  // A file from the phone.
  const f = join(RUN, "note.txt");
  writeFileSync(f, "The secret number is 4417.\n");
  phone.upload(f);
  const r4 = phone.say("Read the file I just attached and tell me the secret number. Just the number.");
  check("A6 phone upload reaches the model", /4417/.test(r4), r4);
  phone.shot("a-phone-turns");

  // A message from the phone is refused once the terminal has it back.
  term.key("R");
  await until("the terminal claude back", () => atPrompt(termRecord()), 60_000);
  check("A7 R hands it back to the terminal", true);
  const r5 = await term.say("What secret number did the file say, and which colour did I pick? One line.");
  check("A8 terminal sees the Guéridon turns", /4417/.test(r5) && /green/i.test(r5), r5);
  passe(`goto ${BASE}/#rigbox\nwait 2`);
  const refused = phone.say("This should be refused.");
  check("A9 phone refuses while the terminal holds it", refused.startsWith("REFUSED"), refused);
  check("A10 one transcript, surfaces cli → sdk-cli → cli", surfaces(id).join(" → ") === "cli → sdk-cli → cli", surfaces(id).join(" → "));
  check("A11 watchdog saw no two writers", violations().length === 0, violations().join("; "));
  await term.exit();
}

async function loopB(): Promise<void> {
  await reset();
  log("=== LOOP B: start in Guéridon, take it in the terminal, hand it back ===");
  await phone.new();
  const r1 = phone.say("Remember the word MANGO. Reply with just: noted.");
  check("B1 Guéridon replies", /noted/i.test(r1), r1);
  const id = await until("Guéridon's conversation id", () => records().find((r) => r.entrypoint === "sdk-cli")?.sessionId, 20_000);
  phone.say("Give me a three-item checklist for making tea as a markdown task list (- [ ] …). Nothing else.");

  term.wait(id);
  await term.screenHas(/press R to take it back/, 15_000);
  check("B2 the terminal's placeholder sees Guéridon holding it", true);
  term.key("R");
  await until("the terminal claude on the conversation", () => { const r = termRecord(); return r?.sessionId === id && atPrompt(r); }, 90_000);
  check("B3 R takes it into the terminal", true);
  const pageAfter = phoneEval<{ hash: string }>(`JSON.stringify({ hash: location.hash })`);
  check("B4 the phone page was sent home", pageAfter.hash !== "#rigbox", JSON.stringify(pageAfter));
  const r2 = await term.say("What word did I ask you to remember? One word.");
  check("B5 terminal remembers Guéridon's context", /mango/i.test(r2), r2);
  await term.say("Run the shell command `echo rig-$((6*7))` and tell me its output. Just the output.");

  await phone.take(id);
  await placeholderShown();
  check("B6 Guéridon takes it back; placeholder in the terminal", true);
  const r3 = phone.say("What did the shell command print? Just the output.");
  check("B7 Guéridon sees the terminal's tool turn", /rig-42/.test(r3), r3);
  phone.shot("b-back-in-gueridon");
  term.key("R");
  await until("the terminal claude back", () => termRecord()?.sessionId === id && atPrompt(termRecord()), 60_000);
  const r4 = await term.say("Which fruit word and which tea steps came up earlier? One line.");
  check("B8a terminal still has the whole conversation", /mango/i.test(r4) && /boil|steep/i.test(r4), r4);
  check("B8 surfaces sdk-cli → cli → sdk-cli → cli", surfaces(id).join(" → ") === "sdk-cli → cli → sdk-cli → cli", surfaces(id).join(" → "));
  check("B9 watchdog saw no two writers", violations().length === 0, violations().join("; "));
}

// ---------- the hard cases (gdn-cefuda) ----------

function bridgeEvents(type: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(RUN, "bridge.log"), "utf-8").split("\n")
      .filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Every assistant text block in a conversation's transcript, in order. */
function assistantTexts(sessionId: string): string[] {
  const f = join(PROJECT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(f)) return [];
  const out: string[] = [];
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type !== "assistant") continue;
      for (const b of e.message?.content ?? []) if (b.type === "text" && b.text) out.push(b.text);
    } catch { /* torn */ }
  }
  return out;
}

async function backToTerminal(id: string): Promise<void> {
  term.key("R");
  await until("the terminal claude back", () => { const r = termRecord(); return r?.sessionId === id && atPrompt(r); }, 120_000);
}

/** C1 take mid-reply, and C2 a release while a phone message is queued. */
async function hardC1C2(): Promise<void> {
  await reset();
  log("=== C1: take while the terminal is mid-reply ===");
  const id = await term.start();
  await term.say("Remember the word BANANA. Reply with just: noted.");
  await term.send("Run the shell command `sleep 12; echo done-c1` and then tell me its output. Just the output.");
  const takes0 = bridgeEvents("baton:take").length;
  await phone.take(id);
  const take = bridgeEvents("baton:take").slice(takes0).pop() ?? {};
  check("C1a the take waited for the reply to finish", Number(take.waitedMs) >= 5_000, `waitedMs=${take.waitedMs}`);
  check("C1b the terminal's reply finished before the stop", assistantTexts(id).some((t) => /done-c1/.test(t)), assistantTexts(id).slice(-1).join(""));
  const r1 = phone.say("What did the shell command print? Just the output.");
  check("C1c Guéridon has the finished turn", /done-c1/.test(r1), r1);

  log("=== C2: release while a phone message is queued behind a running turn ===");
  phone.send("Run the shell command `sleep 8; echo first-c2` and tell me its output. Just the output.");
  phoneWait(`liveState.status !== 'idle'`, 20_000);
  phone.send("Now reply with exactly: QUEUED-TWO");
  await sleep(500);
  const rel0 = Date.now();
  await backToTerminal(id);
  log(`C2: release took ${Date.now() - rel0} ms`);
  const texts = assistantTexts(id);
  // Measured 2026-09-30 on 2.1.285: CC does not queue a mid-turn message as a turn of its own;
  // it folds it into the running turn (queue-operation enqueue → remove), and the model then
  // answers the newest message. So "finished" means the command ran, not that it was reported.
  const raw = readFileSync(join(PROJECT_DIR, `${id}.jsonl`), "utf-8");
  check("C2a the running phone turn finished (its command ran)", /first-c2/.test(raw), "");
  check("C2b the queued phone message was answered, not cut off", texts.some((t) => /QUEUED-TWO/.test(t)), texts.slice(-2).join(" | "));
  const r2 = await term.say("List every reply you gave me since BANANA, one per line, nothing else.");
  log(`C2: terminal's view of the history → ${JSON.stringify(r2)}`);
  check("C2c no two writers", violations().length === 0, violations().join("; "));
}

/** C3 a background shell running at a take. */
async function hardC3(): Promise<void> {
  await reset();
  log("=== C3: background shell running at the take ===");
  const id = await term.start();
  await term.say("Use the Bash tool with run_in_background set to true to run `sleep 300; echo bg-finished`. Then reply with just: started.");
  const rec = termRecord();
  log(`C3: terminal registry status with the background shell: ${rec?.status}`);
  const bgBefore = sh("pgrep", ["-f", "^sleep 300$"], { allowFail: true }).trim();
  check("C3a the background shell is running before the take", bgBefore !== "", `pids ${bgBefore || "none"}`);
  const note = await phone.takeRefused(id, 30_000);
  check("C3b0 the take stops and says a background shell would end", /background shell/i.test(note), note);
  check("C3b1 the refused take left the terminal and its shell alone", !!termRecord() && sh("pgrep", ["-f", "^sleep 300$"], { allowFail: true }).trim() !== "", "");
  await phone.takeAgain(id);
  await sleep(1_000);
  const bgAfter = sh("pgrep", ["-f", "^sleep 300$"], { allowFail: true }).trim();
  log(`C3: background sleep after the take: ${bgAfter || "gone"}`);
  const r = phone.say("Earlier you started a background shell task (sleep 300). Is it still running? Check with your tools, then answer in one line.");
  log(`C3: Guéridon's claude on the background task → ${JSON.stringify(r)}`);
  check("C3b the registry named the background shell before the take (status 'shell')", rec?.status === "shell", `status=${rec?.status}`);
  check("C3c Take anyway ends the terminal's background shell, as the warning said", bgAfter === "", bgAfter);
  // Only the pids this scenario saw start, never a pattern kill.
  for (const pid of bgAfter.split(/\s+/).filter((p) => bgBefore.split(/\s+/).includes(p))) {
    try { process.kill(parseInt(pid, 10), "SIGTERM"); } catch { /* gone */ }
  }
  await backToTerminal(id);
}

/** C4 a permission prompt waiting at a take, and C5 a slash command on the phone after a move. */
async function hardC4C5(): Promise<void> {
  await reset();
  log("=== C4: a permission dialog is up when the take is asked for ===");
  // An `ask` rule forces a dialog for one harmless command: the home allows all of Bash, Read,
  // Write and Edit, and denies WebFetch/TodoWrite/NotebookEdit outright, so no built-in tool asks.
  const id = await term.start(["--permission-mode", "default", "--settings", `'{"permissions":{"ask":["Bash(echo rig-ask*)"]}}'`]);
  await term.say("Remember the word CHERRY. Reply with just: noted.");
  await term.send("Run the shell command `echo rig-ask-c4` with the Bash tool and tell me its output.");
  await until("the permission dialog (registry status waiting)", () => termRecord()?.status === "waiting", 60_000);
  const note = await phone.takeRefused(id, 60_000);
  check("C4a a take refuses while the permission dialog waits, and says why", /dialog is waiting in the terminal/i.test(note), note);
  check("C4b the terminal claude is untouched by the refused take", termRecord()?.sessionId === id, `status=${termRecord()?.status}`);
  term.key("Escape");
  await until("idle after declining", () => atPrompt(termRecord()), 30_000);
  await phone.take(id);
  const gArgs = () => { const g = records().find((r) => r.entrypoint === "sdk-cli"); return g ? readFileSync(`/proc/${g.pid}/cmdline`, "utf-8").split("\0") : []; };
  const r1 = phone.say("What word did I ask you to remember? One word.");
  check("C4c Guéridon has the conversation", /cherry/i.test(r1), r1);
  const args = gArgs();
  const mode = args[args.indexOf("--permission-mode") + 1];
  check("C4d G inherited the conversation's mode (default)", mode === "default", `--permission-mode ${args.includes("--permission-mode") ? mode : "(none)"}`);
  const r2 = phone.say("Earlier the command `echo rig-ask-c4` was declined. Run it again now with the Bash tool and tell me its output, or say exactly what stopped you.");
  log(`C4: G's retry of the declined tool → ${JSON.stringify(r2)}`);
  check("C4e G answers about the declined tool instead of hanging on a dialog it cannot show", r2.length > 0, r2);

  log("=== C5: a slash command on the phone after the move ===");
  const before = phoneEval<number>(`liveState.messages.length`);
  phone.send("/context");
  await sleep(8_000);
  const after = phone.read() as { messages: { role: string; text: string }[] };
  log(`C5: after /context the page shows → ${JSON.stringify(after.messages.slice(-2)).slice(0, 400)}`);
  const shown = JSON.stringify(after.messages.slice(-2));
  check("C5 /context on the phone shows its output", phoneEval<number>(`liveState.messages.length`) > before && /Context Usage|Tokens:/i.test(shown), shown.slice(0, 200));
  phone.shot("c5-context");
  await backToTerminal(id);
  try { sh("rm", ["-f", join(BOX, "perm-test.txt")]); } catch { /* fine */ }
}

/** C6 a longer conversation across three moves: every fact survives, the page's history
 *  matches the transcript, and the context gauge reads after replay. */
async function hardC6(): Promise<void> {
  await reset();
  log("=== C6: eight facts across three moves ===");
  const facts = ["ALPHA-11", "BRAVO-22", "CHARLIE-33", "DELTA-44", "ECHO-55", "FOXTROT-66", "GOLF-77", "HOTEL-88"];
  const tell = (i: number) => `Fact ${i + 1} is ${facts[i]}. Reply with just: ok.`;
  const id = await term.start();
  await term.say(tell(0)); await term.say(tell(1));
  await phone.take(id);
  phone.say(tell(2)); phone.say(tell(3));
  await backToTerminal(id);
  await term.say(tell(4)); await term.say(tell(5));
  await phone.take(id);
  phone.say(tell(6)); phone.say(tell(7));
  const all = phone.say("List facts 1 to 8, one per line, nothing else.");
  const missing = facts.filter((f) => !all.includes(f));
  check("C6a all eight facts survive three moves", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : all.replace(/\n/g, " "));
  const pageUsers = phoneEval<number>(`liveState.messages.filter(m => m.role === 'user').length`);
  const f = join(PROJECT_DIR, `${id}.jsonl`);
  const tUsers = readFileSync(f, "utf-8").split("\n").filter((l) => { try { const e = JSON.parse(l); return e.type === "user" && typeof e.message?.content === "string" && !e.isMeta; } catch { return false; } }).length;
  check("C6b the page's history has every user turn the transcript has", pageUsers === tUsers, `page ${pageUsers}, transcript ${tUsers}`);
  // The phone tab sits in the background, where Chrome runs no requestAnimationFrame, so the
  // page's DOM render lags its state; read the state (a screenshot forces a frame if needed).
  const pct = phoneEval<number | null>(`liveState.session && liveState.session.context_pct`);
  check("C6c the context gauge has a reading after the moves", typeof pct === "number" && pct > 0, `context_pct=${pct}`);
  check("C6d surfaces cli → sdk-cli → cli → sdk-cli", surfaces(id).join(" → ") === "cli → sdk-cli → cli → sdk-cli", surfaces(id).join(" → "));
  check("C6e no two writers", violations().length === 0, violations().join("; "));
  await backToTerminal(id);
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const [verb, sub, ...rest] = process.argv.slice(2);
  const arg = [sub, ...rest].filter(Boolean).join(" ");
  switch (verb) {
    case "up": return up();
    case "down": return down();
    case "watchdog": return watchdog();
    case "report": console.log(report()); return;
    case "reset": return reset();
    case "status": console.log(JSON.stringify({ records: records(), batons: batons() }, null, 2)); return;
    case "loop":
      if (sub === "a") await loopA();
      else if (sub === "b") await loopB();
      else if (sub === "c1") await hardC1C2();
      else if (sub === "c3") await hardC3();
      else if (sub === "c4") await hardC4C5();
      else if (sub === "c6") await hardC6();
      else if (sub === "hard") { for (const f of [hardC1C2, hardC3, hardC4C5, hardC6]) { try { await f(); } catch (err) { log(`ERROR ${err instanceof Error ? err.message : String(err)}`); } } }
      else throw new Error("loop a|b|c1|c3|c4|c6|hard");
      console.log(report());
      return;
    case "phone": {
      const a = rest.join(" ");
      switch (sub) {
        case "open": return phone.open();
        case "new": return phone.new();
        case "take": return phone.take(a);
        case "say": console.log(phone.say(a)); return;
        case "read": console.log(JSON.stringify(phone.read(), null, 2)); return;
        case "tap": console.log(phone.tap(parseInt(a, 10))); return;
        case "upload": return phone.upload(a);
        case "shot": console.log(phone.shot(a || "shot")); return;
      }
      break;
    }
    case "term": {
      const a = rest.join(" ");
      switch (sub) {
        case "start": console.log(await term.start()); return;
        case "wait": return term.wait(a);
        case "say": console.log(await term.say(a)); return;
        case "key": return term.key(a);
        case "read": console.log(term.read()); return;
        case "idle": await until("idle", () => atPrompt(termRecord())); return;
      }
      break;
    }
  }
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(1, 12).join("\n"));
  process.exitCode = 2;
  void arg;
}

main().catch((err) => { log(`ERROR ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; });
