import { executeTelegramTool } from "../tools/telegram-tool-executor.js";
import type { TelegramToolContext } from "../tools/telegram-tool-types.js";

export interface ToolTagMatch {
  tag: string;
  payload: string;
  index: number;
}

export interface ProcessTelegramToolTagsInput {
  text: string;
  context: TelegramToolContext;
}

interface FencedCodeRange {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  info: string;
}

function blankPreservingNewlines(value: string): string {
  return value.replace(/[^\n\r]/g, " ");
}

function maskToolTags(text: string): string {
  return text.replace(/\[tool:[^\]]+\]/g, (segment) => blankPreservingNewlines(segment));
}

function markdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const maskedTags = maskToolTags(text);
  const ranges: Array<{ start: number; end: number }> = findFencedCodeRanges(maskedTags)
    .map((range) => ({ start: range.start, end: range.end }));
  const inline = /`[^`\r\n]*`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inline.exec(maskedTags)) !== null) {
    const start = inlineMatch.index;
    const end = inlineMatch.index + inlineMatch[0].length;
    if (!ranges.some((range) => start >= range.start && start < range.end)) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function findFencedCodeRanges(text: string): FencedCodeRange[] {
  const ranges: FencedCodeRange[] = [];
  const opener = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\r\n]*)\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const start = match.index + prefix.length;
    const marker = match[3]!;
    const fenceChar = marker[0]!;
    const minLength = marker.length;
    const info = (match[4] ?? "").trim();
    const contentStart = opener.lastIndex;
    const closer = new RegExp(`(^|\\n)[ \\t]*${fenceChar}{${minLength},}[ \\t]*(?=\\r?\\n|$)`, "g");
    closer.lastIndex = contentStart;
    const closeMatch = closer.exec(text);
    if (!closeMatch) {
      ranges.push({
        start,
        end: text.length,
        contentStart,
        contentEnd: text.length,
        info,
      });
      break;
    }
    const closePrefix = closeMatch[1] ?? "";
    const closeStart = closeMatch.index + closePrefix.length;
    const end = closeMatch.index + closeMatch[0].length;
    ranges.push({
      start,
      end,
      contentStart,
      contentEnd: closeStart,
      info,
    });
    opener.lastIndex = end;
  }
  return ranges;
}

function isInsideRange(index: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function extractTelegramToolTagMatches(text: string): ToolTagMatch[] {
  const codeRanges = markdownCodeRanges(text);
  const matches: ToolTagMatch[] = extractFencedToolBlockMatches(text);
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("[tool:", cursor);
    if (start === -1) {
      break;
    }
    if (isInsideRange(start, codeRanges)) {
      cursor = start + "[tool:".length;
      continue;
    }
    const payloadStart = start + "[tool:".length;
    const end = findToolTagEnd(text, payloadStart);
    if (end === null) {
      cursor = payloadStart;
      continue;
    }
    matches.push({
      tag: text.slice(start, end),
      payload: text.slice(payloadStart, end - 1).trim(),
      index: start,
    });
    cursor = end;
  }
  return matches.sort((a, b) => a.index - b.index);
}

function extractFencedToolBlockMatches(text: string): ToolTagMatch[] {
  const ranges = findFencedCodeRanges(text);
  return ranges
    .filter((range) => range.info.split(/\s+/)[0] === "tool-call")
    .filter((range) => {
      const parent = ranges.find((candidate) =>
        candidate !== range &&
        candidate.info.split(/\s+/)[0] !== "tool-call" &&
        range.start > candidate.start &&
        range.start < candidate.end
      );
      return !parent;
    })
    .map((range) => ({
      tag: text.slice(range.start, range.end),
      payload: text.slice(range.contentStart, range.contentEnd).trim(),
      index: range.start,
    }));
}

function findToolTagEnd(text: string, payloadStart: number): number | null {
  let index = payloadStart;
  while (index < text.length && /\s/.test(text[index]!)) {
    index++;
  }
  if (text[index] !== "{") {
    const fallbackEnd = text.indexOf("]", payloadStart);
    return fallbackEnd === -1 ? null : fallbackEnd + 1;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
      continue;
    }
    if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        while (end < text.length && /\s/.test(text[end]!)) {
          end++;
        }
        return text[end] === "]" ? end + 1 : null;
      }
    }
  }
  return null;
}

export function stripTelegramToolTags(text: string, matches = extractTelegramToolTagMatches(text)): string {
  if (matches.length === 0) {
    return text;
  }
  let next = "";
  let cursor = 0;
  for (const match of matches) {
    next += text.slice(cursor, match.index);
    cursor = match.index + match.tag.length;
  }
  next += text.slice(cursor);
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseTelegramToolTagPayload(raw: string): { name: string; payload: unknown } {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool tag payload must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const name = typeof body.name === "string"
    ? body.name.trim()
    : typeof body.tool === "string"
      ? body.tool.trim()
      : "";
  if (!name) {
    throw new Error("tool tag requires name");
  }
  return {
    name,
    payload: body.payload ?? body.args ?? {},
  };
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isSendToolName(name: string): boolean {
  return name === "send.file" || name === "send.image" || name === "send.batch";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sendToolRequestedPaths(name: string, payload: unknown): string[] {
  const body = payloadObject(payload);
  if (!body || !isSendToolName(name)) {
    return [];
  }
  if ((name === "send.file" || name === "send.image") && typeof body.path === "string") {
    return [body.path];
  }
  if (name === "send.batch") {
    return [...stringArray(body.images), ...stringArray(body.files)];
  }
  return [];
}

function filterAlreadyDeliveredSendPayload(
  name: string,
  payload: unknown,
  deliveredPaths: ReadonlySet<string>,
): unknown | null {
  if (!isSendToolName(name)) {
    return payload;
  }
  const body = payloadObject(payload);
  if (!body) {
    return payload;
  }

  if ((name === "send.file" || name === "send.image") && typeof body.path === "string") {
    return deliveredPaths.has(body.path) ? null : payload;
  }
  if (name !== "send.batch") {
    return payload;
  }

  const images = stringArray(body.images);
  const files = stringArray(body.files);
  const hadFiles = images.length > 0 || files.length > 0;
  const filtered = {
    ...body,
    images: images.filter((filePath) => !deliveredPaths.has(filePath)),
    files: files.filter((filePath) => !deliveredPaths.has(filePath)),
  };
  if (hadFiles && filtered.images.length === 0 && filtered.files.length === 0) {
    return null;
  }
  return filtered;
}

function renderToolTagFailure(detail: string, context: TelegramToolContext): string {
  return context.locale === "zh" ? `✗ 工具调用失败：${detail}` : `✗ Tool call failed: ${detail}`;
}

export async function processTelegramToolTags(input: ProcessTelegramToolTagsInput): Promise<string> {
  const matches = extractTelegramToolTagMatches(input.text);
  if (matches.length === 0) {
    return input.text;
  }

  const messages: string[] = [];
  const deliveredPaths = new Set<string>();
  for (const match of matches) {
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      const payload = filterAlreadyDeliveredSendPayload(parsed.name, parsed.payload, deliveredPaths);
      if (payload === null) {
        continue;
      }
      const context = input.context.delivery && isSendToolName(parsed.name)
        ? {
          ...input.context,
          delivery: {
            ...input.context.delivery,
            onDeliveryAccepted: (
              receipt: Parameters<NonNullable<NonNullable<TelegramToolContext["delivery"]>["onDeliveryAccepted"]>>[0],
            ) => {
              deliveredPaths.add(receipt.path);
              if (receipt.realPath) {
                deliveredPaths.add(receipt.realPath);
              }
              input.context.delivery?.onDeliveryAccepted?.(receipt);
            },
          },
        }
        : input.context;
      const result = await executeTelegramTool({
        name: parsed.name,
        payload,
        context,
      });
      if (result.ok && isSendToolName(parsed.name)) {
        for (const filePath of sendToolRequestedPaths(parsed.name, payload)) {
          deliveredPaths.add(filePath);
        }
      }
      messages.push(result.message);
    } catch (error) {
      messages.push(renderToolTagFailure(error instanceof Error ? error.message : String(error), input.context));
    }
  }

  return [
    stripTelegramToolTags(input.text, matches),
    ...messages,
  ].filter((part) => part.trim()).join("\n\n");
}
