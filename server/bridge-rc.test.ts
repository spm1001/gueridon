/**
 * Future-B RC launcher handler tests (gdn-towiva).
 *
 * The launcher path (spawnRemoteControl / handleLaunch / handleRcExit) shipped verified
 * LIVE only — this covers it so a refactor (or gdn-deloce's deletion of the streaming half)
 * can't break it silently. We import bridge.ts directly: its main-guard (IS_ENTRYPOINT) means
 * importing does NOT boot the server or run reapOrphans against shared ~/.config/gueridon state.
 * node-pty is mocked so nothing spawns a real `claude`; push.js is mocked so the URL-capture
 * path doesn't reach into web-push/VAPID.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { ServerResponse } from "node:http";

// Mocked node-pty: each spawn returns a fake pty that records its args/opts, exposes kill,
// and auto-emits a claude.ai URL line on onData registration so waitForRcUrl resolves at once.
const ptyMock = vi.hoisted(() => {
  let last: {
    pid: number; file: string; args: string[]; opts: { env: Record<string, string> };
    kill: ReturnType<typeof vi.fn>; fireExit: (code?: number) => void;
  } | null = null;
  const spawn = vi.fn((file: string, args: string[], opts: { env: Record<string, string> }) => {
    const exitCbs: ((e: { exitCode: number }) => void)[] = [];
    const pty = {
      pid: 4242,
      file,
      args,
      opts,
      onData: (cb: (d: string) => void) => {
        // ANSI-wrapped URL line, like the real "/remote-control is active" output.
        cb("[2m/remote-control is active · https://claude.ai/code/session_TEST123[0m\n");
      },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCbs.push(cb); },
      kill: vi.fn(),
      fireExit: (code = 0) => exitCbs.forEach((c) => c({ exitCode: code })),
    };
    last = pty;
    return pty;
  });
  return { spawn, getLast: () => last };
});
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Stub push.js so the URL-capture path doesn't touch web-push/VAPID/files.
vi.mock("./push.js", () => ({
  pushLaunchReady: vi.fn(async () => {}),
  pushTurnComplete: vi.fn(async () => {}),
  pushAskUser: vi.fn(async () => {}),
  getVapidPublicKey: vi.fn(() => null),
  addSubscription: vi.fn(),
  removeSubscription: vi.fn(),
}));

import {
  spawnRemoteControl,
  handleLaunch,
  handleRcExit,
  handleSessionEnd,
  rcSessions,
} from "./bridge.ts";
import { isLiveClaudePid } from "./sessions.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { pushLaunchReady } from "./push.js"; // the vi.mock above replaces this

// Minimal ServerResponse stand-in: captures status + body, supports writeHead().end() chaining.
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
  };
  return res;
}

/** Cast the mock to ServerResponse at the handler boundary (reads stay typed on the mock). */
const asRes = (r: ReturnType<typeof makeRes>) => r as unknown as ServerResponse;

const tmpDirs: string[] = [];
function tmpRepo(withBon: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "gdn-rc-"));
  tmpDirs.push(dir);
  if (withBon) mkdirSync(join(dir, ".bon"), { recursive: true });
  return dir;
}

beforeEach(() => {
  rcSessions.clear();
  ptyMock.spawn.mockClear();
  vi.mocked(pushLaunchReady).mockClear();
});

afterEach(() => {
  rcSessions.clear();
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("spawnRemoteControl (gdn-difoto/gdn-cumado)", () => {
  it("appends the initial prompt to the pty args and marks autoPrompted", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open");
    expect(ptyMock.getLast()?.file).toBe("claude");
    expect(ptyMock.getLast()?.args).toEqual(["--remote-control", basename(dir), "/open"]);
    expect(rc.autoPrompted).toBe(true);
  });

  it("spawns bare (no prompt) and marks autoPrompted false", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir);
    expect(ptyMock.getLast()?.args).toEqual(["--remote-control", basename(dir)]);
    expect(rc.autoPrompted).toBe(false);
  });

  it("registers the session in rcSessions and captures the claude.ai URL", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open");
    expect(rcSessions.get(dir)).toBe(rc);
    expect(rc.url).toBe("https://claude.ai/code/session_TEST123");
  });

  it("is idempotent per folder — second call returns the same session, no second spawn", () => {
    const dir = tmpRepo(false);
    const first = spawnRemoteControl(dir, "/open");
    const second = spawnRemoteControl(dir, "/open");
    expect(second).toBe(first);
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
  });

  it("strips the Vertex env so the session comes up on Teams (gdn-rosara)", () => {
    const prev = process.env.CLAUDE_CODE_USE_VERTEX;
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    try {
      const dir = tmpRepo(false);
      spawnRemoteControl(dir, "/open");
      expect(ptyMock.getLast()?.opts.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
      else process.env.CLAUDE_CODE_USE_VERTEX = prev;
    }
  });
});

