import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeContentHash, startWatcher, stopWatcher, getContentHash } from "./content-hash.js";

function scaffold(dir: string) {
  mkdirSync(join(dir, "client"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>");
  writeFileSync(join(dir, "style.css"), "body{}");
  for (const f of ["render-utils", "render-chips", "render-messages", "render-chrome", "render-overlays"]) {
    writeFileSync(join(dir, `client/${f}.cjs`), "");
  }
}

describe("content-hash", () => {
  let dir: string;

  afterEach(() => {
    stopWatcher();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns 12-char hex string", () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);
    const hash = computeContentHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when a file changes", () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);
    const hash1 = computeContentHash(dir);
    writeFileSync(join(dir, "index.html"), "v2");
    const hash2 = computeContentHash(dir);
    expect(hash1).not.toBe(hash2);
  });

  it("is stable when files are unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);
    expect(computeContentHash(dir)).toBe(computeContentHash(dir));
  });

  it("watcher calls onChange when file changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);

    const changes: string[] = [];
    startWatcher(dir, (newHash) => changes.push(newHash));
    const initialHash = getContentHash();

    writeFileSync(join(dir, "style.css"), "body{color:red}");

    // Wait for debounce (200ms) + margin
    await new Promise(r => setTimeout(r, 500));

    expect(changes.length).toBe(1);
    expect(changes[0]).not.toBe(initialHash);
    expect(getContentHash()).toBe(changes[0]);
  });

  it("ignores non-client files in watched directories", async () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);

    const changes: string[] = [];
    startWatcher(dir, (newHash) => changes.push(newHash));

    writeFileSync(join(dir, "README.md"), "hello");
    await new Promise(r => setTimeout(r, 500));

    expect(changes.length).toBe(0);
  });

  it("does not fire onChange when file is touched but content is unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "gdn-hash-"));
    scaffold(dir);

    const changes: string[] = [];
    startWatcher(dir, (newHash) => changes.push(newHash));

    // Re-write same content
    writeFileSync(join(dir, "style.css"), "body{}");
    await new Promise(r => setTimeout(r, 500));

    expect(changes.length).toBe(0);
  });
});
