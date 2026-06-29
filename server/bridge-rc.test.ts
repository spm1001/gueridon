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
  rcSessions,
} from "./bridge.ts";

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
