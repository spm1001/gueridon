/**
 * Event bus — decouples event production from consumption.
 *
 * Business logic calls emit(event). Subscribers receive typed BridgeEvents
 * without coupling to the emitter.
 */

import { EventEmitter } from "node:events";
import type { BridgeEvent } from "./events.ts";
import { getRequestId } from "./request-context.js";

const bus = new EventEmitter();
const EVENT = "bridge";

export function emit(event: BridgeEvent): void {
  const requestId = getRequestId();
  const enriched = requestId ? { ...event, requestId } : event;
  for (const listener of bus.listeners(EVENT)) {
    try {
      (listener as (e: BridgeEvent) => void)(enriched);
    } catch (err) {
      // Subscriber errors must not block other subscribers or propagate to callers
      console.error("[event-bus] subscriber threw:", err);
    }
  }
}

export function subscribe(cb: (event: BridgeEvent) => void): void {
  bus.on(EVENT, cb);
}

/** Extract error string with stack trace preserved. */
export function errorDetail(err: unknown): string {
  return err instanceof Error ? err.stack || String(err) : String(err);
}
