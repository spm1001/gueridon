/**
 * Structured logger — subscribes to the event bus, writes JSON lines to stderr.
 *
 * Configure via environment:
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 *   LOG_FILE=/path/to/file           (optional, appends)
 */

import { appendFile } from "node:fs/promises";
import { subscribe } from "./event-bus.ts";
import { levelFor, type BridgeEvent, type LogLevel } from "./events.ts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: number = LEVEL_ORDER.info;
let logFile: string | null = null;

function formatLine(event: BridgeEvent, level: LogLevel): string {
  const { type, ...payload } = event;
  return JSON.stringify({ ts: new Date().toISOString(), level, type, ...payload });
}

function handleEvent(event: BridgeEvent): void {
  const level = levelFor(event);
  if (LEVEL_ORDER[level] < minLevel) return;

  const line = formatLine(event, level);
  process.stderr.write(line + "\n");

  if (logFile) {
    appendFile(logFile, line + "\n").catch(() => {
      // Don't recurse — just drop the line if file write fails
    });
  }
}

export function initLogger(): void {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  if (envLevel && envLevel in LEVEL_ORDER) {
    minLevel = LEVEL_ORDER[envLevel];
  }
  logFile = process.env.LOG_FILE || null;
  subscribe(handleEvent);
}

// Exported for testing
export { handleEvent as _handleEvent, formatLine as _formatLine, LEVEL_ORDER };
