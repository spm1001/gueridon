/**
 * Event bus — decouples event production from consumption.
 *
 * Business logic calls emit(event). Subscribers receive typed BridgeEvents
 * without coupling to the emitter.
 */

import { EventEmitter } from "node:events";
import type { BridgeEvent } from "./events.ts";

const bus = new EventEmitter();
const EVENT = "bridge";

export function emit(event: BridgeEvent): void {
  bus.emit(EVENT, event);
}

export function subscribe(cb: (event: BridgeEvent) => void): void {
  bus.on(EVENT, cb);
}
