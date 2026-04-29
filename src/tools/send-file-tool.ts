import { deliverTelegramResponse } from "../telegram/response-delivery.js";
import { isAbsoluteFilePath } from "../telegram/file-paths.js";
import type {
  TelegramToolContext,
  TelegramToolResult,
} from "./telegram-tool-types.js";

const MAX_SEND_TOOL_FILES = 20;

interface SendBatchPayload {
  message?: string;
  images: string[];
  files: string[];
}

function parsePayloadObject(payload: unknown): Record<string, unknown> {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asOptionalMessage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("message must be a string");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asPath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const filePath = value.trim();
  if (!isAbsoluteFilePath(filePath)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return filePath;
}

function asPathArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item) => asPath(item, field));
}

function uniqueFilePaths(payload: SendBatchPayload): string[] {
  return [...new Set([...payload.images, ...payload.files])];
}

function normalizeSendBatchPayload(payload: unknown): SendBatchPayload {
  const body = parsePayloadObject(payload);
  const message = asOptionalMessage(body.message);
  const images = asPathArray(body.images, "images");
  const files = asPathArray(body.files, "files");
  if (!message && images.length === 0 && files.length === 0) {
    throw new Error("message or file is required");
  }
  if (images.length + files.length > MAX_SEND_TOOL_FILES) {
    throw new Error(`too many files: maximum ${MAX_SEND_TOOL_FILES}`);
  }
  return { message, images, files };
}

function normalizeSinglePathPayload(payload: unknown, preferPhoto: boolean): SendBatchPayload {
  const body = parsePayloadObject(payload);
  const filePath = asPath(body.path);
  const message = asOptionalMessage(body.message);
  return {
    message,
    images: preferPhoto ? [filePath] : [],
    files: preferPhoto ? [] : [filePath],
  };
}

function escapeEmbeddedDeliveryTags(message: string): string {
  return message
    .replace(/\[(send-file|send-image):([^\]\r\n]*)\]/g, "［$1:$2］")
    .replace(/\[(send-file|send-image):/g, "［$1:");
}

function renderDeliveryText(payload: SendBatchPayload): string {
  const lines: string[] = [];
  if (payload.message) {
    lines.push(escapeEmbeddedDeliveryTags(payload.message));
  }
  for (const image of payload.images) {
    lines.push(`[send-image:${image}]`);
  }
  for (const file of payload.files) {
    lines.push(`[send-file:${file}]`);
  }
  return lines.join("\n");
}

function renderRejected(detail: string, locale: TelegramToolContext["locale"]): TelegramToolResult {
  return {
    ok: false,
    status: "rejected",
    message: locale === "zh" ? `✗ 文件发送失败：${detail}` : `✗ File delivery failed: ${detail}`,
    error: detail,
  };
}

function requireDeliveryContext(context: TelegramToolContext): NonNullable<TelegramToolContext["delivery"]> {
  if (!context.delivery) {
    throw new Error("delivery context is not available");
  }
  return context.delivery;
}

export async function executeSendBatchTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const delivery = requireDeliveryContext(context);
    const normalized = normalizeSendBatchPayload(payload);
    const requestedPaths = uniqueFilePaths(normalized);
    const acceptedPaths = new Set<string>();
    const rejected: string[] = [];
    const deliver = delivery.deliverTelegramResponse ?? deliverTelegramResponse;
    const filesSent = await deliver(
      delivery.api,
      context.chatId,
      renderDeliveryText(normalized),
      delivery.inboxDir,
      delivery.workspaceOverride,
      delivery.requestOutputDir,
      context.locale,
      {
        source: delivery.source ?? "post-turn",
        allowAnyAbsolutePath: delivery.allowAnyAbsolutePath ?? true,
        notifyRejected: delivery.notifyRejected,
        onFileAccepted: (sourcePath) => {
          acceptedPaths.add(sourcePath);
          delivery.onFileAccepted?.(sourcePath);
        },
        onDeliveryAccepted: (receipt) => {
          acceptedPaths.add(receipt.path);
          delivery.onDeliveryAccepted?.(receipt);
        },
        onDeliveryRejected: (receipt) => {
          rejected.push(`${receipt.path} — ${receipt.reason}${receipt.detail ? ` (${receipt.detail})` : ""}`);
          delivery.onDeliveryRejected?.(receipt);
        },
      },
    );
    const requested = requestedPaths.length;
    const accepted = Math.min(requested, Math.max(acceptedPaths.size, filesSent));
    if (accepted < requested) {
      const detail = rejected.length > 0
        ? rejected.join("; ")
        : `${requested - accepted} file${requested - accepted === 1 ? "" : "s"} not delivered`;
      return {
        ok: false,
        status: accepted > 0 ? "partial" : "rejected",
        message: context.locale === "zh" ? `✗ 文件发送失败：${detail}` : `✗ File delivery failed: ${detail}`,
        error: detail,
        metadata: { requested, accepted, filesSent },
      };
    }
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 文件已送达  ${accepted}/${requested}` : `✓ File delivered  ${accepted}/${requested}`,
      metadata: { requested, accepted, filesSent },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context.locale);
  }
}

export function executeSendFileTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  return executeSendBatchTool(normalizeSinglePathPayload(payload, false), context);
}

export function executeSendImageTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  return executeSendBatchTool(normalizeSinglePathPayload(payload, true), context);
}
