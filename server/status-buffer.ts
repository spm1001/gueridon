/**
 * Circular buffer subscriber — keeps recent events in memory for /status.
 */

import { subscribe } from "./event-bus.ts";
import { levelFor, type BridgeEvent, type LogLevel } from "./events.ts";

interface BufferEntry {
  ts: string;
  level: LogLevel;
  event: BridgeEvent;
}

const CAPACITY = 200;
const buffer: BufferEntry[] = new Array(CAPACITY);
let head = 0;   // next write position
let count = 0;  // total entries written (capped at CAPACITY for reads)

function handleEvent(event: BridgeEvent): void {
  buffer[head] = {
    ts: new Date().toISOString(),
    level: levelFor(event),
    event,
  };
  head = (head + 1) % CAPACITY;
  if (count < CAPACITY) count++;
}

/** Return the last `n` events in chronological order. */
export function getRecent(n?: number): BufferEntry[] {
  const total = Math.min(n ?? count, count);
  const result: BufferEntry[] = new Array(total);
  // oldest relevant entry is at (head - total) mod CAPACITY
  let readPos = (head - total + CAPACITY) % CAPACITY;
  for (let i = 0; i < total; i++) {
    result[i] = buffer[readPos];
    readPos = (readPos + 1) % CAPACITY;
  }
  return result;
}

export function initStatusBuffer(): void {
  subscribe(handleEvent);
}

// Exported for testing
export { handleEvent as _handleEvent, count as _count };
