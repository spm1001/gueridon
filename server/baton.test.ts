import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batonDir, batonPath, isSessionId, listBatons, readBaton, removeBaton, writeBaton, type Baton } from "./baton.js";

const ID = "0c6f6a8e-2d4b-4a57-9d51-3f1f5f0b7a11";
const baton = (over: Partial<Baton> = {}): Baton => ({
  v: 1, sessionId: ID, holder: "gueridon", since: "2026-09-30T07:00:00.000Z",
  pid: null, cwd: "/repos/demo", pane: "%3", release: { url: "http://127.0.0.1:3013" }, ...over,
});

describe("baton file", () => {
  it("round-trips, leaves no temp file, and is private to the owner", () => {
    const dir = batonDir(mkdtempSync(join(tmpdir(), "baton-")));
    writeBaton(dir, baton());
    writeBaton(dir, baton({ holder: "terminal", release: null }));
    expect(readBaton(dir, ID)).toMatchObject({ holder: "terminal", release: null, pane: "%3" });
    expect(readdirSync(dir)).toEqual([`${ID}.json`]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(batonPath(dir, ID)).mode & 0o777).toBe(0o600);
  });

  it("reads absent as null, and a broken file as an error rather than a free conversation", () => {
    const dir = batonDir(mkdtempSync(join(tmpdir(), "baton-")));
    expect(readBaton(dir, ID)).toBeNull();
    writeBaton(dir, baton());
    writeFileSync(batonPath(dir, ID), "{\"holder\":\"nobody\"");
    expect(() => readBaton(dir, ID)).toThrow();
    writeFileSync(batonPath(dir, ID), JSON.stringify({ ...baton(), holder: "nobody" }));
    expect(() => readBaton(dir, ID)).toThrow(/malformed/);
  });

  it("lists readable batons, names broken ones, and removes one", () => {
    const dir = batonDir(mkdtempSync(join(tmpdir(), "baton-")));
    expect(listBatons(dir)).toEqual({ batons: [], broken: [] });
    writeBaton(dir, baton());
    writeFileSync(join(dir, "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d.json"), "{");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const l = listBatons(dir);
    expect(l.batons.map((b) => b.sessionId)).toEqual([ID]);
    expect(l.broken).toEqual(["9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d.json"]);
    removeBaton(dir, ID);
    expect(readBaton(dir, ID)).toBeNull();
    removeBaton(dir, ID); // already gone is fine
  });

  it("refuses anything but a uuid before it reaches a path", () => {
    expect(isSessionId(ID)).toBe(true);
    for (const bad of ["../../etc/passwd", `${ID}/x`, "", ID.toUpperCase() + "0", 42]) expect(isSessionId(bad)).toBe(false);
    expect(() => batonPath("/tmp", "../evil")).toThrow();
  });
});
