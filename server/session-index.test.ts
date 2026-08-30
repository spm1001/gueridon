import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  uuidVersionOf,
  parseHeadFields,
  resolveTitle,
  loadCoworkTitles,
  loadBridgeLogTitles,
  scanRecentSessions,
} from "./session-index.js";
import { teleportSessionUuid } from "./sessions.js";

const V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const V4_COWORK = "bbbbbbbb-cccc-4ddd-9eee-ffffffffffff";
const V4_OLD = "cccccccc-dddd-4eee-8fff-000000000000";
const V4_EMPTY = "dddddddd-eeee-4fff-9000-111111111111";
// The teleport-derived uuid is v5 by construction — the file must be NAMED with it.
const CSE_BODY = "01TestBody123";
const V5_REMOTE = teleportSessionUuid("cse_" + CSE_BODY);

const line = (o: object) => JSON.stringify(o) + "\n";
const human = (cwd: string, text: string, entrypoint = "cli") =>
  line({ type: "user", cwd, entrypoint, message: { role: "user", content: text }, permissionMode: "default" });

describe("uuidVersionOf", () => {
  it("reads the version nibble", () => {
    expect(uuidVersionOf(V4)).toBe(4);
    expect(uuidVersionOf(V5_REMOTE)).toBe(5);
  });
});

describe("parseHeadFields", () => {
  it("takes cwd/entrypoint from content, first HUMAN prompt, latest ai-title", () => {
    const text =
      line({ type: "user", cwd: "/home/x/repos/acme/data-tools", entrypoint: "cli", isMeta: true,
             message: { role: "user", content: [{ type: "text", text: "injected" }] } }) +
      line({ type: "user", cwd: "/home/x/repos/acme/data-tools",
             message: { role: "user", content: [{ type: "tool_result", content: "out" }] },
             toolUseResult: { stdout: "out" } }) +
      human("/home/x/repos/acme/data-tools", "<command-name>/open</command-name>") +
      human("/home/x/repos/acme/data-tools", "  fix the   roster bug please  ") +
      line({ type: "ai-title", aiTitle: "First title" }) +
      line({ type: "ai-title", aiTitle: "Retitled later" });
    const h = parseHeadFields(text);
    expect(h.cwd).toBe("/home/x/repos/acme/data-tools");
    expect(h.entrypoint).toBe("cli");
    expect(h.firstPrompt).toBe("fix the roster bug please");
    expect(h.aiTitle).toBe("Retitled later"); // a retitle wins
  });

  it("survives garbage lines and returns nulls when nothing matches", () => {
    const h = parseHeadFields('not json\n{"type":"progress"}\n');
    expect(h).toEqual({ cwd: null, entrypoint: null, aiTitle: null, firstPrompt: null });
  });
});

describe("resolveTitle precedence (ai-title > cowork > bridge-log > first-prompt)", () => {
  const head = { cwd: "/x", entrypoint: "cli", aiTitle: "AI", firstPrompt: "prompt" };
  it("walks the chain", () => {
    expect(resolveTitle(head, "Cowork", "Bridge")).toMatchObject({ title: "AI", titleSource: "ai-title" });
    expect(resolveTitle({ ...head, aiTitle: null }, "Cowork", "Bridge"))
      .toMatchObject({ title: "Cowork", titleSource: "cowork" });
    expect(resolveTitle({ ...head, aiTitle: null }, undefined, "Bridge"))
      .toMatchObject({ title: "Bridge", titleSource: "bridge-log" });
    expect(resolveTitle({ ...head, aiTitle: null }, undefined, undefined))
      .toMatchObject({ title: "prompt", titleSource: "first-prompt" });
    expect(resolveTitle({ cwd: null, entrypoint: null, aiTitle: null, firstPrompt: null }, undefined, undefined))
      .toMatchObject({ title: null, titleSource: null });
  });
});

