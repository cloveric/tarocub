import { open } from "node:fs/promises";
import path from "node:path";

export type SupportedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

const IMAGE_HEADER_BYTES = 12;

export function detectImageMediaType(bytes: Uint8Array): SupportedImageMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function detectImageMediaTypeFromFile(filePath: string): Promise<SupportedImageMediaType | null> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectImageMediaType(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function normalizeImageFileName(fileName: string, mediaType: SupportedImageMediaType): string {
  const extension = path.extname(fileName);
  if (imageMediaTypeFromExtension(extension) === mediaType) {
    return fileName;
  }
  const stem = fileName.slice(0, fileName.length - extension.length) || "image";
  return `${stem}${preferredImageExtension(mediaType)}`;
}

function imageMediaTypeFromExtension(extension: string): SupportedImageMediaType | null {
  switch (extension.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function preferredImageExtension(mediaType: SupportedImageMediaType): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
  }
}
