/**
 * File deposit logic for uploads and share-sheet intake.
 *
 * Parses multipart or raw binary bodies, validates files via upload.ts,
 * writes them to a deposit folder with a manifest. Reused by both
 * mid-session uploads and new-session share-sheet uploads.
 */

import type { IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { validateFile, sanitiseFilename, buildManifest, depositFolderName, type UploadManifest } from "./upload.js";

export interface DepositResult {
  depositFolder: string;
  manifest: UploadManifest;
  text?: string;
}

/** Map common MIME types to file extensions for raw binary uploads. */
export const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
  "application/json": "json",
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

export function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(new Error("Upload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Parse multipart body, validate files, write to deposit folder.
 * Reused by both handleUpload (mid-session) and handleShareUpload (new-session).
 * Also extracts an optional "text" field for URL/text shares.
 */
export async function depositFiles(req: IncomingMessage, folderPath: string): Promise<DepositResult> {
  const bodyBuf = await readBinaryBody(req);
  // Buffer → Uint8Array with own ArrayBuffer for Web API compatibility.
  // new Uint8Array(buffer) copies into a clean ArrayBuffer (not SharedArrayBuffer),
  // which Request/File/Blob constructors accept natively in Node 18+. (gdn-vojeho)
  const body = new Uint8Array(bodyBuf);
  const contentType = req.headers["content-type"] || "";
  const isMultipart = contentType.startsWith("multipart/");

  const shortId = randomUUID().slice(0, 12);
  const fileEntries: Array<{ name: string; file: File }> = [];
  let text: string | undefined;

  if (isMultipart) {
    // Standard multipart/form-data (Guéridon frontend, curl -F)
    const webReq = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    const formData = await webReq.formData();
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) fileEntries.push({ name: value.name, file: value });
      else if (key === "text" && typeof value === "string" && value.trim()) text = value.trim();
    }
  } else {
    // Raw binary (iOS Shortcuts sends Content-Type: image/png with raw bytes)
    const mime = contentType.split(";")[0].trim() || "application/octet-stream";
    const ext = MIME_EXTENSIONS[mime] || "bin";
    const filename = `upload-${shortId.slice(0, 6)}.${ext}`;
    fileEntries.push({ name: filename, file: new File([body], filename, { type: mime }) });
  }

  if (fileEntries.length === 0) {
    throw new Error("No files in upload");
  }

  const depositFolder = depositFolderName(fileEntries[0].name, shortId);
  const depositPath = join(folderPath, depositFolder);
  mkdirSync(depositPath, { recursive: true });

  const manifestFiles: Array<{ originalName: string; validation: ReturnType<typeof validateFile>; size: number; depositedAs: string }> = [];
  for (const entry of fileEntries) {
    const buf = Buffer.from(await entry.file.arrayBuffer());
    const declaredMime = entry.file.type || "application/octet-stream";
    const validation = validateFile(buf, declaredMime, entry.name);
    const safeName = sanitiseFilename(entry.name);
    await writeFile(join(depositPath, safeName), buf);
    manifestFiles.push({ originalName: entry.name, validation, size: buf.length, depositedAs: safeName });
  }

  const manifest = buildManifest(manifestFiles, shortId);
  await writeFile(join(depositPath, "manifest.json"), JSON.stringify(manifest, null, 2));

  return { depositFolder, manifest, text };
}
