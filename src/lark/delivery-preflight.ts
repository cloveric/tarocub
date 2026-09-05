import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isCredentialStylePath } from "../runtime/credential-files.js";

export type LarkSendPathKind = "file" | "image" | "audio" | "video";
export type LarkSendToolName = "send.file" | "send.image" | "send.audio" | "send.video" | "send.batch";
export type LarkFileRejectReason =
  | "outside-workspace"
  | "credentials-file"
  | "not-found"
  | "permission-denied"
  | "read-error"
  | "too-large"
  | "batch-too-large"
  | "upload-failed"
  | "delivery-uncertain";

export const LARK_FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
export const LARK_BATCH_ARTIFACT_MAX_COUNT = 20;
export const LARK_BATCH_UPLOAD_MAX_BYTES = 120 * 1024 * 1024;

export interface LarkDeliveryPreflightInput {
  stateDir?: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  allowAnyAbsolutePath?: boolean;
  /** Compatibility hook for focused unit tests that supply one explicit root. */
  explicitAllowedRoots?: readonly string[];
}

export interface ResolvedLarkDeliveryRoots {
  allowedRoots: string[];
  workspaceRoot?: string;
  allowAnyAbsolutePath: boolean;
}

export type LarkPathPreflightResult =
  | {
      ok: true;
      realPath: string;
      fileBytes: number;
      workspaceRoot?: string;
    }
  | {
      ok: false;
      reason: Exclude<LarkFileRejectReason, "batch-too-large" | "upload-failed" | "delivery-uncertain">;
      realPath?: string;
      detail?: string;
      fileBytes?: number;
      workspaceRoot?: string;
    };

export interface LarkSendArtifact {
  path: string;
  kind: LarkSendPathKind;
  caption?: string;
}

export type NormalizedLarkSendTool =
  | {
      ok: true;
      artifacts: LarkSendArtifact[];
      message: string;
    }
  | {
      ok: false;
      reason: "requires_path" | "string_array" | "image_entries" | "too_many_artifacts";
      field?: string;
    };

const SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send.file",
  "send.image",
  "send.audio",
  "send.video",
  "send.batch",
]);

export function isLarkSendToolName(name: string): name is LarkSendToolName {
  return SEND_TOOL_NAMES.has(name);
}

/**
 * Parse exactly the artifact shapes understood by the real Lark sender. Both
 * delivery and the follow-up guard use this function so the protocol cannot
 * drift into two subtly different implementations again.
 */
export function normalizeLarkSendTool(name: LarkSendToolName, payload: unknown): NormalizedLarkSendTool {
  const record = payloadObject(payload);
  if (name !== "send.batch") {
    const filePath = typeof record?.path === "string" ? record.path.trim() : "";
    if (!filePath) {
      return { ok: false, reason: "requires_path" };
    }
    const kind = name.slice("send.".length) as LarkSendPathKind;
    const caption = typeof record?.caption === "string" && record.caption.trim()
      ? record.caption.trim()
      : undefined;
    return {
      ok: true,
      artifacts: [{ path: filePath, kind, ...(caption ? { caption } : {}) }],
      message: "",
    };
  }

  const invalidField = invalidStringArrayField(record, ["files", "audios", "videos"]);
  if (invalidField) {
    return { ok: false, reason: "string_array", field: invalidField };
  }
  const imageEntries = normalizeLarkBatchImages(record?.images);
  if (imageEntries === null) {
    return { ok: false, reason: "image_entries", field: "images" };
  }

  const artifacts: LarkSendArtifact[] = imageEntries.map((image) => ({
    path: image.path,
    kind: "image",
    ...(image.caption ? { caption: image.caption } : {}),
  }));
  for (const filePath of stringArray(record?.files)) {
    artifacts.push({ path: filePath, kind: "file" });
  }
  for (const filePath of stringArray(record?.audios)) {
    artifacts.push({ path: filePath, kind: "audio" });
  }
  for (const filePath of stringArray(record?.videos)) {
    artifacts.push({ path: filePath, kind: "video" });
  }
  if (artifacts.length > LARK_BATCH_ARTIFACT_MAX_COUNT) {
    return { ok: false, reason: "too_many_artifacts", field: "artifacts" };
  }
  return {
    ok: true,
    artifacts,
    message: typeof record?.message === "string" ? record.message : "",
  };
}

export function extractWholeResponseFileBlock(text: string): { fileName: string; body: string } | null {
  const fileMatch = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/u);
  if (!fileMatch || text.replace(fileMatch[0], "").trim().length > 0) {
    return null;
  }
  const fileName = path.basename((fileMatch[1] ?? "").trim());
  const body = fileMatch[2] ?? "";
  if (!fileName || Buffer.byteLength(body, "utf8") === 0) {
    return null;
  }
  return { fileName, body };
}

