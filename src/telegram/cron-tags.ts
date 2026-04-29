import type { CronRuntime } from "../runtime/cron-runtime.js";
import { executeTelegramTool } from "../tools/telegram-tool-executor.js";
import type { Locale } from "./message-renderer.js";

export interface CronAddTagMatch {
  tag: string;
  payload: string;
  index: number;
}

export interface ProcessCronAddTagsInput {
  text: string;
  cronRuntime: CronRuntime | null;
  stateDir: string;
  chatId: number;
  userId: number;
  chatType?: string;
  locale: Locale;
  instanceName?: string;
  updateId?: number;
}

function blankPreservingNewlines(value: string): string {
  return value.replace(/[^\n\r]/g, " ");
}

function findCronAddTagEnd(text: string, payloadStart: number): number | null {
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

function maskCronAddTags(text: string): string {
  let next = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("[cron-add:", cursor);
    if (start === -1) {
      next += text.slice(cursor);
      break;
    }
    const payloadStart = start + "[cron-add:".length;
    const end = findCronAddTagEnd(text, payloadStart);
    if (end === null) {
      next += text.slice(cursor, payloadStart);
      cursor = payloadStart;
      continue;
    }
    next += text.slice(cursor, start);
    next += blankPreservingNewlines(text.slice(start, end));
    cursor = end;
  }
  return next;
}

function markdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const maskedTags = maskCronAddTags(text);
  const ranges: Array<{ start: number; end: number }> = [];
  const opener = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\r\n]*)\r?\n/g;
  let fencedMatch: RegExpExecArray | null;
  while ((fencedMatch = opener.exec(maskedTags)) !== null) {
    const prefix = fencedMatch[1] ?? "";
    const start = fencedMatch.index + prefix.length;
    const marker = fencedMatch[3]!;
    const fenceChar = marker[0]!;
    const minLength = marker.length;
    const contentStart = opener.lastIndex;
    const closer = new RegExp(`(^|\\n)[ \\t]*${fenceChar}{${minLength},}[ \\t]*(?=\\r?\\n|$)`, "g");
    closer.lastIndex = contentStart;
    const closeMatch = closer.exec(maskedTags);
    if (!closeMatch) {
      ranges.push({ start, end: maskedTags.length });
      break;
    }
    ranges.push({ start, end: closeMatch.index + closeMatch[0].length });
    opener.lastIndex = closeMatch.index + closeMatch[0].length;
  }
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

function isInsideRange(index: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function extractCronAddTagMatches(text: string): CronAddTagMatch[] {
  const codeRanges = markdownCodeRanges(text);
  const matches: CronAddTagMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("[cron-add:", cursor);
    if (start === -1) {
      break;
    }
    if (isInsideRange(start, codeRanges)) {
      cursor = start + "[cron-add:".length;
      continue;
    }
    const payloadStart = start + "[cron-add:".length;
    const end = findCronAddTagEnd(text, payloadStart);
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
  return matches;
}

export function stripCronAddTags(text: string, matches = extractCronAddTagMatches(text)): string {
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

export async function processCronAddTags(input: ProcessCronAddTagsInput): Promise<string> {
  const matches = extractCronAddTagMatches(input.text);
  if (matches.length === 0) {
    return input.text;
  }

  const messages: string[] = [];
  for (const match of matches) {
    const result = await executeTelegramTool({
      name: "cron.add",
      payload: match.payload,
      context: {
        cronRuntime: input.cronRuntime,
        stateDir: input.stateDir,
        chatId: input.chatId,
        userId: input.userId,
        chatType: input.chatType,
        locale: input.locale,
        instanceName: input.instanceName,
        updateId: input.updateId,
      },
    });
    messages.push(result.message);
  }

  return [
    stripCronAddTags(input.text, matches),
    ...messages,
  ].filter((part) => part.trim()).join("\n\n");
}
