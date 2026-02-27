/**
 * Per-request context via AsyncLocalStorage.
 *
 * The main HTTP handler wraps each request with run(), making the
 * requestId available to any code in the async call chain — including
 * emit() in the event bus, which auto-attaches it to events.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Generate a short 8-char hex request ID. */
export function generateRequestId(): string {
  return randomBytes(4).toString("hex");
}

/** Get the current request's ID, or undefined if not in a request context. */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
