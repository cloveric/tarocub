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
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (segment) => blankPreservingNewlines(segment))
    .replace(/`[^`\r\n]*`/g, (segment) => blankPreservingNewlines(segment));
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
