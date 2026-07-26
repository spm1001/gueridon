import { describe, it, expect } from "vitest";
import { isInfraCmdline } from "./sessions.js";

// /proc/<pid>/cmdline is NUL-separated argv. Helper to build one from tokens.
const cmd = (...argv: string[]) => argv.join("\0") + "\0";

describe("isInfraCmdline (gdn-mimije + gdn-caguga — keep claude INFRA out of the roster)", () => {
  it("is TRUE for the daemon (the gdn-mimije leak)", () => {
    // The exact shape seen live 2026-07-19: transient daemon spawned by a session.
    expect(
      isInfraCmdline(
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
    expect(isInfraCmdline(cmd("claude", "daemon", "run"))).toBe(true);
    expect(isInfraCmdline(cmd("claude", "daemon", "status"))).toBe(true);
  });

  it("is TRUE for a Remote Control server (the gdn-caguga leak)", () => {
    // The exact shape seen live 2026-07-25: tube's claude-remote@home-modha-notes unit.
    expect(
      isInfraCmdline(
        cmd("/home/modha/.local/bin/claude", "remote-control", "--no-create-session-in-dir"),
      ),
    ).toBe(true);
    // Server with extra flags (e.g. --capacity, --permission-mode).
    expect(isInfraCmdline(cmd("claude", "remote-control", "--capacity", "32"))).toBe(true);
    // The `remote` alias — the binary rewrites it to remote-control in /proc, but
    // belt-and-braces for a version that doesn't.
    expect(isInfraCmdline(cmd("claude", "remote"))).toBe(true);
  });

  it("is FALSE for the Teams lane's --remote-control FLAG form (a real session)", () => {
    // Subcommand (no dashes) = server = infra; flag (dashes) = an RC SESSION Guéridon
    // spawned. The dashes are the discriminator — this must never be excluded.
    expect(isInfraCmdline(cmd("claude", "--remote-control", "spm1001/gueridon"))).toBe(false);
    expect(isInfraCmdline(cmd("claude", "--remote-control", "spm1001/gueridon", "/open"))).toBe(false);
  });

  it("is FALSE for real sessions (never excludes one)", () => {
    expect(isInfraCmdline(cmd("claude"))).toBe(false); // bare interactive
    expect(isInfraCmdline(cmd("claude", "--resume", "abc-123"))).toBe(false);
    expect(isInfraCmdline(cmd("claude", "-p", "--verbose"))).toBe(false); // Vertex -p lane
    expect(isInfraCmdline(cmd("claude", "/open"))).toBe(false);
    expect(isInfraCmdline(cmd("claude", '--settings', '{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}'))).toBe(false); // wrapper
  });

  it("is FALSE for empty/unreadable cmdline (fail open — keep the row)", () => {
    expect(isInfraCmdline("")).toBe(false);
  });
});
