/**
 * Upload validation and mise-style file deposit.
 *
 * Pure functions — no IO, no network, no process management.
 * Bridge wires these into the /upload HTTP handler.
 *
 * Follows the mise-en-space deposit pattern:
 *   mise/upload--{slug}--{uuid}/
 *     manifest.json   (self-describing metadata)
 *     photo.jpg       (deposited file)
 *     notes.txt       (deposited file)
 */

// -- Magic byte signatures for MIME validation --
// See: https://en.wikipedia.org/wiki/List_of_file_signatures

interface MagicSignature {
  mime: string;
  magic: number[];
  offset?: number; // byte offset to start matching (default 0)
}

const SIGNATURES: MagicSignature[] = [
  { mime: "image/png",        magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg",       magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif",        magic: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mime: "image/webp",       magic: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // RIFF....WEBP
  { mime: "image/bmp",        magic: [0x42, 0x4d] }, // BM
  { mime: "application/pdf",  magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

// MIME types that require magic-byte validation.
// Text files, CSVs, etc. pass through without validation.
const VALIDATED_MIME_PREFIXES = ["image/", "application/pdf"];

// -- MIME detection --

/**
 * Detect MIME type from file content using magic byte signatures.
 * Returns null if no known signature matches.
 */
export function detectMime(bytes: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (bytes.length < offset + sig.magic.length) continue;
    let match = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (bytes[offset + i] !== sig.magic[i]) { match = false; break; }
    }
    if (match) return sig.mime;
  }

  // SVG: check for <?xml or <svg in first 256 bytes
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, Math.min(256, bytes.length)).toString("utf-8").trim();
    if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  }

  return null;
}

// -- File validation --

export interface FileValidation {
  /** True if the file is safe to deposit and reference by its MIME type. */
  valid: boolean;
  /** The MIME type to record in the manifest (may differ from declared). */
  effectiveMime: string;
  /** The MIME type the client declared (Content-Type header). */
  declaredMime: string;
  /** What we actually detected from magic bytes (null if no match). */
  detectedMime: string | null;
  /** Human-readable warning if MIME was corrected or unrecognised. */
  warning: string | null;
}

/**
 * Validate a file's content against its declared MIME type.
 *
 * Strategy: never reject, always deposit, but make the manifest truthful.
 * - MIME match: valid, no correction needed.
 * - MIME mismatch (JPEG claiming PNG): correct to detected MIME, warn.
 * - Unrecognised image bytes: downgrade to application/octet-stream, warn.
 * - Non-image files (text, CSV, etc.): skip validation, pass through.
 *
 * This prevents context poisoning — a file claiming to be image/png but
 * containing garbage will not be passed to the vision API.
 */
export function validateFile(
  bytes: Buffer,
  declaredMime: string,
  filename: string,
): FileValidation {
  // Non-image, non-PDF: no validation needed
  const needsValidation = VALIDATED_MIME_PREFIXES.some((p) => declaredMime.startsWith(p));
  if (!needsValidation) {
    return {
      valid: true,
      effectiveMime: declaredMime,
      declaredMime,
      detectedMime: detectMime(bytes),
      warning: null,
    };
  }

  const detected = detectMime(bytes);

  // No known signature matches a declared image → downgrade to binary
  if (!detected) {
    return {
      valid: true, // still deposit, but as binary
      effectiveMime: "application/octet-stream",
      declaredMime,
      detectedMime: null,
      warning: `${filename}: declared as ${declaredMime} but content doesn't match any known image format — deposited as binary`,
    };
  }

  // Normalise JPEG variants before comparing
  const norm = (m: string) => m.replace("image/jpg", "image/jpeg");
  if (norm(detected) === norm(declaredMime)) {
    return {
      valid: true,
      effectiveMime: declaredMime,
      declaredMime,
      detectedMime: detected,
      warning: null,
    };
  }

  // MIME mismatch: correct to what the bytes actually are
  return {
    valid: true,
    effectiveMime: detected,
    declaredMime,
    detectedMime: detected,
    warning: `${filename}: declared as ${declaredMime} but content is ${detected} — MIME corrected`,
  };
}

// -- Slugify --

/**
 * Convert text to a filesystem-safe slug.
 * Ported from mise-en-space/workspace/manager.py.
 */
export function slugify(text: string, maxLength = 50): string {
  let s = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, ""); // strip non-ASCII
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-"); // non-alnum → hyphen
  s = s.replace(/^-+|-+$/g, "");     // trim leading/trailing hyphens
  s = s.replace(/-{2,}/g, "-");       // collapse runs
  if (s.length > maxLength) {
    s = s.slice(0, maxLength).replace(/-$/, ""); // trim at hyphen boundary
  }
  return s || "untitled";
}

/**
 * Sanitise a filename for deposit on disk.
 * Keeps alphanumeric, dots, hyphens, underscores. Everything else → underscore.
 */
export function sanitiseFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

// -- Manifest --

export interface DepositedFile {
  original_name: string;
  mime_type: string;
  /** Only present when MIME was corrected from the declared value. */
  declared_mime?: string;
  size_bytes: number;
  deposited_as: string;
}

export interface UploadManifest {
  type: "upload";
  title: string;
  id: string;
  fetched_at: string;
  file_count: number;
  files: DepositedFile[];
  warnings: string[];
}

/**
 * Build a manifest object for deposited files.
 * Does not write to disk — caller handles IO.
 */
export function buildManifest(
  files: Array<{ originalName: string; validation: FileValidation; size: number; depositedAs: string }>,
  shortId: string,
): UploadManifest {
  const warnings: string[] = [];
  const deposited: DepositedFile[] = [];

  for (const f of files) {
    const entry: DepositedFile = {
      original_name: f.originalName,
      mime_type: f.validation.effectiveMime,
      size_bytes: f.size,
      deposited_as: f.depositedAs,
    };
    // Record the declared MIME only when it differs from effective
    if (f.validation.effectiveMime !== f.validation.declaredMime) {
      entry.declared_mime = f.validation.declaredMime;
    }
    deposited.push(entry);

    if (f.validation.warning) {
      warnings.push(f.validation.warning);
    }
  }

  return {
    type: "upload",
    title: files[0]?.originalName || "untitled",
    id: shortId,
    fetched_at: new Date().toISOString(),
    file_count: files.length,
    files: deposited,
    warnings,
  };
}

/**
 * Build the context note injected into CC via deliverPrompt.
 * Prefixed with [guéridon:upload] for synthetic message detection (see gdn-jovemi).
 */
export function buildDepositNote(folder: string, manifest: UploadManifest): string {
  const listing = manifest.files
    .map((f) => `  - ${f.deposited_as} (${f.mime_type}, ${f.size_bytes} bytes)`)
    .join("\n");

  const warningLines = manifest.warnings.length > 0
    ? "\n\n⚠️ " + manifest.warnings.join("\n⚠️ ")
    : "";

  return `[guéridon:upload] Files deposited at ${folder}/\n\n${listing}${warningLines}\n\nmanifest.json has full metadata. Read the files if relevant to our conversation.`;
}

/**
 * Compute the deposit folder name for a set of uploaded files.
 * Returns just the relative path (e.g. "mise/upload--photo--a3f2c1d4-beef").
 * Caller creates the directory and writes files into it.
 */
export function depositFolderName(primaryFilename: string, shortId: string): string {
  const slug = slugify(primaryFilename.replace(/\.[^.]+$/, "")); // strip extension
  return `mise/upload--${slug}--${shortId}`;
}
