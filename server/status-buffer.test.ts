import { describe, it, expect, beforeEach } from "vitest";
import { getRecent, initStatusBuffer } from "./status-buffer.js";
import { emit } from "./event-bus.js";

// Subscribe once — shared across tests (mirrors real usage)
initStatusBuffer();

function emitN(n: number): void {
  for (let i = 0; i < n; i++) {
    emit({ type: "orphan:summary", reaped: i });
  }
}

describe("status-buffer", () => {
  it("returns events in chronological order", () => {
    emitN(5);
    const recent = getRecent(5);
    // reaped values should be ascending (chronological)
    for (let i = 1; i < recent.length; i++) {
      const prev = (recent[i - 1].event as { reaped: number }).reaped;
      const curr = (recent[i].event as { reaped: number }).reaped;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("getRecent(n) returns at most n entries", () => {
    emitN(10);
    const recent = getRecent(3);
    expect(recent).toHaveLength(3);
  });

  it("getRecent() without arg returns all buffered entries", () => {
    const before = getRecent().length;
    emitN(5);
    const after = getRecent().length;
    expect(after).toBe(Math.min(before + 5, 200));
  });

  it("wraps correctly when buffer exceeds capacity", () => {
    // Emit more than capacity to force wrap
    emitN(210);
    const recent = getRecent();
    expect(recent).toHaveLength(200);
    // Each entry should have a valid event
    for (const entry of recent) {
      expect(entry.event.type).toBe("orphan:summary");
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // Last entry should be the most recent (reaped: 209)
    expect((recent[recent.length - 1].event as { reaped: number }).reaped).toBe(209);
  });

  it("entries include timestamp and level", () => {
    emit({ type: "init:timeout", folder: "/proj", sessionId: "s1", pid: 99 });
    const recent = getRecent(1);
    expect(recent[0].level).toBe("error");
    expect(recent[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
