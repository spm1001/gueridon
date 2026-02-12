/**
 * Image upload utilities — pure functions for validation, resize, and encoding.
 * No Lit or framework dependencies. Canvas used for resize only.
 */

export const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** API optimal long edge — larger gets downscaled server-side anyway */
export const MAX_DIMENSION = 1568;
export const JPEG_QUALITY = 0.85;

export interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
}

export function isAcceptedImageType(mimeType: string): boolean {
  return ACCEPTED_IMAGE_TYPES.has(mimeType);
}

/**
 * Compute target dimensions preserving aspect ratio.
 * Returns null if the image is already within bounds (no resize needed).
 */
export function targetDimensions(
  w: number,
  h: number,
  maxDim: number = MAX_DIMENSION,
): { width: number; height: number } | null {
  if (w <= maxDim && h <= maxDim) return null;
  const scale = maxDim / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Output MIME type for a given input type.
 * PNG stays PNG (screenshots need lossless — JPEG artifacts around text).
 * Everything else becomes JPEG (smaller over the wire).
 */
export function outputMimeType(inputType: string): string {
  return inputType === "image/png" ? "image/png" : "image/jpeg";
}

/**
 * Resize an image to fit within MAX_DIMENSION on longest edge.
 * Returns the original file as-is if already within bounds.
 */
export async function resizeImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const target = targetDimensions(bitmap.width, bitmap.height);

  if (!target) {
    bitmap.close();
    return file;
  }

  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();

  const mime = outputMimeType(file.type);
  return canvas.convertToBlob({
    type: mime,
    quality: mime === "image/jpeg" ? JPEG_QUALITY : undefined,
  });
}

/**
 * Convert a Blob to a raw base64 string (no data URI prefix).
 * Uses arrayBuffer() which works in both browser and Node/vitest.
 */
export async function fileToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
