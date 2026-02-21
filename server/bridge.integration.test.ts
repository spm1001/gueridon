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
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

    const port = await findFreePort();
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

  it("CORS headers are present", async () => {
    const res = await fetch(baseUrl);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
  });
});
