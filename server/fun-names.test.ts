import { describe, it, expect } from "vitest";
import { generateFolderName } from "./fun-names.js";

describe("generateFolderName", () => {
  it("returns an alliterative adjective-noun pair", async () => {
    const name = await generateFolderName("/tmp/nonexistent");
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    // Alliterative: first char of both words matches
    const [adj, noun] = name.split("-");
    expect(adj[0]).toBe(noun[0]);
  });

  it("generates varied names across calls", async () => {
    const names = new Set<string>();
    for (let i = 0; i < 30; i++) {
      names.add(await generateFolderName("/tmp/nonexistent"));
    }
    // With 26 letters and multiple words per letter, should get variety
    expect(names.size).toBeGreaterThan(10);
  });

  it("names are all lowercase with single hyphen", async () => {
    for (let i = 0; i < 20; i++) {
      const name = await generateFolderName("/tmp/nonexistent");
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(name.split("-")).toHaveLength(2);
    }
  });
});
