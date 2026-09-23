import path from "node:path";

export type CitationLocale = "en" | "zh";

const CODEX_FILE_CITATION_MARKER = ":codex-file-citation{";
const CODEX_FOLLOWUP_MARKER = ":codex-followup[";
const CODEX_UI_MARKERS = [CODEX_FILE_CITATION_MARKER, CODEX_FOLLOWUP_MARKER] as const;
const PARTIAL_MARKER_MIN_LENGTH = ":codex-".length;

/**
 * Convert Codex's UI-only annotation tokens into channel-safe prose.
 * Absolute source paths are intentionally reduced to a basename: a citation
 * is provenance, not an instruction to upload the referenced local file.
 * Follow-up chips keep only their visible label because remote channels cannot
 * render the Codex Desktop action or safely preserve its hidden prompt.
 */
export function renderCodexFileCitations(
  text: string,
  locale: CitationLocale = "en",
  options: { streaming?: boolean } = {},
): string {
  if (!text.includes(":codex-")) {
    return text;
  }

  let output = "";
  let prose = "";
  let fencedOpening = "";
  let fencedBody = "";
  let fence: { marker: string; length: number } | undefined;
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  if (lines.at(-1) === "") lines.pop();

  const flushProse = () => {
    output += renderCodexAnnotationProse(prose, locale, options.streaming === true);
    prose = "";
  };

  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/u, "");
    const match = /^(?:\s{0,3}>\s?)*\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        match
        && match[1]![0] === fence.marker
        && match[1]!.length >= fence.length
        && !match[2]!.trim()
      ) {
        output += fencedOpening + fencedBody + lineWithEnding;
        fencedOpening = "";
        fencedBody = "";
        fence = undefined;
      } else {
        fencedBody += lineWithEnding;
      }
    } else if (match) {
      flushProse();
      fencedOpening = lineWithEnding;
      fence = { marker: match[1]![0]!, length: match[1]!.length };
    } else {
      prose += lineWithEnding;
    }
  }

  flushProse();
  if (fence) {
    // An unfinished fence is not a trustworthy literal region: otherwise one
    // missing closing line exposes every later UI annotation and local path.
    output += fencedOpening;
    output += renderCodexAnnotationProse(fencedBody, locale, options.streaming === true);
  }

  return output;
}

function renderCodexAnnotationProse(text: string, locale: CitationLocale, streaming: boolean): string {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const citationStart = text.indexOf(CODEX_FILE_CITATION_MARKER, cursor);
    const followupStart = text.indexOf(CODEX_FOLLOWUP_MARKER, cursor);
    const markerStart = earliestMarkerStart(citationStart, followupStart);
    if (markerStart < 0) {
      output += streaming ? stripTrailingPartialMarker(text.slice(cursor)) : text.slice(cursor);
      break;
    }

    output += text.slice(cursor, markerStart);
    if (markerStart === followupStart) {
      const labelStart = markerStart + CODEX_FOLLOWUP_MARKER.length;
      const labelEnd = findFollowupLabelEnd(text, labelStart);
      if (labelEnd === -1) {
        // No hidden prompt body has started yet, so a malformed label can be
        // contained to its current line without eating unrelated later text.
        output += unavailableFollowup(locale);
        cursor = findLineBreakStart(text, markerStart);
        if (cursor === text.length) break;
        continue;
      }
      const label = sanitizeFollowupLabel(text.slice(labelStart, labelEnd));
      const bodyStart = labelEnd + 1;
      if (text[bodyStart] !== "{") {
        output += unavailableFollowup(locale);
        break;
      }
      const markerEnd = findCitationEnd(text, bodyStart + 1);
      output += label || unavailableFollowup(locale);
      if (markerEnd === -1) {
        // Never expose the hidden prompt from a truncated desktop annotation.
        break;
      }
      cursor = markerEnd + 1;
      continue;
    }

    const markerEnd = findCitationEnd(text, markerStart + CODEX_FILE_CITATION_MARKER.length);
    if (markerEnd === -1) {
      // Streaming can stop midway through the token. Final output also hides
      // an unfinished full token because its suffix may contain a local path.
      break;
    }

    const body = text.slice(markerStart + CODEX_FILE_CITATION_MARKER.length, markerEnd);
    output += renderCitationBody(body, locale);
    cursor = markerEnd + 1;
  }

  return output;
}

