import { describe, it } from "vitest";
import { execSync } from "node:child_process";

describe("production build", () => {
  it("npm run build succeeds", () => {
    // Catches transitive dependency failures (e.g. @smithy from session 3)
    // that only surface during Rollup bundling, not during dev server.
    execSync("npm run build", { stdio: "pipe", timeout: 60_000 });
  }, 60_000);
});
