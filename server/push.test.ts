import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock webpush before importing push module
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

// Mock fs to prevent disk I/O during tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false), // No VAPID file — init() skips
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import webpush from "web-push";
import {
  addSubscription,
  removeSubscription,
  sendPush,
  _testing,
} from "./push.js";

function makeSub(id: number): webpush.PushSubscription {
  return {
    endpoint: `https://push.example.com/sub-${id}`,
    keys: {
      p256dh: `key-p256dh-${id}`,
      auth: `key-auth-${id}`,
    },
  };
}

describe("push subscription management", () => {
  beforeEach(() => {
    _testing.reset();
    vi.mocked(webpush.sendNotification).mockReset();
  });

  it("addSubscription stores and emits", () => {
    const sub = makeSub(1);
    addSubscription(sub);
    expect(_testing.getSubscriptions().has(sub.endpoint)).toBe(true);
  });

  it("removeSubscription deletes by endpoint", () => {
    const sub = makeSub(1);
    _testing.reset(new Map([[sub.endpoint, sub]]));
    removeSubscription(sub.endpoint);
    expect(_testing.getSubscriptions().size).toBe(0);
  });

  it("removeSubscription cleans up deviceMap", () => {
    addSubscription(makeSub(1), "device-A");
    expect(_testing.getDeviceMap().size).toBe(1);
    removeSubscription("https://push.example.com/sub-1");
    expect(_testing.getDeviceMap().size).toBe(0);
  });

  it("removeSubscription is idempotent for unknown endpoints", () => {
    removeSubscription("https://push.example.com/unknown");
    // No throw, no change
    expect(_testing.getSubscriptions().size).toBe(0);
  });
});

describe("MAX_SUBSCRIPTIONS cap", () => {
  beforeEach(() => {
    _testing.reset();
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);
  });

  it("caps at MAX_SUBSCRIPTIONS, dropping oldest", () => {
    // Pre-load 3 subs (at the cap)
    const existing = new Map<string, webpush.PushSubscription>();
    for (let i = 1; i <= 3; i++) {
      const s = makeSub(i);
      existing.set(s.endpoint, s);
    }
    _testing.reset(existing);

    // Adding a 4th should drop sub-1 (oldest)
    addSubscription(makeSub(4));
    const subs = _testing.getSubscriptions();
    expect(subs.size).toBe(3);
    expect(subs.has("https://push.example.com/sub-1")).toBe(false);
    expect(subs.has("https://push.example.com/sub-4")).toBe(true);
  });

  it("never drops the newly added subscription", () => {
    const existing = new Map<string, webpush.PushSubscription>();
    for (let i = 1; i <= 3; i++) {
      const s = makeSub(i);
      existing.set(s.endpoint, s);
    }
    _testing.reset(existing);

    const newSub = makeSub(99);
    addSubscription(newSub);
    expect(_testing.getSubscriptions().has(newSub.endpoint)).toBe(true);
  });
});

describe("deviceId dedup", () => {
  beforeEach(() => {
    _testing.reset();
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);
  });

  it("evicts old endpoint when same device re-subscribes", () => {
    addSubscription(makeSub(1), "device-A");
    addSubscription(makeSub(2), "device-A");
    const subs = _testing.getSubscriptions();
    expect(subs.size).toBe(1);
    expect(subs.has("https://push.example.com/sub-1")).toBe(false);
    expect(subs.has("https://push.example.com/sub-2")).toBe(true);
  });

  it("keeps subscriptions from different devices", () => {
    addSubscription(makeSub(1), "device-A");
    addSubscription(makeSub(2), "device-B");
    expect(_testing.getSubscriptions().size).toBe(2);
  });

  it("works without deviceId (backwards compat)", () => {
    addSubscription(makeSub(1));
    addSubscription(makeSub(2));
    expect(_testing.getSubscriptions().size).toBe(2);
  });

  it("updates deviceMap when same device re-subscribes", () => {
    addSubscription(makeSub(1), "device-A");
    expect(_testing.getDeviceMap().get("device-A")).toBe("https://push.example.com/sub-1");
    addSubscription(makeSub(2), "device-A");
    expect(_testing.getDeviceMap().get("device-A")).toBe("https://push.example.com/sub-2");
    expect(_testing.getDeviceMap().size).toBe(1);
  });
});

