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
  | { type: "grace:skip"; folder: string; reason: string; ageMs: number }

  // Prompt delivery
  | { type: "prompt:deliver"; folder: string; sessionId: string }
  | { type: "prompt:queue"; folder: string; sessionId: string; depth: number }
  | { type: "prompt:outrider"; folder: string; sessionId: string }

  // Process management
  | { type: "init:timeout"; folder: string; sessionId: string; pid: number }
  | { type: "process:kill"; folder: string; pid: number; reason: string }
  | { type: "process:stdin-error"; folder: string; sessionId: string; error: string }
  | { type: "process:non-json"; folder: string; line: string }

  // Orphan reaping
  | { type: "orphan:skip"; pid: number; folder: string; ageHours: number }
  | { type: "orphan:reap"; pid: number; folder: string; sessionId: string; children: number }
  | { type: "orphan:sigkill"; pid: number }
  | { type: "orphan:summary"; reaped: number }

  // Session interruption & resume
  | { type: "session:interrupted"; folder: string; sessionId: string; midTurn: boolean }
  | { type: "session:auto-resume"; folder: string; sessionId: string }

  // Handoff staleness
  | { type: "handoff:stale"; folder: string; sessionId: string }

  // JSONL replay
  | { type: "replay:ok"; folder: string; eventCount: number; skippedLines?: number; sessionId?: string }
  | { type: "replay:fail"; folder: string; error: string; sessionId?: string }

  // Push notifications
  | { type: "push:init"; status: "configured" | "disabled" | "error"; detail?: string }
  | { type: "push:subscriptions-loaded"; count: number }
  | { type: "push:subscriptions-load-error" }
  | { type: "push:subscribe"; total: number }
  | { type: "push:unsubscribe"; total: number }
  | { type: "push:send-ok"; sent: number; tag: string }
  | { type: "push:send-fail"; endpoint: string; error: string }
  | { type: "push:expired-cleanup"; count: number }
  | { type: "push:subscribe-prune"; pruned: number; remaining: number }

  // Folder management
  | { type: "folder:create"; folder: string }
  | { type: "folders:scan-error"; scanRoot: string; error: string }

  // Client error reporting
  | { type: "client:error"; message: string; stack?: string; userAgent?: string; url?: string }

  // Upload / share
  | { type: "upload:deposited"; folder: string; files: number }
  | { type: "share:created"; folder: string; files: number }

  // Request handling
  | { type: "request:http"; method: string; url: string; status: number; durationMs: number }
  | { type: "request:rejected"; reason: string; method: string; url: string }
  | { type: "request:error"; action: string; error: string }

  // Server lifecycle
  | { type: "server:start"; port: number; scanRoot: string }
  | { type: "server:shutdown"; signal: string }
  | { type: "server:shutdown-complete" }
  | { type: "server:uncaught-exception"; error: string }
  | { type: "server:unhandled-rejection"; error: string }
  | { type: "server:persist-error"; error: string };

// -- Level mapping --

const LEVEL_MAP: Record<BridgeEvent["type"], LogLevel> = {
  "session:spawn": "info",
  "session:exit": "info",
  "session:resolve": "info",
  "session:teardown": "info",
  "turn:start": "debug",
  "turn:complete": "info",
  "sse:connect": "info",
  "sse:disconnect": "info",
  "grace:start": "info",
  "grace:expire": "info",
  "grace:skip": "debug",
  "prompt:deliver": "info",
  "prompt:queue": "debug",
  "prompt:outrider": "debug",
  "init:timeout": "error",
  "process:kill": "warn",
  "process:stdin-error": "error",
  "process:non-json": "debug",
  "orphan:skip": "debug",
  "orphan:reap": "info",
  "orphan:sigkill": "warn",
  "orphan:summary": "info",
  "session:interrupted": "info",
  "session:auto-resume": "info",
  "handoff:stale": "info",
  "replay:ok": "info",
  "replay:fail": "warn",
  "push:init": "info",
  "push:subscriptions-loaded": "debug",
  "push:subscriptions-load-error": "warn",
  "push:subscribe": "info",
  "push:unsubscribe": "info",
  "push:send-ok": "debug",
  "push:send-fail": "warn",
  "push:expired-cleanup": "info",
  "push:subscribe-prune": "info",
  "folder:create": "info",
  "folders:scan-error": "warn",
  "client:error": "warn",
  "upload:deposited": "info",
  "share:created": "info",
  "request:http": "debug",
  "request:rejected": "warn",
  "request:error": "error",
  "server:start": "info",
  "server:shutdown": "info",
  "server:shutdown-complete": "info",
  "server:uncaught-exception": "error",
  "server:unhandled-rejection": "error",
  "server:persist-error": "error",
};

export function levelFor(event: BridgeEvent): LogLevel {
  return LEVEL_MAP[event.type];
}
