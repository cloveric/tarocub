import path from "node:path";

const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|webp|gif)$/i;

export function sendImageTag(filePath: string): string {
  return `[send-image:${filePath}]`;
}

export function appendUniqueSendImageTag(text: string, filePath: string): string {
  const tag = sendImageTag(filePath);
  if (text.includes(tag)) {
    return text;
  }
  return [text.trim(), tag].filter(Boolean).join("\n");
}

export function extractGeneratedImagePath(value: unknown): string | null {
  return extractGeneratedImagePathInternal(value, 0, false);
}

function extractGeneratedImagePathInternal(value: unknown, depth: number, generatedContext: boolean): string | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return generatedContext && isDeliverableImagePath(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGeneratedImagePathInternal(item, depth + 1, generatedContext);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const nextGeneratedContext = generatedContext || isGeneratedImageRecord(record);

  for (const key of ["saved_path", "savedPath"]) {
    const direct = record[key];
    if (typeof direct === "string" && isDeliverableImagePath(direct)) {
      return direct;
    }
  }

  if (nextGeneratedContext) {
    for (const key of ["path", "file_path", "filePath"]) {
      const direct = record[key];
      if (typeof direct === "string" && isDeliverableImagePath(direct)) {
        return direct;
      }
    }
  }

  for (const key of ["payload", "item", "result", "results", "output", "content", "data"]) {
    const found = extractGeneratedImagePathInternal(record[key], depth + 1, nextGeneratedContext);
    if (found) {
      return found;
    }
  }

  return null;
}

function isDeliverableImagePath(value: string): boolean {
  return path.isAbsolute(value) && IMAGE_FILE_PATTERN.test(value.trim());
}

function isGeneratedImageRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : "";
  const subtype = typeof record.subtype === "string" ? record.subtype : "";
  return [
    type,
    subtype,
  ].some((value) => /image[_-]?generation|imageGeneration|output[_-]?image|generated[_-]?image/i.test(value));
}
