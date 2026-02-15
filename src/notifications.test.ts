// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each test re-imports the module to get fresh state (permissionGranted flag resets)
async function loadModule() {
  vi.resetModules();
  return await import("./notifications.js");
}

describe("notifications", () => {
  let mockNotification: any;

  beforeEach(() => {
    mockNotification = vi.fn();
    mockNotification.permission = "default";
    mockNotification.requestPermission = vi.fn().mockResolvedValue("granted");
    (globalThis as any).Notification = mockNotification;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("requestPermission", () => {
    it("returns true when permission granted", async () => {
      const { requestPermission } = await loadModule();
      const result = await requestPermission();
      expect(result).toBe(true);
      expect(mockNotification.requestPermission).toHaveBeenCalled();
    });

    it("returns true immediately if already granted", async () => {
      const { requestPermission } = await loadModule();
      mockNotification.permission = "granted";
      const result = await requestPermission();
      expect(result).toBe(true);
      expect(mockNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("returns false if denied", async () => {
      const { requestPermission } = await loadModule();
      mockNotification.permission = "denied";
      const result = await requestPermission();
      expect(result).toBe(false);
    });

    it("returns false when user denies prompt", async () => {
      const { requestPermission } = await loadModule();
      mockNotification.requestPermission = vi.fn().mockResolvedValue("denied");
      const result = await requestPermission();
      expect(result).toBe(false);
    });
  });

  describe("notifyTurnComplete", () => {
    it("does not notify when page has focus", async () => {
      const { requestPermission, notifyTurnComplete } = await loadModule();
      mockNotification.permission = "granted";
      await requestPermission();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notifyTurnComplete("myproject");
      expect(mockNotification).not.toHaveBeenCalled();
    });

    it("creates notification when page lacks focus", async () => {
      const { requestPermission, notifyTurnComplete } = await loadModule();
      mockNotification.permission = "granted";
      await requestPermission();
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notifyTurnComplete("myproject");
      expect(mockNotification).toHaveBeenCalledWith(
        "Guéridon",
        expect.objectContaining({
          body: "Claude finished in myproject",
          tag: "gueridon-done-myproject",
        }),
      );
    });
  });

  describe("notifyAskUser", () => {
    it("creates notification with double-vibrate when unfocused", async () => {
      const { requestPermission, notifyAskUser } = await loadModule();
      mockNotification.permission = "granted";
      await requestPermission();
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notifyAskUser("myproject");
      expect(mockNotification).toHaveBeenCalledWith(
        "Guéridon",
        expect.objectContaining({ body: "Claude needs your input in myproject" }),
      );
    });

    it("does not notify when permission not granted", async () => {
      const { notifyAskUser } = await loadModule();
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notifyAskUser("myproject");
      expect(mockNotification).not.toHaveBeenCalled();
    });
  });
});