function findLineBreakStart(text: string, start: number): number {
  const lf = text.indexOf("\n", start);
  const cr = text.indexOf("\r", start);
  if (lf === -1) return cr === -1 ? text.length : cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}

function earliestMarkerStart(...starts: number[]): number {
  const present = starts.filter((start) => start >= 0);
  return present.length > 0 ? Math.min(...present) : -1;
}

function findFollowupLabelEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "]" && text[index + 1] === "{") {
      return index;
    }
  }
  return -1;
}

function sanitizeFollowupLabel(value: string): string {
  const decoded = value.replace(/\\([\\\]])/gu, "$1");
  return Array.from(decoded.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim()).slice(0, 240).join("");
}

function unavailableFollowup(locale: CitationLocale): string {
  return locale === "zh" ? "（后续建议不可用）" : "(Follow-up unavailable)";
}

function findCitationEnd(text: string, start: number): number {
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        quoted = false;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === "}") {
      return index;
    }
  }
  return -1;
}

function renderCitationBody(body: string, locale: CitationLocale): string {
  const attributes = parseCitationAttributes(body);
  const fileName = attributes ? citationBasename(attributes.path) : "";
  if (!attributes || !fileName) {
    return locale === "zh" ? "（文件引用不可用）" : "(File reference unavailable)";
  }

  const sheet = sanitizeInlineCode(attributes.sheet);
  const range = sanitizeInlineCode(attributes.range);
  const location = sheet && range ? `${sheet}!${range}` : sheet || range;
  const source = locale === "zh" ? "来源" : "Source";
  const renderedFile = inlineCode(fileName);
  return location
    ? locale === "zh"
      ? `（${source}：${renderedFile} · ${inlineCode(location)}）`
      : `(${source}: ${renderedFile} · ${inlineCode(location)})`
    : locale === "zh"
      ? `（${source}：${renderedFile}）`
      : `(${source}: ${renderedFile})`;
}

function parseCitationAttributes(body: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  const attribute = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"((?:\\.|[^"\\])*)"/y;
  let cursor = 0;

  while (cursor < body.length) {
    const whitespace = /^\s+/u.exec(body.slice(cursor));
    if (whitespace) {
      cursor += whitespace[0].length;
    }
    if (cursor >= body.length) {
      break;
    }

    attribute.lastIndex = cursor;
    const match = attribute.exec(body);
    if (!match) {
      return null;
    }
    const key = match[1]!;
    attributes[key] = decodeAttributeValue(match[2] ?? "");
    cursor = attribute.lastIndex;
  }

  return attributes;
}

function decodeAttributeValue(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    // Be tolerant of producers that emit an unescaped Windows path while still
    // reducing it to a basename before anything becomes user-visible.
    return value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

function citationBasename(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const base = path.posix.basename(value.replace(/\\/g, "/"));
  if (!base || base === "." || base === "..") {
    return "";
  }
  return sanitizeInlineCode(base);
}

function inlineCode(value: string): string {
  return `\`${sanitizeInlineCode(value)}\``;
}

function sanitizeInlineCode(value: string | undefined): string {
  const sanitized = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/`/g, "'")
    .trim();
  return Array.from(sanitized).slice(0, 240).join("");
}

function stripTrailingPartialMarker(text: string): string {
  for (const marker of CODEX_UI_MARKERS) {
    const maxLength = Math.min(marker.length - 1, text.length);
    for (let length = maxLength; length >= PARTIAL_MARKER_MIN_LENGTH; length -= 1) {
      if (text.endsWith(marker.slice(0, length))) {
        return text.slice(0, -length);
      }
    }
  }
  return text;
}
