import { describe, it, expect } from "vitest";
import { isInfraCmdline, extractRemoteSessionId, teleportSessionUuid } from "./sessions.js";

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

  it("is TRUE for the agents TUI and the bg-spare pool (gdn-zahidu)", () => {
    // Both seen live 2026-08-29: a manager and a warm pool showing as End-able sessions.
    expect(isInfraCmdline(cmd("claude", "agents"))).toBe(true);
    expect(
      isInfraCmdline(cmd("claude", "bg-spare", "--bg-spare", "/tmp/cc-daemon-1000/8e580518/spare/89bc6775.claim.sock")),
    ).toBe(true);
  });

  it("catches infra whose rewritten title folds the subcommand into argv[0] (gdn-zahidu)", () => {
    // Measured 2026-08-30 (pid 17441): the spare pool rewrites its process title, so
    // argv[0] is the single token "claude bg-spare" — a space, not a NUL. argv[1] is then
    // the flag. The filter must read the subcommand out of argv[0]'s second word.
    expect(
      isInfraCmdline(cmd("claude bg-spare", "--bg-spare", "/tmp/cc-daemon-1000/8e580518/spare/89bc6775.claim.sock")),
    ).toBe(true);
    // A rewritten title on a real session (flag as second word) must NOT be excluded.
    expect(isInfraCmdline(cmd("claude --resume abc-123"))).toBe(false);
  });

  it("is TRUE for bg-pty-host and the `rc` server alias (gdn-zahidu, measured 2026-08-30)", () => {
    expect(
      isInfraCmdline(cmd("claude", "bg-pty-host", "--bg-pty-host", "/tmp/cc-daemon-1000/x/spare/y.pty.sock", "200", "50")),
    ).toBe(true);
    expect(isInfraCmdline(cmd("claude bg-pty-host", "--bg-pty-host", "/tmp/sock", "57", "31"))).toBe(true);
    // `claude rc` — server alias, seen live under the commis wallet with an --sdk-url child.
    expect(isInfraCmdline(cmd("claude", "rc"))).toBe(true);
    expect(isInfraCmdline(cmd("claude rc"))).toBe(true);
  });

  it("is FALSE for an RC-server CHILD — versioned binary, --print, --sdk-url (gdn-zahidu)", () => {
    // The exact shape seen live 2026-08-29 (pid 248771): a phone-created session. argv[1]
    // is "--print", so the infra filter keeps it — a real session, never excluded.
    expect(
      isInfraCmdline(
        cmd(
          "/home/modha/.local/share/claude/versions/2.1.251",
          "--print",
          "--sdk-url",
          "https://api.anthropic.com/v1/code/sessions/cse_01BuFAtest",
        ),
      ),
    ).toBe(false);
  });
});

describe("extractRemoteSessionId (gdn-zahidu — phone sessions self-identify in /proc)", () => {
  it("pulls the cse_ id out of an RC child's --sdk-url arg", () => {
    const c = cmd(
      "/home/modha/.local/share/claude/versions/2.1.251",
      "--print",
      "--sdk-url",
      "https://api.anthropic.com/v1/code/sessions/cse_01BuFAbc123XYZ",
    );
    expect(extractRemoteSessionId(c)).toBe("cse_01BuFAbc123XYZ");
  });

  it("is undefined for anything without an --sdk-url cse id", () => {
    expect(extractRemoteSessionId(cmd("claude"))).toBeUndefined();
    expect(extractRemoteSessionId(cmd("claude", "--resume", "abc"))).toBeUndefined();
    // A cse_-looking token OUTSIDE --sdk-url must not match (e.g. quoted in a -p prompt).
    expect(extractRemoteSessionId(cmd("claude", "-p", "look at cse_deadbeef please"))).toBeUndefined();
  });
});

describe("teleportSessionUuid (gdn-zahidu — the trousse teleport-id derivation)", () => {
  it("matches an independent uuid5 implementation (python oracle)", () => {
    // python3: uuid.uuid5(UUID('3ab19d7e-9f35-45c2-926e-75e271cc60b3'),
    //   'https://api.anthropic.com/v1/code/sessions/cse_TESTTOKEN123')
    expect(teleportSessionUuid("cse_TESTTOKEN123")).toBe("f61269f7-24a3-5ee6-9365-9496cb6f1c3c");
  });

  it("mints a version-5, RFC-4122-variant uuid", () => {
    const u = teleportSessionUuid("cse_anything");
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
