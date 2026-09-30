/**
 * bin/baton end to end, against a fake claude and a fake Guéridon: the terminal half of the
 * session baton (gdn-tamose). The batons Guéridon's side writes here come from the real
 * server/baton.ts, so this also binds the bash reader to the TypeScript writer's format.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBaton, writeBaton } from "../server/baton.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "baton");
const ID = "0c6f6a8e-2d4b-4a57-9d51-3f1f5f0b7a11";
const ID2 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

// A claude that logs its args; on its first run it waits for the test to "take" it (the test
// writes Guéridon's baton, then touches `go`), and exits 143 as claude does on SIGTERM.
const FAKE_CLAUDE = `#!/usr/bin/env bash
echo "$*" >> "$LOG"
if [[ $(wc -l < "$LOG") == 1 ]]; then
  for _ in $(seq 100); do [[ -f "$GO" ]] && exit 143; sleep 0.05; done
  exit 99
fi
exit 0
`;

let child: ChildProcess | null = null;
let server: Server | null = null;
afterEach(() => { child?.kill("SIGKILL"); child = null; server?.close(); server = null; });

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start `baton run --session-id ID` against a fake claude, then have "Guéridon" take the
 *  conversation `takeId` (ID2 = the terminal had moved to another id with /clear). */
async function setup(releaseStatus: number, takeId = ID) {
  const dir = mkdtempSync(join(tmpdir(), "baton-sh-"));
  const bdir = join(dir, "batons");
  const log = join(dir, "claude.log");
  const go = join(dir, "go");
  const fake = join(dir, "claude");
  writeFileSync(fake, FAKE_CLAUDE); chmodSync(fake, 0o755);
  const releases: { url: string; body: string }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      releases.push({ url: req.url!, body });
      // The real bridge hands the baton back before it answers 200.
      if (releaseStatus === 200) writeBaton(bdir, { ...readBaton(bdir, takeId)!, holder: "terminal", release: null, pid: null });
      res.writeHead(releaseStatus).end(JSON.stringify(releaseStatus === 200 ? { ended: true } : { error: "Guéridon is still mid-reply" }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  let stderr = "";
  child = spawn("bash", [SCRIPT, "run", "--session-id", ID], {
    env: { ...process.env, BATON_DIR: bdir, BATON_CLAUDE: fake, LOG: log, GO: go, TMUX_PANE: "%9" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const exited = new Promise<number | null>((r) => child!.on("exit", (code) => r(code)));
  // claude is running: the terminal holds the baton
  await until(() => existsSync(log));
  expect(readBaton(bdir, ID)).toMatchObject({ holder: "terminal", pane: "%9", wrapper: child.pid });
  // Guéridon takes it: baton first (naming the wrapper it found as claude's parent), then
  // the signal (here, `go`)
  writeBaton(bdir, {
    v: 1, sessionId: takeId, holder: "gueridon", since: new Date().toISOString(), pid: null,
    cwd: dir, pane: "%9", release: { url: `http://127.0.0.1:${port}` }, takenFrom: 1234, wrapper: child.pid!,
  });
  writeFileSync(go, "");
  await until(() => stderr.includes("In Guéridon since"));
  return { bdir, log, releases, exited, stderr: () => stderr, port };
}

describe("bin/baton", () => {
  it("taken → placeholder → R releases Guéridon and resumes the same conversation here", async () => {
    const t = await setup(200);
    child!.stdin!.write("R");
    expect(await t.exited).toBe(0);
    const runs = readFileSync(t.log, "utf-8").trim().split("\n");
    expect(runs).toEqual([`--session-id ${ID}`, `--resume ${ID}`]);
    expect(t.releases).toHaveLength(1);
    expect(t.releases[0].url).toBe(`/release/${ID}`);
    expect(JSON.parse(t.releases[0].body)).toEqual({ pane: "%9" });
    expect(readBaton(t.bdir, ID)).toMatchObject({ holder: "terminal" });
  });

  it("a refused release starts no second claude; q leaves the conversation in Guéridon", async () => {
    const t = await setup(409);
    child!.stdin!.write("R");
    await until(() => t.stderr().includes("did not let go"));
    child!.stdin!.write("q");
    expect(await t.exited).toBe(0);
    expect(readFileSync(t.log, "utf-8").trim().split("\n")).toEqual([`--session-id ${ID}`]);
    expect(readBaton(t.bdir, ID)).toMatchObject({ holder: "gueridon" });
  });

  it("follows the conversation when the terminal had moved to another id (/clear) before the take", async () => {
    const t = await setup(200, ID2);
    child!.stdin!.write("R");
    expect(await t.exited).toBe(0);
    expect(readFileSync(t.log, "utf-8").trim().split("\n")).toEqual([`--session-id ${ID}`, `--resume ${ID2}`]);
    expect(t.releases.map((r) => r.url)).toEqual([`/release/${ID2}`]);
  });

  it("refuses to start claude when Guéridon answers that it still holds the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-sh-"));
    const bdir = join(dir, "b");
    const log = join(dir, "claude.log");
    const fake = join(dir, "claude");
    writeFileSync(fake, FAKE_CLAUDE); chmodSync(fake, 0o755);
    server = createServer((_req, res) => res.writeHead(409).end('{"error":"Guéridon is still mid-reply"}'));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    // pid null: the case where a stale baton pid used to let the script take anyway
    writeBaton(bdir, { v: 1, sessionId: ID, holder: "gueridon", since: new Date().toISOString(), pid: null, cwd: dir, pane: null, release: { url: `http://127.0.0.1:${port}` } });
    const p = spawn("bash", [SCRIPT, "run", "--resume", ID], { env: { ...process.env, BATON_DIR: bdir, BATON_CLAUDE: fake, LOG: log, GO: join(dir, "go") }, stdio: "ignore" });
    expect(await new Promise((r) => p.on("exit", r))).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(readBaton(bdir, ID)).toMatchObject({ holder: "gueridon" });
  });

  it("takes a conversation whose Guéridon is gone (no answer) and holds no live claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-sh-"));
    const bdir = join(dir, "b");
    const fake = join(dir, "claude");
    writeFileSync(fake, "#!/usr/bin/env bash\necho \"$*\" > \"$LOG\"\n"); chmodSync(fake, 0o755);
    writeBaton(bdir, { v: 1, sessionId: ID, holder: "gueridon", since: new Date().toISOString(), pid: 999999, cwd: dir, pane: null, release: { url: "http://127.0.0.1:9" } });
    const log = join(dir, "claude.log");
    const p = spawn("bash", [SCRIPT, "run", "--resume", ID], { env: { ...process.env, BATON_DIR: bdir, BATON_CLAUDE: fake, LOG: log }, stdio: "ignore" });
    expect(await new Promise((r) => p.on("exit", r))).toBe(0);
    expect(readFileSync(log, "utf-8").trim()).toBe(`--resume ${ID}`);
    expect(readBaton(bdir, ID)).toMatchObject({ holder: "terminal" });
  });

  it("a claude that simply exits (not taken) ends the script with claude's exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-sh-"));
    const fake = join(dir, "claude");
    writeFileSync(fake, "#!/usr/bin/env bash\nexit 7\n"); chmodSync(fake, 0o755);
    const p = spawn("bash", [SCRIPT, "run"], { env: { ...process.env, BATON_DIR: join(dir, "b"), BATON_CLAUDE: fake }, stdio: "ignore" });
    expect(await new Promise((r) => p.on("exit", r))).toBe(7);
  });
});
