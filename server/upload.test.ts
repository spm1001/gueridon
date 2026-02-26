import { describe, it, expect } from "vitest";
import {
  detectMime,
  validateFile,
  slugify,
  sanitiseFilename,
  buildManifest,
  buildDepositNote,
  buildShareDepositNote,
  depositFolderName,
} from "./upload.js";

// -- Real file headers for testing --

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_HEADER = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const BMP_HEADER = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
const PDF_HEADER = Buffer.from("%PDF-1.4 fake content");
const SVG_CONTENT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const SVG_WITH_XML = Buffer.from('<?xml version="1.0"?><svg><rect/></svg>');
const GARBAGE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
const TEXT_CONTENT = Buffer.from("Hello, world!");

// ============================================================
// detectMime
// ============================================================

describe("detectMime", () => {
  it("detects PNG", () => expect(detectMime(PNG_HEADER)).toBe("image/png"));
  it("detects JPEG", () => expect(detectMime(JPEG_HEADER)).toBe("image/jpeg"));
  it("detects GIF", () => expect(detectMime(GIF_HEADER)).toBe("image/gif"));
  it("detects WebP", () => expect(detectMime(WEBP_HEADER)).toBe("image/webp"));
  it("detects BMP", () => expect(detectMime(BMP_HEADER)).toBe("image/bmp"));
  it("detects PDF", () => expect(detectMime(PDF_HEADER)).toBe("application/pdf"));
  it("detects SVG with <svg> tag", () => expect(detectMime(SVG_CONTENT)).toBe("image/svg+xml"));
  it("detects SVG with <?xml> preamble", () => expect(detectMime(SVG_WITH_XML)).toBe("image/svg+xml"));
  it("returns null for unrecognised bytes", () => expect(detectMime(GARBAGE)).toBeNull());
  it("returns null for plain text", () => expect(detectMime(TEXT_CONTENT)).toBeNull());
  it("returns null for empty buffer", () => expect(detectMime(Buffer.alloc(0))).toBeNull());
  it("returns null for buffer too short for any signature", () => {
    expect(detectMime(Buffer.from([0x89]))).toBeNull();
  });
});

// ============================================================
// validateFile
// ============================================================

describe("validateFile", () => {
  describe("matching MIME", () => {
    it("PNG bytes + declared PNG → valid, no warning", () => {
      const r = validateFile(PNG_HEADER, "image/png", "photo.png");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("image/png");
      expect(r.warning).toBeNull();
    });

    it("JPEG bytes + declared JPEG → valid", () => {
      const r = validateFile(JPEG_HEADER, "image/jpeg", "photo.jpg");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("image/jpeg");
      expect(r.warning).toBeNull();
    });

    it("PDF bytes + declared PDF → valid", () => {
      const r = validateFile(PDF_HEADER, "application/pdf", "doc.pdf");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("application/pdf");
      expect(r.warning).toBeNull();
    });
  });

  describe("MIME mismatch — corrected", () => {
    it("JPEG bytes declared as PNG → corrected to image/jpeg", () => {
      const r = validateFile(JPEG_HEADER, "image/png", "lies.png");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("image/jpeg");
      expect(r.declaredMime).toBe("image/png");
      expect(r.detectedMime).toBe("image/jpeg");
      expect(r.warning).toContain("lies.png");
      expect(r.warning).toContain("corrected");
    });

    it("PNG bytes declared as JPEG → corrected to image/png", () => {
      const r = validateFile(PNG_HEADER, "image/jpeg", "wrong.jpg");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("image/png");
      expect(r.warning).toContain("corrected");
    });
  });

  describe("JPEG variant normalisation", () => {
    it("image/jpg treated as equivalent to image/jpeg", () => {
      const r = validateFile(JPEG_HEADER, "image/jpg", "photo.jpg");
      expect(r.valid).toBe(true);
      expect(r.warning).toBeNull();
    });
  });

  describe("unrecognised image bytes — downgraded to binary", () => {
    it("garbage declared as JPEG → octet-stream", () => {
      const r = validateFile(GARBAGE, "image/jpeg", "evil.jpg");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("application/octet-stream");
      expect(r.warning).toContain("evil.jpg");
      expect(r.warning).toContain("binary");
    });

    it("garbage declared as PNG → octet-stream", () => {
      const r = validateFile(GARBAGE, "image/png", "bad.png");
      expect(r.effectiveMime).toBe("application/octet-stream");
    });
  });

  describe("non-image files — skip validation", () => {
    it("text/plain passes through without validation", () => {
      const r = validateFile(TEXT_CONTENT, "text/plain", "notes.txt");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("text/plain");
      expect(r.warning).toBeNull();
    });

    it("text/csv passes through", () => {
      const r = validateFile(Buffer.from("a,b,c"), "text/csv", "data.csv");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("text/csv");
      expect(r.warning).toBeNull();
    });

    it("application/json passes through", () => {
      const r = validateFile(Buffer.from('{"key":"val"}'), "application/json", "data.json");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("application/json");
      expect(r.warning).toBeNull();
    });

    it("text/markdown passes through", () => {
      const r = validateFile(Buffer.from("# Hello"), "text/markdown", "readme.md");
      expect(r.valid).toBe(true);
      expect(r.effectiveMime).toBe("text/markdown");
      expect(r.warning).toBeNull();
    });
  });
});

