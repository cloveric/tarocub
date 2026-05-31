import { LARK_CARD_ANSWER_MAX } from "./card-renderer.js";
import type { Locale } from "../telegram/message-renderer.js";
import type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

// When a final answer is too long to fit the run card, the card already shows a
// truncated preview — that overflow is the natural signal that "this is a long
// document". Instead of dumping the full text as a multi-part markdown message,
// stash it in a Feishu Doc and post the link. If the doc can't be created, send the
// full answer as a .md FILE — a clean chat artifact whose presence also signals "the
// doc step failed" (the caller logs why). Only if even the file send fails does the
// caller fall back to an inline markdown dump, so the content is never lost.

// A reply that overflows the card (more than the card's answer capacity) is what
// triggers the doc — exactly the operator's "card can't fit it → make a doc" intent.
// A merely-wedged card (short answer, failing updates) stays a chat message because
// it never crosses this length.
export const LARK_OVERFLOW_DOC_MIN_CHARS = LARK_CARD_ANSWER_MAX;

export type LarkOverflowOutcome =
  | { delivered: true; mode: "doc"; url: string }
  | { delivered: true; mode: "file"; docError: string }
  | { delivered: false; mode: "failed"; docError: string; fileError: string };

/** A concise doc/file title derived from the first meaningful line of the answer. */
export function larkOverflowDocTitle(text: string, locale: Locale): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.slice(0, 60);
  }
  return locale === "en" ? "Claude reply" : "Claude 回复";
}

/** A filesystem-safe `.md` file name derived from the answer's title. */
export function larkOverflowDocFileName(text: string, locale: Locale): string {
  const base = larkOverflowDocTitle(text, locale)
    .replace(/[/\\:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  return `${base || (locale === "en" ? "reply" : "回复")}.md`;
}

/** The short chat message carrying the doc link (plus any permission warning). */
export function renderLarkOverflowDocLink(url: string, locale: Locale, warning?: string): string {
  const lead = locale === "en"
    ? `📄 The reply is long — full content saved as a Feishu doc:\n${url}`
    : `📄 回复较长，完整内容已存为飞书云文档：\n${url}`;
  if (warning?.trim()) {
    const note = locale === "en"
      ? `\n\n⚠️ Doc permission note: ${warning.trim()}`
      : `\n\n⚠️ 文档权限提示：${warning.trim()}`;
    return lead + note;
  }
  return lead;
}

/**
 * Deliver an over-long answer out-of-band. Preferred: a Feishu Doc (created with the
 * operator's USER identity so the link opens) + the link posted. If the doc can't be
 * created, send the full answer as a `.md` FILE — clean, and its presence is a visible
 * signal that the doc step failed (the caller logs why). Returns `delivered: false`
 * only when even the file send fails, so the caller does a last-resort inline dump.
 */
export async function postLarkOverflowAnswerDoc(input: {
  channel: LarkChannelLike;
  createDocument: (docInput: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
  chatId: string;
  replyOptions: LarkSendOptions | undefined;
  text: string;
  locale: Locale;
}): Promise<LarkOverflowOutcome> {
  let docError = "";
  try {
    const created = await input.createDocument({
      title: larkOverflowDocTitle(input.text, input.locale),
      content: input.text,
      // USER identity so the operator owns the doc and can open the link — a
      // bot-created doc isn't granted to them. No user session → this throws and we
      // fall through to the .md file.
      as: "user",
    });
    if (created.url) {
      await input.channel.send(
        input.chatId,
        { markdown: renderLarkOverflowDocLink(created.url, input.locale, created.warning) },
        input.replyOptions,
      );
      return { delivered: true, mode: "doc", url: created.url };
    }
    docError = "document created but no url was returned";
  } catch (error) {
    docError = error instanceof Error ? error.message : String(error);
  }
  // Doc failed → send the full answer as a .md file. Clean chat, and the file (vs a
  // link) tells the operator the doc step failed; the caller logs the docError.
  try {
    await input.channel.send(
      input.chatId,
      { file: { source: Buffer.from(input.text, "utf8"), fileName: larkOverflowDocFileName(input.text, input.locale) } },
      input.replyOptions,
    );
    return { delivered: true, mode: "file", docError };
  } catch (fileError) {
    return {
      delivered: false,
      mode: "failed",
      docError,
      fileError: fileError instanceof Error ? fileError.message : String(fileError),
    };
  }
}
