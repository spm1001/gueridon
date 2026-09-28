/**
 * Service-worker routing: which requests sw.js answers itself (network-first + cache) and
 * which it leaves to the network untouched. Runs the real sw.js in a vm with a fake `self`
 * and dispatches fetch events at it.
 *
 * The case that matters (gdn-jojino): the launcher's live roster is an SSE stream at
 * GET /sessions/events. The shell branch clones every OK response into Cache Storage, and
 * `cache.put` on a stream that never ends never completes — a write that grows for as long
 * as the launcher is open, once per reconnect. Streams and liveness endpoints must bypass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = readFileSync(join(fileURLToPath(import.meta.url), "../../sw.js"), "utf-8");

function loadWorker() {
  const handlers: Record<string, (ev: unknown) => void> = {};
  const self = {
    location: { origin: "https://gdn.example" },
    addEventListener: (type: string, fn: (ev: unknown) => void) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const never = () => new Promise(() => {});
  vm.runInNewContext(SRC, { self, caches: { open: never, keys: never, match: never }, fetch: never, Response, URL });
  /** True when sw.js takes the request over (respondWith); false when it lets it pass. */
  return (path: string, method = "GET"): boolean => {
    let answered = false;
    handlers.fetch({
      request: { method, url: `https://gdn.example${path}`, mode: "cors" },
      respondWith: () => { answered = true; },
    });
    return answered;
  };
}

describe("sw.js fetch routing", () => {
  const handles = loadWorker();

  it("leaves the launcher's SSE roster stream alone (gdn-jojino)", () => {
    expect(handles("/sessions/events")).toBe(false);
  });

  it("leaves the chat view's SSE stream and the roster/liveness endpoints alone", () => {
    for (const p of ["/events?clientId=x", "/sessions", "/recent", "/ledger?session=x", "/rc", "/repos", "/status", "/folders"]) {
      expect(handles(p), p).toBe(false);
    }
  });

  it("still answers shell assets itself (network-first, cached for offline) — the control", () => {
    for (const p of ["/launch.html", "/", "/style.css", "/manifest.json"]) expect(handles(p), p).toBe(true);
  });

  it("never touches non-GET requests", () => {
    expect(handles("/launch/acme%2Fwidgets", "POST")).toBe(false);
  });
});