export function preflightLarkInlineFile(
  file: { fileName: string; body: string },
): { ok: true; fileBytes: number } | { ok: false; reason: "credentials-file" | "too-large"; fileBytes: number } {
  const fileBytes = Buffer.byteLength(file.body, "utf8");
  if (isCredentialStylePath(file.fileName)) {
    return { ok: false, reason: "credentials-file", fileBytes };
  }
  if (fileBytes > LARK_FILE_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: "too-large", fileBytes };
  }
  return { ok: true, fileBytes };
}

export async function resolveLarkDeliveryRoots(
  input: LarkDeliveryPreflightInput,
): Promise<ResolvedLarkDeliveryRoots> {
  const workspaceRoot = input.stateDir
    ? await resolveRoot(path.join(input.stateDir, "workspace"))
    : undefined;
  const candidates = [
    workspaceRoot,
    input.requestOutputDir ? await resolveRoot(input.requestOutputDir) : undefined,
    input.workspaceOverride ? await resolveRoot(input.workspaceOverride) : undefined,
    ...(input.explicitAllowedRoots
      ? await Promise.all(input.explicitAllowedRoots.map(async (root) => await resolveRoot(root)))
      : []),
    ...(input.stateDir ? [await codexGeneratedImagesRoot()] : []),
  ].filter((root): root is string => Boolean(root));

  return {
    allowedRoots: [...new Set(candidates)],
    ...(workspaceRoot ? { workspaceRoot } : {}),
    allowAnyAbsolutePath: input.allowAnyAbsolutePath === true || larkAnyFilePathAllowed(),
  };
}

/** The exact local checks applied before the sender reads and uploads a path. */
export async function preflightLarkDeliveryPath(
  rawPath: string,
  roots: ResolvedLarkDeliveryRoots,
): Promise<LarkPathPreflightResult> {
  const candidate = rawPath.trim();
  if (!candidate) {
    return { ok: false, reason: "not-found", workspaceRoot: roots.workspaceRoot };
  }

  let realPath: string;
  try {
    realPath = await realpath(candidate);
  } catch (error) {
    return {
      ok: false,
      reason: larkFileRejectReasonFromError(error),
      detail: errorDetail(error),
      workspaceRoot: roots.workspaceRoot,
    };
  }
  if (isCredentialStylePath(candidate, realPath)) {
    return {
      ok: false,
      reason: "credentials-file",
      realPath,
      workspaceRoot: roots.workspaceRoot,
    };
  }
  if (
    !roots.allowAnyAbsolutePath
    && !roots.allowedRoots.some((root) => pathIsWithin(realPath, root))
  ) {
    return {
      ok: false,
      reason: "outside-workspace",
      realPath,
      workspaceRoot: roots.workspaceRoot,
    };
  }

  try {
    const fileStat = await stat(realPath);
    if (!fileStat.isFile()) {
      return {
        ok: false,
        reason: "read-error",
        realPath,
        detail: "path is not a regular file",
        workspaceRoot: roots.workspaceRoot,
      };
    }
    if (fileStat.size > LARK_FILE_UPLOAD_MAX_BYTES) {
      return {
        ok: false,
        reason: "too-large",
        realPath,
        detail: `${fileStat.size} bytes > ${LARK_FILE_UPLOAD_MAX_BYTES}`,
        fileBytes: fileStat.size,
        workspaceRoot: roots.workspaceRoot,
      };
    }
    return {
      ok: true,
      realPath,
      fileBytes: fileStat.size,
      workspaceRoot: roots.workspaceRoot,
    };
  } catch (error) {
    return {
      ok: false,
      reason: larkFileRejectReasonFromError(error),
      realPath,
      detail: errorDetail(error),
      workspaceRoot: roots.workspaceRoot,
    };
  }
}

function normalizeLarkBatchImages(value: unknown): Array<{ path: string; caption?: string }> | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: Array<{ path: string; caption?: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (!entry.trim()) {
        return null;
      }
      out.push({ path: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const pathValue = (entry as { path?: unknown }).path;
    if (typeof pathValue !== "string" || !pathValue.trim()) {
      return null;
    }
    const captionRaw = (entry as { caption?: unknown }).caption;
    const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : undefined;
    out.push(caption ? { path: pathValue, caption } : { path: pathValue });
  }
  return out;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function invalidStringArrayField(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return key;
    }
  }
  return null;
}

async function resolveRoot(root: string): Promise<string> {
  return await realpath(root).catch(() => path.resolve(root));
}

function pathIsWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function larkAnyFilePathAllowed(): boolean {
  return /^(?:1|true|yes|on)$/i.test((process.env.CCTB_LARK_ALLOW_ANY_FILE_PATH ?? "").trim());
}

async function codexGeneratedImagesRoot(): Promise<string | undefined> {
  const home = (process.env.CODEX_HOME ?? "").trim()
    || (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  if (!home) {
    return undefined;
  }
  try {
    return await realpath(path.join(home, "generated_images"));
  } catch {
    return undefined;
  }
}

function larkFileRejectReasonFromError(
  error: unknown,
): "not-found" | "permission-denied" | "read-error" {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") {
    return "not-found";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "permission-denied";
  }
  return "read-error";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
