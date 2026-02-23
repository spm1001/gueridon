/**
 * Typed bridge events — the contract between business logic and observers.
 *
 * Business logic calls emit(event). Subscribers (logger, status buffer, etc.)
 * consume events without coupling to the emitter. Each variant is narrowable
 * via its `type` field.
 */

// -- Severity levels (used by logger subscriber to filter) --

export type LogLevel = "debug" | "info" | "warn" | "error";

// -- Event variants --

export type BridgeEvent =
  // Session lifecycle
  | { type: "session:spawn"; folder: string; sessionId: string; pid: number }
  | { type: "session:exit"; folder: string; sessionId: string; code: number | null; signal: string | null }
  | { type: "session:resolve"; folder: string; sessionId: string; outcome: "fresh" | "resume" }
  | { type: "session:teardown"; folder: string; sessionId: string }

  // Turn lifecycle
  | { type: "turn:start"; folder: string; sessionId: string }
  | { type: "turn:complete"; folder: string; sessionId: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; contextPct: number | null; toolCalls: number }

  // SSE client lifecycle
  | { type: "sse:connect"; clientId: string }
  | { type: "sse:disconnect"; clientId: string; folder: string | null }

  // Grace timer
  | { type: "grace:start"; folder: string; sessionId: string; graceMs: number }
  | { type: "grace:expire"; folder: string; sessionId: string }

  // Prompt delivery
  | { type: "prompt:deliver"; folder: string; sessionId: string; cold: boolean }
  | { type: "prompt:queue"; folder: string; sessionId: string; depth: number }

  // Process management
  | { type: "init:timeout"; folder: string; sessionId: string; pid: number }
  | { type: "process:kill"; folder: string; pid: number; reason: string }
  | { type: "process:stdin-error"; folder: string; sessionId: string; error: string }
  | { type: "process:non-json"; folder: string; line: string }

  // Orphan reaping
  | { type: "orphan:skip"; pid: number; folder: string; ageHours: number }
  | { type: "orphan:reap"; pid: number; folder: string; sessionId: string }
  | { type: "orphan:summary"; reaped: number }

  // JSONL replay
  | { type: "replay:ok"; folder: string; eventCount: number; sessionId?: string }
  | { type: "replay:fail"; folder: string; error: string; sessionId?: string }

  // Push notifications
  | { type: "push:init"; status: "configured" | "disabled" | "error"; detail?: string }
  | { type: "push:subscriptions-loaded"; count: number }
  | { type: "push:subscriptions-load-error" }
  | { type: "push:subscribe"; total: number }
  | { type: "push:unsubscribe"; total: number }
  | { type: "push:send-fail"; endpoint: string; error: string }
  | { type: "push:expired-cleanup"; count: number }

  // Folder scanning
  | { type: "folders:scan-error"; scanRoot: string; error: string }

  // Client error reporting
  | { type: "client:error"; message: string; stack?: string; userAgent?: string; url?: string }

  // Request handling
  | { type: "request:rejected"; reason: string; method: string; url: string }
  | { type: "request:error"; action: string; error: string }

  // Server lifecycle
  | { type: "server:start"; port: number; scanRoot: string }
  | { type: "server:shutdown"; signal: string }
  | { type: "server:persist-error"; error: string };

// -- Level mapping --

const LEVEL_MAP: Record<BridgeEvent["type"], LogLevel> = {
  "session:spawn": "info",
  "session:exit": "info",
  "session:resolve": "info",
  "session:teardown": "debug",
  "turn:start": "debug",
  "turn:complete": "info",
  "sse:connect": "debug",
  "sse:disconnect": "debug",
  "grace:start": "debug",
  "grace:expire": "debug",
  "prompt:deliver": "info",
  "prompt:queue": "debug",
  "init:timeout": "error",
  "process:kill": "warn",
  "process:stdin-error": "error",
  "process:non-json": "debug",
  "orphan:skip": "debug",
  "orphan:reap": "info",
  "orphan:summary": "info",
  "replay:ok": "info",
  "replay:fail": "warn",
  "push:init": "info",
  "push:subscriptions-loaded": "debug",
  "push:subscriptions-load-error": "warn",
  "push:subscribe": "info",
  "push:unsubscribe": "info",
  "push:send-fail": "warn",
  "push:expired-cleanup": "info",
  "folders:scan-error": "warn",
  "client:error": "warn",
  "request:rejected": "warn",
  "request:error": "error",
  "server:start": "info",
  "server:shutdown": "info",
  "server:persist-error": "error",
};

export function levelFor(event: BridgeEvent): LogLevel {
  return LEVEL_MAP[event.type];
}