// ============================================================
// slugify
// ============================================================

describe("slugify", () => {
  it("lowercases and hyphenates", () => expect(slugify("Hello World")).toBe("hello-world"));
  it("strips non-ASCII", () => expect(slugify("résumé")).toBe("resume"));
  it("collapses hyphens", () => expect(slugify("a---b")).toBe("a-b"));
  it("trims leading/trailing hyphens", () => expect(slugify("--hello--")).toBe("hello"));
  it("truncates to maxLength", () => {
    const long = "a".repeat(100);
    expect(slugify(long, 10).length).toBeLessThanOrEqual(10);
  });
  it("returns 'untitled' for empty input", () => expect(slugify("")).toBe("untitled"));
  it("returns 'untitled' for all-punctuation input", () => expect(slugify("!!!")).toBe("untitled"));
  it("handles filename with extension", () => expect(slugify("photo.jpg")).toBe("photo-jpg"));
  it("handles spaces and special chars", () => expect(slugify("My Photo (2).png")).toBe("my-photo-2-png"));
});

// ============================================================
// sanitiseFilename
// ============================================================

describe("sanitiseFilename", () => {
  it("preserves safe characters", () => expect(sanitiseFilename("photo.jpg")).toBe("photo.jpg"));
  it("replaces spaces with underscores", () => expect(sanitiseFilename("my photo.jpg")).toBe("my_photo.jpg"));
  it("replaces unicode with underscores", () => expect(sanitiseFilename("résumé.pdf")).toBe("r_sum_.pdf"));
  it("preserves hyphens and underscores", () => expect(sanitiseFilename("my-file_v2.txt")).toBe("my-file_v2.txt"));
  it("returns 'file' for empty input", () => expect(sanitiseFilename("")).toBe("file"));
});

// ============================================================
// buildManifest
// ============================================================

