/**
 * Bridge HTTP integration tests (gdn-pomoma).
 *
 * Spawns bridge.ts as a subprocess with isolated HOME, SCAN_ROOT,
 * and BRIDGE_PORT so it can't touch production state or kill real
 * CC processes via the orphan reaper.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { STATIC_FILES, CSP } from "./bridge-logic.js";
import { isLiveClaudePid } from "./sessions.js";

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), "../..");

// -- Helpers --

/** Poll until `pid` reads comm=="claude" in /proc (or timeout). For the gdn-racuca smoke. */
async function waitForClaudePid(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isLiveClaudePid(pid)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

/** Grab an unused port by briefly binding to port 0. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

/** Retry fetch until the bridge responds or timeout expires. */
async function waitForReady(
  url: string,
  timeoutMs: number,
  stderrLines: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Bridge failed to start within ${timeoutMs}ms.\nStderr:\n${stderrLines.join("\n")}`,
  );
}

// -- Test suite --

describe("bridge HTTP smoke tests", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let port: number;
  let tempDir: string;
  const stderrLines: string[] = [];

  // Safety net: kill child even if vitest crashes before afterAll
  const cleanup = () => {
    try {
      child?.kill("SIGKILL");
    } catch {}
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gdn-smoke-"));
    mkdirSync(join(tempDir, ".config", "gueridon"), { recursive: true });

    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const tsxBin = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
    child = spawn(tsxBin, ["server/bridge.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        BRIDGE_PORT: String(port),
        SCAN_ROOT: tempDir,
        HOME: tempDir,
        GUERIDON_ENABLE_RC: "", // explicit OFF so the gating tests are deterministic (gdn-towiva)
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) stderrLines.push(line);
      }
    });

    process.on("exit", cleanup);

    await waitForReady(baseUrl, 30_000, stderrLines);
  }, 35_000); // vitest timeout for beforeAll (CI runners are slower)

  afterAll(async () => {
    process.removeListener("exit", cleanup);

    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, 3_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // -- Tests --

  it("GET / returns HTML", async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE|<html/i);
  });

  it("GET /folders returns empty JSON array", async () => {
    const res = await fetch(`${baseUrl}/folders`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ folders: [] });
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  // --- Future-B RC gating (this subprocess has GUERIDON_ENABLE_RC="") (gdn-towiva) ---

  it("GET /rc returns 404 when RC is disabled", async () => {
    const res = await fetch(`${baseUrl}/rc`);
    expect(res.status).toBe(404);
  });

  it("POST /launch returns 404 when RC is disabled", async () => {
    const res = await fetch(`${baseUrl}/launch/anything`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("GET /sessions returns 404 when RC is disabled", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(404);
  });

  it("DELETE /session/:pid returns 404 when RC is disabled (gdn-racuca gated like /sessions)", async () => {
    const res = await fetch(`${baseUrl}/session/999999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /recent returns 404 when RC is disabled (gdn-vucube gated like /sessions)", async () => {
    const res = await fetch(`${baseUrl}/recent`);
    expect(res.status).toBe(404);
  });

  it("GET /repos serves even when RC is disabled (ungated read-only)", async () => {
    const res = await fetch(`${baseUrl}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("repos");
  });

  it("CORS: same-origin request has no ACAO header, cross-origin allowed origin gets reflected", async () => {
    // Same-origin (no Origin header) — no ACAO header set
    const sameOrigin = await fetch(baseUrl);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();

    // Allowed origin — reflected back
    const allowed = await fetch(baseUrl, { headers: { Origin: `http://localhost:${port}` } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(`http://localhost:${port}`);

    // Unknown origin — rejected
    const unknown = await fetch(baseUrl, { headers: { Origin: "https://evil.example.com" } });
    expect(unknown.status).toBe(403);
  });

  it("GET /manifest.json serves JSON", async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("GET /sw.js serves JavaScript", async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("POST /upload without X-Gueridon-Mode header returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/X-Gueridon-Mode/);
  });

  it("POST /upload/:folder with path traversal returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload/${encodeURIComponent("../../etc")}`, {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid folder/i);
  });

  it("POST /upload/:folder with no session returns 400", async () => {
    // Create a real folder under SCAN_ROOT but don't create a session
    const folderName = "test-upload-no-session";
    mkdirSync(join(tempDir, folderName), { recursive: true });

    const res = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no active session/i);
  });

  it("POST /upload/:folder deposits files and returns manifest", async () => {
    // Create project folder
    const folderName = "test-upload-happy";
    const folderPath = join(tempDir, folderName);
    mkdirSync(folderPath, { recursive: true });

    // Create a session (no SSE client needed — client will be undefined)
    const sessionRes = await fetch(`${baseUrl}/session/${folderName}`, {
      method: "POST",
    });
    expect(sessionRes.status).toBe(200);

    // Build multipart with a text file
    const form = new FormData();
    form.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

    const uploadRes = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(200);

    const data = await uploadRes.json();
    expect(data.folder).toMatch(/^mise\/upload--test--/);
    expect(data.manifest.type).toBe("upload");
    expect(data.manifest.file_count).toBe(1);
    expect(data.manifest.files[0].original_name).toBe("test.txt");
    expect(data.manifest.files[0].mime_type).toBe("text/plain");
    expect(data.warnings).toEqual([]);

    // Verify files on disk
    const depositPath = join(folderPath, data.folder);
    expect(existsSync(join(depositPath, "test.txt"))).toBe(true);
    expect(existsSync(join(depositPath, "manifest.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(depositPath, "manifest.json"), "utf-8"));
    expect(manifest.files[0].deposited_as).toBe("test.txt");
  });

  it("POST /upload/:folder validates image MIME via magic bytes", async () => {
    const folderName = "test-upload-mime";
    const folderPath = join(tempDir, folderName);
    mkdirSync(folderPath, { recursive: true });

    await fetch(`${baseUrl}/session/${folderName}`, { method: "POST" });

    // Send garbage bytes declared as image/png
    const garbageBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const form = new FormData();
    form.append("file", new File([garbageBytes], "fake.png", { type: "image/png" }));

    const res = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.manifest.files[0].mime_type).toBe("application/octet-stream");
    expect(data.manifest.files[0].declared_mime).toBe("image/png");
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatch(/deposited as binary/);
  });

  // -- Fresh-vs-resume session intent (gdn-duhino / Symptom 2) --

  it("POST /session with sessionId 'new' starts fresh even when a recent session is resumable", async () => {
    const folderName = "test-fresh-vs-resume";
    const folderPath = join(tempDir, folderName);
    mkdirSync(folderPath, { recursive: true });

    // Seed a recent, resumable session on disk in the CC projects layout
    // (HOME/.claude/projects/<encodedPath>/<uuid>.jsonl). encodePath = non-alnum → "-";
    // getLatestSession derives the id from the filename and lastActive from mtime, so an
    // empty file written now is a valid, recent, resumable session.
    const encoded = folderPath.replace(/[^a-zA-Z0-9-]/g, "-");
    const projDir = join(tempDir, ".claude", "projects", encoded);
    mkdirSync(projDir, { recursive: true });
    const seededId = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(projDir, `${seededId}.jsonl`), "");

    // Default (no sessionId) → resumes the seeded session (this is the Symptom-2 behaviour
    // every Vertex launch used to get, because the launcher sent no intent).
    const resumeRes = await fetch(`${baseUrl}/session/${folderName}`, { method: "POST" });
    expect(resumeRes.status).toBe(200);
    const resumed = await resumeRes.json();
    expect(resumed.sessionId).toBe(seededId);
    expect(resumed.resumable).toBe(true);

    // Explicit "new" → a FRESH session, NOT the seeded one (the fix: the launcher now
    // sends sessionId:"new" for a deliberate new launch).
    const newRes = await fetch(`${baseUrl}/session/${folderName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "new" }),
    });
    expect(newRes.status).toBe(200);
    const fresh = await newRes.json();
    expect(fresh.sessionId).not.toBe(seededId);
    expect(fresh.resumable).toBe(false);
  });

  // -- Share-sheet upload (gdn-rovole) --

  it("POST /upload with new-session creates folder and deposits files", async () => {
    const form = new FormData();
    form.append("file", new File(["share sheet content"], "note.txt", { type: "text/plain" }));

    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "X-Gueridon-Mode": "new-session" },
      body: form,
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    // Folder should be an alliterative name
    expect(data.folder).toMatch(/^[a-z]+-[a-z]+$/);
    expect(data.sessionId).toBeTruthy();
    expect(data.depositFolder).toMatch(/^mise\/upload--note--/);
    expect(data.manifest.file_count).toBe(1);

    // Verify folder exists on disk
    expect(existsSync(join(tempDir, data.folder))).toBe(true);

    // Verify .gueridon-share marker
    const markerPath = join(tempDir, data.folder, ".gueridon-share");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(marker.source).toBe("share-sheet");

    // Verify deposit files on disk
    const depositPath = join(tempDir, data.folder, data.depositFolder);
    expect(existsSync(join(depositPath, "note.txt"))).toBe(true);
    expect(existsSync(join(depositPath, "manifest.json"))).toBe(true);
  });

  it("POST /upload with raw binary (iOS Shortcut style) creates folder", async () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: {
        "X-Gueridon-Mode": "new-session",
        "Content-Type": "image/png",
      },
      body: pngHeader,
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.folder).toMatch(/^[a-z]+-[a-z]+$/);
    expect(data.manifest.files[0].mime_type).toBe("image/png");
    expect(data.manifest.files[0].deposited_as).toMatch(/\.png$/);
  });

  it("POST /upload with new-session and no files returns 400", async () => {
    const form = new FormData();
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "X-Gueridon-Mode": "new-session" },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("POST /upload/:folder still works after share-sheet route added", async () => {
    const folderName = "test-upload-regression";
    mkdirSync(join(tempDir, folderName), { recursive: true });
    await fetch(`${baseUrl}/session/${folderName}`, { method: "POST" });

    const form = new FormData();
    form.append("file", new File(["hello"], "test.txt", { type: "text/plain" }));

    const res = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
  });

  it("share-sheet folder appears in /folders listing", async () => {
    const form = new FormData();
    form.append("file", new File(["data"], "report.csv", { type: "text/csv" }));

    const shareRes = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "X-Gueridon-Mode": "new-session" },
      body: form,
    });
    const { folder: newFolder } = await shareRes.json();

    const foldersRes = await fetch(`${baseUrl}/folders`);
    const { folders } = await foldersRes.json();
    const names = folders.map((f: any) => f.name);
    expect(names).toContain(newFolder);
  });

  it("nested folder (container/project) appears with correct name in /folders", async () => {
    // Create a container directory with a git-repo child
    const containerPath = join(tempDir, "suite");
    const projectPath = join(containerPath, "my-tool");
    mkdirSync(join(projectPath, ".git"), { recursive: true });

    const foldersRes = await fetch(`${baseUrl}/folders`);
    const { folders } = await foldersRes.json();
    const names = folders.map((f: any) => f.name);
    expect(names).toContain("suite/my-tool");
    expect(names).not.toContain("suite"); // container itself is not listed
  });

  it("POST /session for nested folder uses matching folderName in SSE events", async () => {
    // Create container with git-repo child
    const containerPath = join(tempDir, "nested");
    const projectPath = join(containerPath, "child-proj");
    mkdirSync(join(projectPath, ".git"), { recursive: true });

    // Open SSE, get clientId
    const sseRes = await fetch(`${baseUrl}/events?clientId=nested-test`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: hello")) break;
    }

    // Connect to the nested folder session
    const sessionRes = await fetch(`${baseUrl}/session/${encodeURIComponent("nested/child-proj")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-ID": "nested-test" },
      body: "{}",
    });
    expect(sessionRes.status).toBe(200);

    // Read SSE events — expect state event with folder = "nested/child-proj"
    buffer = "";
    const stateDeadline = Date.now() + 5_000;
    let folderInEvent: string | null = null;
    while (Date.now() < stateDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const stateMatch = buffer.match(/event: state\ndata: (.+)\n/);
      if (stateMatch) {
        const data = JSON.parse(stateMatch[1]);
        folderInEvent = data.folder;
        break;
      }
    }
    reader.cancel();

    // The routing key must match what scanFolders returns
    expect(folderInEvent).toBe("nested/child-proj");
  });

  it("SSE /events delivers hello event", async () => {
    const res = await fetch(`${baseUrl}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read enough of the stream to capture the hello event
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Look for a complete hello event
      if (buffer.includes("event: hello") && buffer.includes("\n\n")) {
        break;
      }
    }

    // Clean up the SSE connection
    reader.cancel();

    // Parse the hello event
    const helloMatch = buffer.match(
      /event: hello\ndata: (.+)\n/,
    );
    expect(helloMatch).toBeTruthy();
    const helloData = JSON.parse(helloMatch![1]);
    expect(helloData).toHaveProperty("version", 1);
    expect(helloData).toHaveProperty("clientId");
    expect(helloData).toHaveProperty("pushToken");
    expect(typeof helloData.pushToken).toBe("string");
    expect(helloData.pushToken.length).toBeGreaterThan(0);
  });

  it("upload broadcasts state with synthetic deposit message via SSE (gdn-hovolu)", async () => {
    // Set up: create folder + session
    const folderName = "test-upload-sse-broadcast";
    mkdirSync(join(tempDir, folderName), { recursive: true });

    // Open SSE connection
    const sseRes = await fetch(`${baseUrl}/events?clientId=hovolu-test`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Wait for hello + folders events
    const readUntil = async (marker: string, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(marker)) return;
      }
    };

    await readUntil("event: hello", 5_000);

    // Bind to session via POST (with X-Client-ID so bridge attaches the SSE client)
    await fetch(`${baseUrl}/session/${folderName}`, {
      method: "POST",
      headers: { "X-Client-ID": "hovolu-test" },
    });

    // Wait for the state snapshot from session bind
    await readUntil("event: state", 5_000);

    // Clear buffer — we only care about events after the upload
    buffer = "";

    // Upload a file
    const form = new FormData();
    form.append("file", new File(["test content"], "hovolu.txt", { type: "text/plain" }));
    const uploadRes = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(200);

    // Read SSE events — expect a state broadcast with the synthetic message
    await readUntil("event: state", 5_000);

    // Parse all state events from the buffer
    const stateMatches = [...buffer.matchAll(/event: state\ndata: (.+)\n/g)];
    expect(stateMatches.length).toBeGreaterThan(0);

    // Find a state event containing our synthetic deposit message
    let foundSynthetic = false;
    for (const match of stateMatches) {
      const data = JSON.parse(match[1]);
      const messages = data.messages || [];
      for (const msg of messages) {
        if (msg.role === "user" && msg.synthetic === true) {
          // Verify the prefix was stripped (should not contain [guéridon:deposit])
          expect(msg.content).not.toMatch(/\[guéridon:/);
          foundSynthetic = true;
        }
      }
    }
    expect(foundSynthetic).toBe(true);

    reader.cancel();
  });

  // -- Staged upload (gdn-wohani) --

  it("POST /upload/:folder?stage=true deposits files without auto-inject", async () => {
    const folderName = "test-upload-staged";
    const folderPath = join(tempDir, folderName);
    mkdirSync(folderPath, { recursive: true });

    await fetch(`${baseUrl}/session/${folderName}`, { method: "POST" });

    // Upload with ?stage=true
    const form = new FormData();
    form.append("file", new File(["staged content"], "staged.txt", { type: "text/plain" }));
    const uploadRes = await fetch(`${baseUrl}/upload/${folderName}?stage=true`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(200);

    // Response shape matches non-staged (folder, manifest, warnings)
    const data = await uploadRes.json();
    expect(data.folder).toMatch(/^mise\/upload--staged--/);
    expect(data.manifest.file_count).toBe(1);
    expect(data.manifest.files[0].deposited_as).toBe("staged.txt");
    expect(data.warnings).toEqual([]);

    // Files exist on disk
    const depositPath = join(folderPath, data.folder);
    expect(existsSync(join(depositPath, "staged.txt"))).toBe(true);
    expect(existsSync(join(depositPath, "manifest.json"))).toBe(true);
  });

  it("POST /upload/:folder without ?stage still auto-injects (regression)", async () => {
    const folderName = "test-upload-no-stage";
    const folderPath = join(tempDir, folderName);
    mkdirSync(folderPath, { recursive: true });

    const sseRes = await fetch(`${baseUrl}/events?clientId=nostage-test`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readUntil = async (marker: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(marker)) return true;
      }
      return false;
    };

    await readUntil("event: hello", 5_000);
    await fetch(`${baseUrl}/session/${folderName}`, {
      method: "POST",
      headers: { "X-Client-ID": "nostage-test" },
    });
    await readUntil("event: state", 5_000);
    buffer = "";

    // Upload WITHOUT ?stage=true — should auto-inject
    const form = new FormData();
    form.append("file", new File(["auto content"], "auto.txt", { type: "text/plain" }));
    const uploadRes = await fetch(`${baseUrl}/upload/${folderName}`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(200);

    // Should get a state broadcast with synthetic deposit message
    const found = await readUntil("event: state", 5_000);
    expect(found).toBe(true);

    const stateMatches = [...buffer.matchAll(/event: state\ndata: (.+)\n/g)];
    const hasSynthetic = stateMatches.some((match) => {
      const state = JSON.parse(match[1]);
      return (state.messages || []).some(
        (m: any) => m.role === "user" && m.synthetic === true,
      );
    });
    expect(hasSynthetic).toBe(true);

    reader.cancel();
  });

  it("push subscribe rejects without valid token (gdn-ricocu)", async () => {
    // No token → 401
    const noToken = await fetch(`${baseUrl}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://example.com/push" }),
    });
    expect(noToken.status).toBe(401);

    // Bad token → 401
    const badToken = await fetch(`${baseUrl}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Push-Token": "not-a-real-token" },
      body: JSON.stringify({ endpoint: "https://example.com/push" }),
    });
    expect(badToken.status).toBe(401);
  });

  it("push unsubscribe rejects without valid token (gdn-ricocu)", async () => {
    const res = await fetch(`${baseUrl}/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://example.com/push" }),
    });
    expect(res.status).toBe(401);
  });

  // -- Logging sweep (gdn-mudila) --

  it("GET /status includes stderrBuffer per session", async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    // Every session object should have a stderrBuffer array
    for (const session of data.sessions) {
      expect(session).toHaveProperty("stderrBuffer");
      expect(Array.isArray(session.stderrBuffer)).toBe(true);
    }
  });

  it("CORS rejection emits request:rejected event to stderr", async () => {
    // Clear the slate — record stderr position
    const before = stderrLines.length;

    // Send a cross-origin request from an unknown origin
    await fetch(baseUrl, { headers: { Origin: "https://evil.example.com" } });

    // Give the event bus a moment to flush
    await new Promise((r) => setTimeout(r, 100));

    // Look for request:rejected in the new stderr lines
    const newLines = stderrLines.slice(before);
    const rejection = newLines.find((line) => line.includes("request:rejected") && line.includes("cors-origin"));
    expect(rejection).toBeTruthy();
  });

  it("request:http events include requestId for debug tracing", async () => {
    // This test verifies the correlation ID infrastructure works end-to-end.
    // We need LOG_LEVEL=debug to see request:http events, which our test bridge
    // doesn't set by default. Instead, we verify request:rejected (warn level)
    // includes a requestId, since it flows through the same AsyncLocalStorage.
    const before = stderrLines.length;

    await fetch(baseUrl, { headers: { Origin: "https://evil.example.com" } });
    await new Promise((r) => setTimeout(r, 100));

    const newLines = stderrLines.slice(before);
    const rejection = newLines.find((line) => line.includes("request:rejected"));
    expect(rejection).toBeTruthy();

    const parsed = JSON.parse(rejection!);
    expect(parsed.requestId).toBeTruthy();
    expect(parsed.requestId).toHaveLength(8); // 4 random bytes → 8 hex chars
  });

  // -- STATIC_FILES smoke test (gdn-wuwevi) --

  describe("STATIC_FILES coverage", () => {
    for (const [urlPath, entry] of Object.entries(STATIC_FILES)) {
      it(`GET ${urlPath} → 200 with ${entry.mime}`, async () => {
        const res = await fetch(`${baseUrl}${urlPath}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(entry.mime);
      });
    }

    it("HTML responses include CSP header, non-HTML responses do not", async () => {
      for (const [urlPath, entry] of Object.entries(STATIC_FILES)) {
        const res = await fetch(`${baseUrl}${urlPath}`);
        const csp = res.headers.get("content-security-policy");
        if (entry.mime.startsWith("text/html")) {
          expect(csp).toBe(CSP);
        } else {
          expect(csp).toBeNull();
        }
      }
    });

    it("all responses include no-cache header", async () => {
      for (const [urlPath] of Object.entries(STATIC_FILES)) {
        const res = await fetch(`${baseUrl}${urlPath}`);
        expect(res.headers.get("cache-control")).toBe("no-cache");
      }
    });
  });
});

// === Future-B launcher endpoints, RC ENABLED (gdn-towiva) ===
// A second subprocess with GUERIDON_ENABLE_RC=1 and a SCAN_ROOT of two real git repos with
// distinct commit dates — so /repos exercises the real git-recency sort. We never POST a valid
// /launch here (that would spawn a real `claude`); we test the read/gating/validation paths.

/** Create a git repo at `dir` with a single commit dated `isoDate` (controls git log %ct). */
function makeGitRepo(dir: string, isoDate: string): void {
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["config", "user.email", "t@example.com"], opts);
  execFileSync("git", ["config", "user.name", "Tester"], opts);
  writeFileSync(join(dir, "README.md"), "x");
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    ...opts,
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

describe("launcher endpoints (RC enabled)", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let port: number;
  let tempDir: string;
  const stderrLines: string[] = [];
  const cleanup = () => { try { child?.kill("SIGKILL"); } catch {} };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gdn-rc-int-"));
    mkdirSync(join(tempDir, ".config", "gueridon"), { recursive: true });
    // Two repos; "newer" committed later than "older" → must sort first in /repos.
    makeGitRepo(join(tempDir, "older"), "2020-01-01T00:00:00");
    makeGitRepo(join(tempDir, "newer"), "2024-06-01T00:00:00");

    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const tsxBin = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
    child = spawn(tsxBin, ["server/bridge.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        BRIDGE_PORT: String(port),
        SCAN_ROOT: tempDir,
        HOME: tempDir,
        GUERIDON_ENABLE_RC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line) stderrLines.push(line);
    });
    process.on("exit", cleanup);
    await waitForReady(baseUrl, 30_000, stderrLines);
  }, 35_000);

  afterAll(async () => {
    process.removeListener("exit", cleanup);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3_000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("GET /repos lists repos ordered by git-commit recency, with path + lastCommit", async () => {
    const res = await fetch(`${baseUrl}/repos`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.repos.map((r: { name: string }) => r.name);
    expect(names).toContain("newer");
    expect(names).toContain("older");
    expect(names.indexOf("newer")).toBeLessThan(names.indexOf("older")); // recency desc
    const newer = body.repos.find((r: { name: string }) => r.name === "newer");
    expect(typeof newer.lastCommit).toBe("number");
    expect(newer).toHaveProperty("path");
  });

  it("GET /rc returns an empty sessions list when none are running", async () => {
    const res = await fetch(`${baseUrl}/rc`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  it("GET /sessions returns a roster array (gdn-batogo; content is host-global)", async () => {
    // /sessions scans the host's /proc, so contents are non-deterministic — assert shape only.
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("DELETE /launch for a valid folder with no running session returns 404", async () => {
    const res = await fetch(`${baseUrl}/launch/${encodeURIComponent("newer")}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /launch with a path-traversal folder returns 400 (rejected before any spawn)", async () => {
    const res = await fetch(`${baseUrl}/launch/${encodeURIComponent("../../etc")}`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  // --- DELETE /session/:pid — end a foreign session by pid (gdn-racuca) ---

  it("DELETE /session/:pid 404s a pid that is not a live claude session", async () => {
    // The bridge subprocess's own pid is tsx/node (comm !== "claude") — must fail closed.
    const res = await fetch(`${baseUrl}/session/${child.pid}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /session/:pid SIGTERMs a real claude-comm process by pid, end-to-end", async () => {
    // A node child whose process.title is "claude" reads comm=="claude" in the host-global /proc
    // scan, so the bridge subprocess (same uid) sees and signals it exactly like a foreign session.
    const fake = spawn(process.execPath, ["-e", "process.title='claude';setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      expect(await waitForClaudePid(fake.pid!)).toBe(true);
      const res = await fetch(`${baseUrl}/session/${fake.pid}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ending: true, pid: fake.pid });
      const died = await new Promise<boolean>((resolve) => {
        if (fake.exitCode !== null || fake.signalCode) return resolve(true);
        fake.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      expect(died).toBe(true);
    } finally {
      try { fake.kill("SIGKILL"); } catch { /* already dead */ }
    }
  });
});
