import { describe, it, expect } from "vitest";
import { emit, subscribe } from "./event-bus.js";
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
});