describe("buildManifest", () => {
  it("builds manifest for clean upload", () => {
    const m = buildManifest([{
      originalName: "photo.jpg",
      validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/jpeg", detectedMime: "image/jpeg", warning: null },
      size: 1234,
      depositedAs: "photo.jpg",
    }], "abc123");

    expect(m.type).toBe("upload");
    expect(m.title).toBe("photo.jpg");
    expect(m.id).toBe("abc123");
    expect(m.file_count).toBe(1);
    expect(m.files[0].mime_type).toBe("image/jpeg");
    expect(m.files[0].declared_mime).toBeUndefined();
    expect(m.warnings).toHaveLength(0);
  });

  it("records declared_mime when corrected", () => {
    const m = buildManifest([{
      originalName: "lies.png",
      validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/png", detectedMime: "image/jpeg", warning: "lies.png: corrected" },
      size: 5678,
      depositedAs: "lies.png",
    }], "def456");

    expect(m.files[0].mime_type).toBe("image/jpeg");
    expect(m.files[0].declared_mime).toBe("image/png");
    expect(m.warnings).toEqual(["lies.png: corrected"]);
  });

  it("handles multiple files", () => {
    const m = buildManifest([
      { originalName: "a.jpg", validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/jpeg", detectedMime: "image/jpeg", warning: null }, size: 100, depositedAs: "a.jpg" },
      { originalName: "b.txt", validation: { valid: true, effectiveMime: "text/plain", declaredMime: "text/plain", detectedMime: null, warning: null }, size: 50, depositedAs: "b.txt" },
    ], "multi");

    expect(m.file_count).toBe(2);
    expect(m.title).toBe("a.jpg"); // title from first file
  });
});

// ============================================================
// buildDepositNote
// ============================================================

describe("buildDepositNote", () => {
  it("includes synthetic prefix", () => {
    const m = buildManifest([{
      originalName: "photo.jpg",
      validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/jpeg", detectedMime: "image/jpeg", warning: null },
      size: 1234,
      depositedAs: "photo.jpg",
    }], "abc123");

    const note = buildDepositNote("mise/upload--photo--abc123", m);
    expect(note).toMatch(/^\[guéridon:upload\]/);
    expect(note).toContain("mise/upload--photo--abc123/");
    expect(note).toContain("photo.jpg (image/jpeg, 1234 bytes)");
    expect(note).toContain("manifest.json");
  });

  it("includes warnings when present", () => {
    const m = buildManifest([{
      originalName: "bad.png",
      validation: { valid: true, effectiveMime: "application/octet-stream", declaredMime: "image/png", detectedMime: null, warning: "bad.png: deposited as binary" },
      size: 6,
      depositedAs: "bad.png",
    }], "warn1");

    const note = buildDepositNote("mise/upload--bad--warn1", m);
    expect(note).toContain("⚠️");
    expect(note).toContain("deposited as binary");
  });
});

// ============================================================
// buildShareDepositNote
// ============================================================

describe("buildShareDepositNote", () => {
  it("uses [guéridon:share] prefix", () => {
    const m = buildManifest([{
      originalName: "whiteboard.jpg",
      validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/jpeg", detectedMime: "image/jpeg", warning: null },
      size: 45000,
      depositedAs: "whiteboard.jpg",
    }], "abc123");

    const note = buildShareDepositNote("mise/upload--whiteboard--abc123", m);
    expect(note).toMatch(/^\[guéridon:share\]/);
    expect(note).toContain("iOS");
    expect(note).toContain("whiteboard.jpg");
    expect(note).toContain("Examine the content");
  });

  it("includes shared text when provided", () => {
    const m = buildManifest([{
      originalName: "screenshot.png",
      validation: { valid: true, effectiveMime: "image/png", declaredMime: "image/png", detectedMime: "image/png", warning: null },
      size: 8000,
      depositedAs: "screenshot.png",
    }], "txt1");

    const note = buildShareDepositNote("mise/upload--screenshot--txt1", m, "https://example.com/article");
    expect(note).toContain("Shared text:");
    expect(note).toContain("https://example.com/article");
  });

  it("omits shared text section when not provided", () => {
    const m = buildManifest([{
      originalName: "photo.jpg",
      validation: { valid: true, effectiveMime: "image/jpeg", declaredMime: "image/jpeg", detectedMime: "image/jpeg", warning: null },
      size: 1234,
      depositedAs: "photo.jpg",
    }], "no-txt");

    const note = buildShareDepositNote("mise/upload--photo--no-txt", m);
    expect(note).not.toContain("Shared text:");
  });

  it("includes warnings when present", () => {
    const m = buildManifest([{
      originalName: "bad.png",
      validation: { valid: true, effectiveMime: "application/octet-stream", declaredMime: "image/png", detectedMime: null, warning: "bad.png: deposited as binary" },
      size: 6,
      depositedAs: "bad.png",
    }], "warn1");

    const note = buildShareDepositNote("mise/upload--bad--warn1", m);
    expect(note).toContain("⚠️");
    expect(note).toContain("deposited as binary");
  });
});

// ============================================================
// depositFolderName
// ============================================================

describe("depositFolderName", () => {
  it("builds mise/upload-- path", () => {
    const name = depositFolderName("photo.jpg", "abc123def456");
    expect(name).toBe("mise/upload--photo--abc123def456");
  });

  it("strips extension before slugifying", () => {
    const name = depositFolderName("My Document.pdf", "xyz");
    expect(name).toBe("mise/upload--my-document--xyz");
  });

  it("handles unicode filenames", () => {
    const name = depositFolderName("résumé.pdf", "id1");
    expect(name).toBe("mise/upload--resume--id1");
  });
});
