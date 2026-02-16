import { describe, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("production build", () => {
  it("npm run build succeeds", () => {
    // Build to a temp directory so vitest's environment doesn't contaminate
    // the real dist/ (vitest sets import.meta.env.DEV=true, which Vite
    // inherits, producing a dev-mode bundle with hardcoded :3001 WS URL).
    const outDir = mkdtempSync(join(tmpdir(), "gdn-build-test-"));
    try {
      execSync(`npx vite build --outDir ${outDir}`, {
        stdio: "pipe",
        timeout: 60_000,
        env: { ...process.env, NODE_ENV: "production" },
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
