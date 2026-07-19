import { describe, it, expect } from "vitest";
import { isDaemonCmdline } from "./sessions.js";

// /proc/<pid>/cmdline is NUL-separated argv. Helper to build one from tokens.
const cmd = (...argv: string[]) => argv.join("\0") + "\0";

describe("isDaemonCmdline (gdn-mimije — keep the CC daemon out of the roster)", () => {
  it("is TRUE for the daemon (the observed leak)", () => {
    // The exact shape seen live 2026-07-19: transient daemon spawned by a session.
    expect(
      isDaemonCmdline(
        cmd(
          "/home/modha/.local/bin/claude",
          "daemon",
          "run",
          "--origin",
          "transient",
          "--spawned-by",
          '{"label":"claude","cwd":"/home/modha/repos/spm1001/gueridon","pid":1643479}',
        ),
      ),
    ).toBe(true);
  });

  it("is TRUE for any `claude daemon` subcommand, however invoked", () => {
    expect(isDaemonCmdline(cmd("claude", "daemon", "run"))).toBe(true);
    expect(isDaemonCmdline(cmd("claude", "daemon", "status"))).toBe(true);
  });

  it("is FALSE for real sessions (never excludes one)", () => {
    expect(isDaemonCmdline(cmd("claude"))).toBe(false); // bare interactive
    expect(isDaemonCmdline(cmd("claude", "--resume", "abc-123"))).toBe(false);
    expect(isDaemonCmdline(cmd("claude", "-p", "--verbose"))).toBe(false); // Vertex -p lane
    expect(isDaemonCmdline(cmd("claude", "--remote-control", "spm1001/gueridon"))).toBe(false);
    expect(isDaemonCmdline(cmd("claude", "/open"))).toBe(false);
    expect(isDaemonCmdline(cmd("claude", '--settings', '{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}'))).toBe(false); // wrapper
  });

  it("is FALSE for empty/unreadable cmdline (fail open — keep the row)", () => {
    expect(isDaemonCmdline("")).toBe(false);
  });
});
