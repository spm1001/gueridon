import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _formatLine, LEVEL_ORDER } from "./logger.js";
import type { BridgeEvent } from "./events.js";

describe("logger", () => {
  describe("formatLine", () => {
    it("produces valid JSON with ts, level, type, and payload fields", () => {
      const event: BridgeEvent = {
        type: "session:spawn",
        folder: "/home/x/proj",
        sessionId: "abc-123",
        pid: 42,
      };
      const line = _formatLine(event, "info");
      const parsed = JSON.parse(line);

      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.level).toBe("info");
      expect(parsed.type).toBe("session:spawn");
      expect(parsed.folder).toBe("/home/x/proj");
      expect(parsed.sessionId).toBe("abc-123");
      expect(parsed.pid).toBe(42);
    });

    it("spreads all payload fields into the JSON line", () => {
      const event: BridgeEvent = {
        type: "turn:complete",
        folder: "/proj",
        sessionId: "s1",
        durationMs: 1500,
        inputTokens: 200,
        outputTokens: 300,
        contextPct: 42,
        toolCalls: 3,
      };
      const parsed = JSON.parse(_formatLine(event, "info"));
      expect(parsed.durationMs).toBe(1500);
      expect(parsed.inputTokens).toBe(200);
      expect(parsed.outputTokens).toBe(300);
      expect(parsed.contextPct).toBe(42);
      expect(parsed.toolCalls).toBe(3);
    });
  });

  describe("LEVEL_ORDER", () => {
    it("orders debug < info < warn < error", () => {
      expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info);
      expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn);
      expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error);
    });
  });
});
