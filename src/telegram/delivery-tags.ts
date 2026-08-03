export interface DeliveryTagMatch {
  tag: string;
  path: string;
  preferPhoto: boolean;
  index: number;
}

function blankPreservingNewlines(value: string): string {
  return value.replace(/[^\n\r]/g, " ");
}

function maskMarkdownCode(text: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  const opener = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\r\n]*\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const start = match.index + prefix.length;
    const marker = match[3]!;
    const closer = new RegExp(`(^|\\n)[ \\t]*${marker[0]}{${marker.length},}[ \\t]*(?=\\r?\\n|$)`, "g");
    closer.lastIndex = opener.lastIndex;
    const closeMatch = closer.exec(text);
    const end = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
    ranges.push({ start, end });
    if (!closeMatch) break;
    opener.lastIndex = end;
  }

  const inline = /`[^`\r\n]*`/g;
  while ((match = inline.exec(text)) !== null) {
    if (!ranges.some((range) => match!.index >= range.start && match!.index < range.end)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (ranges.length === 0) return text;

  let masked = "";
  let cursor = 0;
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    masked += text.slice(cursor, range.start);
    masked += blankPreservingNewlines(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + text.slice(cursor);
}

export function extractDeliveryTagMatches(text: string): DeliveryTagMatch[] {
  const searchable = maskMarkdownCode(text);
  const pattern = /\[send-(file|image):([^\]]+)\]/g;
  const matches: DeliveryTagMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(searchable)) !== null) {
    matches.push({
      tag: text.slice(match.index, match.index + match[0].length),
      path: match[2]!.trim(),
      preferPhoto: match[1] === "image",
      index: match.index,
    });
  }
  return matches;
}

export function hasDeliveryTag(text: string): boolean {
  return extractDeliveryTagMatches(text).length > 0;
}

export function stripDeliveryTags(
  text: string,
  shouldStrip: (match: DeliveryTagMatch) => boolean = () => true,
): string {
  const matches = extractDeliveryTagMatches(text).filter(shouldStrip);
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
