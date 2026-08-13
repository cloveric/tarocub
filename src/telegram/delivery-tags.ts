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
    // Start ONE char back so the (^|\n) prefix can re-consume the opener
    // line's newline: an EMPTY fenced block ("```\n```") otherwise never
    // matches its closer and everything after it is masked forever.
    closer.lastIndex = Math.max(0, opener.lastIndex - 1);
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

  // A blockquote is someone ELSE's words being shown, not this turn's
  // instruction — quoting a message that happens to contain a send tag must
  // not re-send it. Same rule as code: quoted text is displayed, not executed.
  const quoted = /(^|\n)[ \t]*>[^\n]*/g;
  while ((match = quoted.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const start = match.index + prefix.length;
    const end = match.index + match[0].length;
    if (!ranges.some((range) => start >= range.start && start < range.end)) {
      ranges.push({ start, end });
    }
  }
  if (ranges.length === 0) return text;

  // Ranges CAN overlap (a quoted line containing an inline code span yields
  // two overlapping ranges). The writer below walks forward once, so an
  // unmerged overlap made `cursor` jump past text that was never emitted —
  // a real delivery tag written after such a quote silently vanished.
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }

  let masked = "";
  let cursor = 0;
  for (const range of merged) {
    masked += text.slice(cursor, range.start);
    masked += blankPreservingNewlines(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + text.slice(cursor);
}

export function extractDeliveryTagMatches(text: string): DeliveryTagMatch[] {
  const searchable = maskMarkdownCode(text);
  const pattern = /\[send-(file|image):/g;
  const matches: DeliveryTagMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(searchable)) !== null) {
    const pathStart = pattern.lastIndex;
    let nestedBrackets = 0;
    let tagEnd = -1;
    for (let index = pathStart; index < searchable.length; index++) {
      const char = searchable[index];
      if (char === "[") {
        nestedBrackets++;
      } else if (char === "]") {
        if (nestedBrackets > 0) {
          nestedBrackets--;
        } else {
          tagEnd = index + 1;
          break;
        }
      }
    }
    if (tagEnd === -1) {
      continue;
    }
    const filePath = text.slice(pathStart, tagEnd - 1).trim();
    pattern.lastIndex = tagEnd;
    if (!filePath) {
      continue;
    }
    matches.push({
      tag: text.slice(match.index, tagEnd),
      path: filePath,
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
