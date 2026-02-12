import { describe, it, expect, vi } from "vitest";
import {
  isAcceptedImageType,
  targetDimensions,
  outputMimeType,
  fileToBase64,
  ACCEPTED_IMAGE_TYPES,
  MAX_DIMENSION,
} from "./image-utils.js";

describe("isAcceptedImageType", () => {
  it("accepts the four supported types", () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(isAcceptedImageType(type)).toBe(true);
    }
  });

  it("rejects unsupported image types", () => {
    expect(isAcceptedImageType("image/svg+xml")).toBe(false);
    expect(isAcceptedImageType("image/tiff")).toBe(false);
    expect(isAcceptedImageType("image/bmp")).toBe(false);
    expect(isAcceptedImageType("image/heic")).toBe(false);
  });

  it("rejects non-image types", () => {
    expect(isAcceptedImageType("application/pdf")).toBe(false);
    expect(isAcceptedImageType("text/plain")).toBe(false);
    expect(isAcceptedImageType("")).toBe(false);
  });
});

describe("targetDimensions", () => {
  it("returns null when image is within bounds", () => {
    expect(targetDimensions(800, 600)).toBeNull();
    expect(targetDimensions(MAX_DIMENSION, MAX_DIMENSION)).toBeNull();
    expect(targetDimensions(1, 1)).toBeNull();
  });

  it("scales landscape image to fit", () => {
    const result = targetDimensions(4032, 3024);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(MAX_DIMENSION);
    expect(result!.height).toBe(Math.round(3024 * (MAX_DIMENSION / 4032)));
    expect(result!.width).toBeLessThanOrEqual(MAX_DIMENSION);
    expect(result!.height).toBeLessThanOrEqual(MAX_DIMENSION);
  });

  it("scales portrait image to fit", () => {
    const result = targetDimensions(3024, 4032);
    expect(result).not.toBeNull();
    expect(result!.height).toBe(MAX_DIMENSION);
    expect(result!.width).toBe(Math.round(3024 * (MAX_DIMENSION / 4032)));
  });

  it("scales square image to fit", () => {
    const result = targetDimensions(3000, 3000);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(MAX_DIMENSION);
    expect(result!.height).toBe(MAX_DIMENSION);
  });

  it("handles one dimension over, one under", () => {
    const result = targetDimensions(2000, 500);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(MAX_DIMENSION);
    expect(result!.height).toBe(Math.round(500 * (MAX_DIMENSION / 2000)));
  });

  it("respects custom maxDim", () => {
    const result = targetDimensions(200, 100, 50);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(50);
    expect(result!.height).toBe(25);
  });

  it("returns null at exact boundary", () => {
    expect(targetDimensions(MAX_DIMENSION, 1)).toBeNull();
    expect(targetDimensions(1, MAX_DIMENSION)).toBeNull();
  });
});

describe("outputMimeType", () => {
  it("preserves PNG", () => {
    expect(outputMimeType("image/png")).toBe("image/png");
  });

  it("converts JPEG to JPEG", () => {
    expect(outputMimeType("image/jpeg")).toBe("image/jpeg");
  });

  it("converts WebP to JPEG", () => {
    expect(outputMimeType("image/webp")).toBe("image/jpeg");
  });

  it("converts GIF to JPEG", () => {
    expect(outputMimeType("image/gif")).toBe("image/jpeg");
  });
});

describe("fileToBase64", () => {
  it("converts blob to base64 string without data URI prefix", async () => {
    const text = "hello world";
    const blob = new Blob([text], { type: "text/plain" });
    const result = await fileToBase64(blob);
    // Verify it's raw base64 (no "data:text/plain;base64," prefix)
    expect(result).not.toContain("data:");
    expect(result).not.toContain(";base64,");
    // Verify round-trip
    expect(atob(result)).toBe(text);
  });

  it("handles binary data", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const result = await fileToBase64(blob);
    expect(result).not.toContain("data:");
    const decoded = atob(result);
    expect(decoded.length).toBe(6);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(3)).toBe(255);
  });
});