describe("handleLaunch (gdn-cumado)", () => {
  it("auto-/opens a repo WITH .bon (autoOpened true)", async () => {
    const dir = tmpRepo(true);
    const res = makeRes();
    await handleLaunch(dir, asRes(res));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(ptyMock.getLast()?.args).toEqual(["--remote-control", basename(dir), "/open"]);
    expect(body.autoOpened).toBe(true);
    expect(body.status).toBe("launched");
    expect(body.url).toBe("https://claude.ai/code/session_TEST123");
  });

  it("spawns BARE for a repo without .bon (autoOpened false, ready true)", async () => {
    const dir = tmpRepo(false);
    const res = makeRes();
    await handleLaunch(dir, asRes(res));
    const body = JSON.parse(res.body);
    expect(ptyMock.getLast()?.args).toEqual(["--remote-control", basename(dir)]);
    expect(body.autoOpened).toBe(false);
    expect(body.ready).toBe(true);
  });

  it("is idempotent — an already-running session returns its url without respawning", async () => {
    const dir = tmpRepo(true);
    const first = spawnRemoteControl(dir, "/open");
    ptyMock.spawn.mockClear();
    const res = makeRes();
    await handleLaunch(dir, asRes(res));
    const body = JSON.parse(res.body);
    expect(body.status).toBe("already-running");
    expect(body.pid).toBe(first.pid);
    expect(body.url).toBe(first.url);
    expect(ptyMock.spawn).not.toHaveBeenCalled();
  });
});

describe("handleRcExit (gdn-rilope/gdn-mupito)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("404s when no session is running for the folder", () => {
    const res = makeRes();
    handleRcExit("/no/such/folder", asRes(res));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/no running session/i);
  });

  it("SIGTERMs the pty and returns 200 exiting", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open");
    const res = makeRes();
    handleRcExit(dir, asRes(res));
    expect(rc.pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).exiting).toBe(true);
  });

  it("escalates to SIGKILL after the 8s grace if still alive (SIGHUP would be survived)", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open");
    handleRcExit(dir, asRes(makeRes()));
    expect(rc.pty.kill).toHaveBeenCalledWith("SIGTERM");
    expect(rc.pty.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.advanceTimersByTime(8000);
    expect(rc.pty.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does NOT SIGKILL if the session already exited within the grace window", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open");
    handleRcExit(dir, asRes(makeRes()));
    rcSessions.delete(dir); // simulate onExit cleanup before the grace timer fires
    vi.advanceTimersByTime(8000);
    expect(rc.pty.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});

describe("launch-push gating (gdn-nagepa)", () => {
  it("does NOT push for a launcher launch (pushOnReady defaults false), despite no SSE client", () => {
    const dir = tmpRepo(false);
    spawnRemoteControl(dir, "/open"); // URL is auto-captured by the pty mock
    expect(vi.mocked(pushLaunchReady)).not.toHaveBeenCalled();
  });

  it("DOES push the captured URL for a phone-in-pocket launch (pushOnReady true, no SSE client)", () => {
    const dir = tmpRepo(false);
    const rc = spawnRemoteControl(dir, "/open", true);
    expect(vi.mocked(pushLaunchReady)).toHaveBeenCalledWith(basename(dir), rc.url);
  });

  it("handleLaunch (launcher) never pushes", async () => {
    const dir = tmpRepo(true);
    await handleLaunch(dir, asRes(makeRes()));
    expect(vi.mocked(pushLaunchReady)).not.toHaveBeenCalled();
  });
});

// End-a-foreign-session by pid (gdn-racuca). A real spawned child stands in for a foreign
// `claude` session: setting `process.title = "claude"` makes /proc/<pid>/comm read "claude",
// so isLiveClaudePid (and thus handleSessionEnd) treat it exactly like a real session — no
// mocking of /proc. Each test kills its child in cleanup.
const fakeClaudes: ChildProcess[] = [];
function spawnFakeClaude(): ChildProcess {
  // Sets comm to "claude" and idles until signalled.
  const child = spawn(process.execPath, ["-e", "process.title='claude';setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  fakeClaudes.push(child);
  return child;
}
async function waitFor(cond: () => Promise<boolean> | boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

afterEach(() => {
  for (const c of fakeClaudes.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
});

describe("isLiveClaudePid (gdn-racuca guard)", () => {
  it("fails closed for pid 0, 1 and a non-existent pid", async () => {
    expect(await isLiveClaudePid(0)).toBe(false);
    expect(await isLiveClaudePid(1)).toBe(false);
    expect(await isLiveClaudePid(2147480000)).toBe(false); // no such process
    expect(await isLiveClaudePid(NaN)).toBe(false);
  });

  it("is false for a live process whose comm is NOT claude (the test runner itself)", async () => {
    // process.pid here is node/vitest — comm !== "claude", so it must never be signallable.
    expect(await isLiveClaudePid(process.pid)).toBe(false);
  });

  it("is true for a live process whose comm IS claude", async () => {
    const child = spawnFakeClaude();
    expect(await waitFor(() => isLiveClaudePid(child.pid!))).toBe(true);
  });
});

describe("handleSessionEnd (gdn-racuca)", () => {
  it("404s a pid that is not a live claude session (fail-closed, no signal sent)", async () => {
    const res = makeRes();
    await handleSessionEnd(process.pid, asRes(res)); // node, not claude
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("No live claude session");
  });

  it("SIGTERMs a real claude-comm process and returns { ending: true }", async () => {
    const child = spawnFakeClaude();
    expect(await waitFor(() => isLiveClaudePid(child.pid!))).toBe(true);

    const res = makeRes();
    await handleSessionEnd(child.pid!, asRes(res));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ending: true, pid: child.pid });

    // SIGTERM (no handler in the child) terminates it — the graceful default action.
    const died = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve(true);
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(died).toBe(true);
    expect(await isLiveClaudePid(child.pid!)).toBe(false);
  });
});
