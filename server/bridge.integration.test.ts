/**
 * Bridge HTTP integration tests (gdn-pomoma).
 *
 * Spawns bridge.ts as a subprocess with isolated HOME, SCAN_ROOT,
 * and BRIDGE_PORT so it can't touch production state or kill real
 * CC processes via the orphan reaper.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), "../..");

// -- Helpers --

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

    child = spawn("npx", ["tsx", "server/bridge.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        BRIDGE_PORT: String(port),
        SCAN_ROOT: tempDir,
        HOME: tempDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) stderrLines.push(line);
      }
    });

    process.on("exit", cleanup);

    await waitForReady(baseUrl, 15_000, stderrLines);
  }, 20_000); // vitest timeout for beforeAll

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
});