describe("scanRecentSessions (fixture farm)", () => {
  let root: string;
  let projectsDir: string;
  let sidecarRoot: string;
  let logsDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gdn-index-"));
    // Dash-in-repo-name dir: the dirname is NOT decodable; cwd must come from content.
    projectsDir = join(root, "projects");
    const proj = join(projectsDir, "-home-x-repos-acme-data-tools");
    await mkdir(proj, { recursive: true });

    // v4 interactive session with ai-title.
    await writeFile(join(proj, `${V4}.jsonl`),
      human("/home/x/repos/acme/data-tools", "let's fix the widget") +
      line({ type: "ai-title", aiTitle: "Widget fixing" }));

    // v5 phone session: no ai-title (0/12 measured), title comes from the bridge log.
    await writeFile(join(proj, `${V5_REMOTE}.jsonl`),
      human("/home/x", "phone prompt about widgets", "sdk-cli"));

    // Cowork session: no ai-title, title from the Desktop sidecar.
    await writeFile(join(proj, `${V4_COWORK}.jsonl`),
      human("/home/x", "cowork prompt", "claude-desktop"));

    // Too old — outside the window.
    const oldPath = join(proj, `${V4_OLD}.jsonl`);
    await writeFile(oldPath, human("/home/x", "ancient"));
    const old = (Date.now() - 30 * 86_400_000) / 1000;
    await utimes(oldPath, old, old);

    // Empty/warmup session: no human prompt, no title anywhere — dropped.
    await writeFile(join(proj, `${V4_EMPTY}.jsonl`),
      line({ type: "user", cwd: "/home/x", message: { role: "user", content: [{ type: "tool_result", content: "x" }] }, toolUseResult: {} }));

    // Distractors: a workflow journal (non-uuid name) and a subagents directory.
    await writeFile(join(proj, "journal.jsonl"), line({ started: true }));
    await mkdir(join(proj, `${V4}`, "subagents"), { recursive: true });
    await writeFile(join(proj, V4, "subagents", "agent-1.jsonl"), human("/home/x", "subagent"));

    // Cowork sidecar fixture.
    sidecarRoot = join(root, "sidecar");
    await mkdir(join(sidecarRoot, "acct1", "ws1"), { recursive: true });
    await writeFile(join(sidecarRoot, "acct1", "ws1", "local_abc.json"),
      JSON.stringify({ sessionId: "local_abc", cliSessionId: V4_COWORK, title: "Mawitu pickup" }));

    // Bridge log fixture.
    logsDir = join(root, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "claude-remote-home-x.log"),
      `2026-08-30 noise\nblah derived title for session_${CSE_BODY}: Hello from the phone\n`);
  });

  afterAll(async () =>
    rm(root, { recursive: true, force: true }));

  it("indexes the farm with titles from all three sources, drops junk", async () => {
    // minBytes 0: these fixtures are all probe-sized; the floor gets its own test below.
    const got = await scanRecentSessions({ projectsDir, sidecarRoot, logsDir, minBytes: 0 });
    const byUuid = new Map(got.map((r) => [r.uuid, r]));

    expect(byUuid.get(V4)).toMatchObject({
      cwd: "/home/x/repos/acme/data-tools", // from content — the dirname is one-way
      entrypoint: "cli", uuidVersion: 4,
      title: "Widget fixing", titleSource: "ai-title",
    });
    expect(byUuid.get(V5_REMOTE)).toMatchObject({
      uuidVersion: 5, entrypoint: "sdk-cli",
      title: "Hello from the phone", titleSource: "bridge-log",
    });
    expect(byUuid.get(V4_COWORK)).toMatchObject({
      entrypoint: "claude-desktop",
      title: "Mawitu pickup", titleSource: "cowork",
    });
    expect(byUuid.has(V4_OLD)).toBe(false);   // outside the window
    expect(byUuid.has(V4_EMPTY)).toBe(false); // warmup — no prompt, no title
    expect(got.length).toBe(3);               // journal + subagent files never counted
  });

  it("respects maxFiles newest-first", async () => {
    const got = await scanRecentSessions({ projectsDir, sidecarRoot, logsDir, maxFiles: 1, minBytes: 0 });
    expect(got.length).toBe(1);
  });

  it("substance floor drops probe-sized sessions unless a human surface titled them", async () => {
    // Every fixture here is far under 10KB. With the floor at 10KB, only the two rows
    // titled by a HUMAN surface survive: the Cowork-sidecar one and the bridge-log one.
    const got = await scanRecentSessions({ projectsDir, sidecarRoot, logsDir, minBytes: 10_000 });
    const uuids = got.map((r) => r.uuid).sort();
    expect(uuids).toEqual([V5_REMOTE, V4_COWORK].sort());
  });

  it("carries firstPrompt as the subtitle source", async () => {
    const got = await scanRecentSessions({ projectsDir, sidecarRoot, logsDir, minBytes: 0 });
    const v4 = got.find((r) => r.uuid === V4);
    expect(v4?.firstPrompt).toBe("let's fix the widget");
    expect(v4?.sizeBytes).toBeGreaterThan(0);
  });
});

describe("loadCoworkTitles / loadBridgeLogTitles tolerance", () => {
  it("return empty maps when the roots don't exist", async () => {
    expect((await loadCoworkTitles("/nonexistent-gdn")).size).toBe(0);
    expect((await loadBridgeLogTitles("/nonexistent-gdn")).size).toBe(0);
  });
});