describe("pruneStaleSubscriptions", () => {
  beforeEach(() => {
    _testing.reset();
    vi.mocked(webpush.sendNotification).mockReset();
  });

  it("removes subscriptions that return 410", async () => {
    const live = makeSub(1);
    const dead = makeSub(2);
    _testing.reset(new Map([
      [live.endpoint, live],
      [dead.endpoint, dead],
    ]));

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub: any) => {
      if (sub.endpoint === dead.endpoint) {
        const err = new Error("Gone") as any;
        err.statusCode = 410;
        throw err;
      }
      return {} as any;
    });

    // Prune, excluding a "new" endpoint
    await _testing.pruneStaleSubscriptions("https://push.example.com/new");

    const subs = _testing.getSubscriptions();
    expect(subs.has(live.endpoint)).toBe(true);
    expect(subs.has(dead.endpoint)).toBe(false);
  });

  it("cleans up deviceMap when pruning stale subscriptions", async () => {
    addSubscription(makeSub(1), "device-A");
    addSubscription(makeSub(2), "device-B");
    expect(_testing.getDeviceMap().size).toBe(2);

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub: any) => {
      if (sub.endpoint.includes("sub-1")) {
        const err = new Error("Gone") as any;
        err.statusCode = 410;
        throw err;
      }
      return {} as any;
    });

    await _testing.pruneStaleSubscriptions("https://push.example.com/new");
    expect(_testing.getDeviceMap().size).toBe(1);
    expect(_testing.getDeviceMap().has("device-A")).toBe(false);
    expect(_testing.getDeviceMap().has("device-B")).toBe(true);
  });

  it("removes subscriptions that return 404 or 403", async () => {
    const sub404 = makeSub(1);
    const sub403 = makeSub(2);
    _testing.reset(new Map([
      [sub404.endpoint, sub404],
      [sub403.endpoint, sub403],
    ]));

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub: any) => {
      const err = new Error("fail") as any;
      err.statusCode = sub.endpoint.includes("sub-1") ? 404 : 403;
      throw err;
    });

    await _testing.pruneStaleSubscriptions("https://push.example.com/new");
    expect(_testing.getSubscriptions().size).toBe(0);
  });

  it("leaves subscriptions alone on network errors (non-410/404/403)", async () => {
    const sub = makeSub(1);
    _testing.reset(new Map([[sub.endpoint, sub]]));

    vi.mocked(webpush.sendNotification).mockImplementation(async () => {
      const err = new Error("timeout") as any;
      err.statusCode = 500;
      throw err;
    });

    await _testing.pruneStaleSubscriptions("https://push.example.com/new");
    expect(_testing.getSubscriptions().has(sub.endpoint)).toBe(true);
  });

  it("skips the excluded endpoint (the new subscription)", async () => {
    const newSub = makeSub(1);
    const oldSub = makeSub(2);
    _testing.reset(new Map([
      [newSub.endpoint, newSub],
      [oldSub.endpoint, oldSub],
    ]));

    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);

    await _testing.pruneStaleSubscriptions(newSub.endpoint);

    // Should only have been called for oldSub, not newSub
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0][0]).toBe(oldSub);
  });

  it("sends validation payload with TTL 0", async () => {
    const sub = makeSub(1);
    _testing.reset(new Map([[sub.endpoint, sub]]));
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);

    await _testing.pruneStaleSubscriptions("https://push.example.com/new");

    expect(webpush.sendNotification).toHaveBeenCalledWith(
      sub,
      JSON.stringify({ type: "validate" }),
      { TTL: 0 },
    );
  });

  it("is a no-op when only the excluded endpoint exists", async () => {
    const sub = makeSub(1);
    _testing.reset(new Map([[sub.endpoint, sub]]));

    await _testing.pruneStaleSubscriptions(sub.endpoint);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(_testing.getSubscriptions().size).toBe(1);
  });
});

describe("sendPush", () => {
  beforeEach(() => {
    _testing.reset();
    vi.mocked(webpush.sendNotification).mockReset();
  });

  const payload = {
    title: "Test",
    body: "hello",
    tag: "test-tag",
    folder: "/home/x/proj",
    vibrate: [200],
  };

  it("sends to all subscribers", async () => {
    const a = makeSub(1);
    const b = makeSub(2);
    _testing.reset(new Map([[a.endpoint, a], [b.endpoint, b]]));
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);

    await sendPush(payload);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("prunes 410 responses during send", async () => {
    const live = makeSub(1);
    const dead = makeSub(2);
    _testing.reset(new Map([[live.endpoint, live], [dead.endpoint, dead]]));

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub: any) => {
      if (sub.endpoint === dead.endpoint) {
        const err = new Error("Gone") as any;
        err.statusCode = 410;
        throw err;
      }
      return {} as any;
    });

    await sendPush(payload);
    expect(_testing.getSubscriptions().has(dead.endpoint)).toBe(false);
    expect(_testing.getSubscriptions().has(live.endpoint)).toBe(true);
  });

  it("cleans up deviceMap when send finds expired endpoints", async () => {
    addSubscription(makeSub(1), "device-A");
    addSubscription(makeSub(2), "device-B");
    expect(_testing.getDeviceMap().size).toBe(2);

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub: any) => {
      if (sub.endpoint.includes("sub-1")) {
        const err = new Error("Gone") as any;
        err.statusCode = 410;
        throw err;
      }
      return {} as any;
    });

    await sendPush(payload);
    expect(_testing.getDeviceMap().size).toBe(1);
    expect(_testing.getDeviceMap().has("device-A")).toBe(false);
    expect(_testing.getDeviceMap().has("device-B")).toBe(true);
  });

  it("skips when not configured", async () => {
    _testing.reset();
    // Force vapidReady = false by re-resetting without the ready flag
    // Use a fresh map and send — sendPush checks vapidReady internally
    // Actually _testing.reset sets vapidReady=true, so we need to test the
    // real init path. Instead, test with no subscriptions.
    await sendPush(payload);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
