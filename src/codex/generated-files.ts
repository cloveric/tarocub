import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|webp|gif)$/i;
const AUTO_DELIVERABLE_FILE_PATTERN = /\.(?:csv|tsv|pdf|docx?|xlsx?|pptx?|html?|zip)$/i;
const SAVED_ARTIFACT_LINE_PATTERN = /^\s*(?:saved|wrote|written|created|generated|exported)(?:\s+(?:image|file|chart|plot|report|output))?(?:\s+(?:to|at))?\s*[:：]?\s*(.+?)\s*$/i;

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

/**
 * Convert an explicit final-process save marker into a bridge delivery tag.
 * This is intentionally narrower than general path extraction: only regular,
 * non-hidden files inside the worker workspace and with a known output type
 * are eligible. The channel delivery layer still performs its own sandbox,
 * credential, size, and MIME checks before sending anything.
 */
export async function appendSavedArtifactDeliveryTags(text: string, workspacePath: string): Promise<string> {
  const candidates = extractSavedArtifactCandidates(text);
  if (candidates.length === 0) {
    return text;
  }

  const workspaceRoot = await realpath(workspacePath).catch(() => null);
  if (!workspaceRoot) {
    return text;
  }

  let next = text.trim();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || seen.has(resolved)) {
      continue;
    }
    const relative = path.relative(workspaceRoot, resolved);
    if (
      !relative
      || relative.startsWith(`..${path.sep}`)
      || relative === ".."
      || path.isAbsolute(relative)
      || relative.split(path.sep).some((segment) => segment.startsWith("."))
    ) {
      continue;
    }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }

    seen.add(resolved);
    const tag = IMAGE_FILE_PATTERN.test(resolved)
      ? `[send-image:${candidate}]`
      : `[send-file:${candidate}]`;
    if (!next.includes(tag)) {
      next = [next, tag].filter(Boolean).join("\n");
    }
  }
  return next;
}

function extractSavedArtifactCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.match(SAVED_ARTIFACT_LINE_PATTERN)?.[1];
    if (!raw) {
      continue;
    }
    const candidate = unwrapSavedPath(raw);
    if (
      path.isAbsolute(candidate)
      && !candidate.includes("\0")
      && (IMAGE_FILE_PATTERN.test(candidate) || AUTO_DELIVERABLE_FILE_PATTERN.test(candidate))
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function unwrapSavedPath(value: string): string {
  let candidate = value.trim().replace(/[.,;，。；]+$/, "");
  const first = candidate[0];
  const last = candidate[candidate.length - 1];
  if (candidate.length >= 2 && (
    (first === '"' && last === '"')
    || (first === "'" && last === "'")
    || (first === "`" && last === "`")
  )) {
    candidate = candidate.slice(1, -1).trim();
  }
  return candidate;
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
