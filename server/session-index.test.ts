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
      human("/home/x/repos/acme/data-tools", "<local-command-stdout>commons is already fresh</local-command-stdout>") +
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

    // Every fixture gets an EXPLICIT, distinct mtime (gdn-vidame). Written back-to-back with
    // no stamps, "newest" was whatever the clock said: ext4 mtimes move in kernel ticks (4 ms
    // at HZ=250), so most of the time all five files tied and the empty/warmup file — written
    // LAST — sometimes landed one tick later as the strictly newest. The maxFiles slice caps
    // BEFORE the substance filters, so maxFiles:1 then kept only the warmup file, the filters
    // dropped it, and the scan returned 0 rows — a 16–25% flake on CI and locally, 2026-08-30
    // to 2026-09-13 (measured by the closing essayeur: old fixtures 5/20 red even with a path
    // tie-break in the product sort, which is why no product change ships for this). Minutes-
    // ago stamps make "newest" a fact of the fixture, not of the clock.
    const stamp = async (path: string, minutesAgo: number) => {
      const t = (Date.now() - minutesAgo * 60_000) / 1000;
      await utimes(path, t, t);
    };

    // v4 interactive session with ai-title — the NEWEST file, so maxFiles:1 must keep it.
    const v4Path = join(proj, `${V4}.jsonl`);
    await writeFile(v4Path,
      human("/home/x/repos/acme/data-tools", "let's fix the widget") +
      line({ type: "ai-title", aiTitle: "Widget fixing" }));
    await stamp(v4Path, 1);

    // v5 phone session: no ai-title (0/12 measured), title comes from the bridge log.
    const v5Path = join(proj, `${V5_REMOTE}.jsonl`);
    await writeFile(v5Path, human("/home/x", "phone prompt about widgets", "sdk-cli"));
    await stamp(v5Path, 2);

    // Cowork session: no ai-title, title from the Desktop sidecar.
    const coworkPath = join(proj, `${V4_COWORK}.jsonl`);
    await writeFile(coworkPath, human("/home/x", "cowork prompt", "claude-desktop"));
    await stamp(coworkPath, 3);

    // Too old — outside the window.
    const oldPath = join(proj, `${V4_OLD}.jsonl`);
    await writeFile(oldPath, human("/home/x", "ancient"));
    await stamp(oldPath, 30 * 24 * 60);

    // Empty/warmup session: no human prompt, no title anywhere — dropped. Stamped OLDEST of
    // the in-window files so the cap never reaches it before a real session.
    const emptyPath = join(proj, `${V4_EMPTY}.jsonl`);
    await writeFile(emptyPath,
      line({ type: "user", cwd: "/home/x", message: { role: "user", content: [{ type: "tool_result", content: "x" }] }, toolUseResult: {} }));
    await stamp(emptyPath, 4);

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
    expect(got[0].uuid).toBe(V4); // the newest by stamped mtime, not whichever readdir listed first
  });

  it("substance floor drops probe-sized sessions unless a human surface titled them", async () => {
    // Every fixture here is far under 10KB. With the floor at 10KB, only the two rows
    // titled by a HUMAN surface survive: the Cowork-sidecar one and the bridge-log one.
    const got = await scanRecentSessions({ projectsDir, sidecarRoot, logsDir, minBytes: 10_000 });
    const uuids = got.map((r) => r.uuid).sort();
    expect(uuids).toEqual([V5_REMOTE, V4_COWORK].sort());
  });

  it("hunts past the head window for a buried first prompt (progressive read)", async () => {
    // A session whose head is all hook machinery: 40 isMeta lines (~4KB), the human's
    // opener beyond them. With a 512B head window the shallow parse misses it and the
    // deep hunt must find it.
    const buriedDir = join(projectsDir, "-home-x-buried");
    await mkdir(buriedDir, { recursive: true });
    const uuid = "eeeeeeee-ffff-4000-8111-222222222222";
    const noise = (n: number) => {
      let s = "";
      for (let i = 0; i < n; i++) {
        s += line({ type: "user", cwd: "/home/x/buried", entrypoint: "cli", isMeta: true,
          message: { role: "user", content: [{ type: "text", text: "hook noise ".repeat(8) + i }] } });
      }
      return s;
    };
    // Prompt in the MIDDLE: past the 512B head AND shielded from the 128B tail window —
    // otherwise the shallow parse finds it and this test could never fail.
    await writeFile(join(buriedDir, `${uuid}.jsonl`),
      noise(40) + human("/home/x/buried", "the buried opener about swaps") + noise(40));
    const got = await scanRecentSessions({
      projectsDir, sidecarRoot, logsDir, minBytes: 0, headBytes: 512, tailBytes: 128,
    });
    expect(got.find((r) => r.uuid === uuid)?.firstPrompt).toBe("the buried opener about swaps");
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
