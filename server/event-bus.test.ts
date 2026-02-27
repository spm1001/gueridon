import { describe, it, expect, vi } from "vitest";
import { emit, subscribe, errorDetail } from "./event-bus.js";
import { requestContext } from "./request-context.js";
import type { BridgeEvent } from "./events.js";

describe("event-bus", () => {
  it("subscriber receives emitted events", () => {
    const received: BridgeEvent[] = [];
    subscribe((e) => received.push(e));

    emit({ type: "server:start", port: 3001, scanRoot: "/tmp" });
    emit({ type: "session:spawn", folder: "/home/x/proj", sessionId: "abc", pid: 1234 });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: "server:start", port: 3001, scanRoot: "/tmp" });
    expect(received[1]).toEqual({
      type: "session:spawn",
      folder: "/home/x/proj",
      sessionId: "abc",
      pid: 1234,
    });
  });

  it("multiple subscribers each receive all events", () => {
    const a: BridgeEvent[] = [];
    const b: BridgeEvent[] = [];
    subscribe((e) => a.push(e));
    subscribe((e) => b.push(e));

    emit({ type: "server:shutdown", signal: "SIGINT" });

    // Both get the event (plus carry-over from previous test since module is shared)
    expect(a.at(-1)).toEqual({ type: "server:shutdown", signal: "SIGINT" });
    expect(b.at(-1)).toEqual({ type: "server:shutdown", signal: "SIGINT" });
  });

  it("subscriber throwing does not crash the emit caller", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribe(() => { throw new Error("boom"); });

    // Should not throw
    expect(() => {
      emit({ type: "server:shutdown", signal: "test" });
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[event-bus] subscriber threw:",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("enriches events with requestId from AsyncLocalStorage", () => {
    const received: any[] = [];
    subscribe((e) => received.push(e));

    requestContext.run({ requestId: "abc123" }, () => {
      emit({ type: "server:shutdown", signal: "test" });
    });

    const last = received.at(-1);
    expect(last.requestId).toBe("abc123");
    expect(last.type).toBe("server:shutdown");
  });

  it("omits requestId when not in a request context", () => {
    const received: any[] = [];
    subscribe((e) => received.push(e));

    emit({ type: "server:shutdown", signal: "test" });

    const last = received.at(-1);
    expect(last.requestId).toBeUndefined();
  });
});

describe("errorDetail", () => {
  it("preserves stack trace from Error objects", () => {
    const err = new Error("test error");
    const detail = errorDetail(err);
    expect(detail).toContain("test error");
    expect(detail).toContain("event-bus.test");  // stack includes this file
  });

  it("converts non-Error values to string", () => {
    expect(errorDetail("plain string")).toBe("plain string");
    expect(errorDetail(42)).toBe("42");
    expect(errorDetail(null)).toBe("null");
  });

  it("handles Error without stack gracefully", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    expect(errorDetail(err)).toBe("Error: no stack");
  });
});
