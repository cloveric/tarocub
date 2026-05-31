import type { Locale } from "../telegram/message-renderer.js";
import type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

// When a final answer is too long to fit the run card, the card already shows a
// truncated preview — that overflow is the natural signal that "this is a long
// document". Rather than dump the full text as a multi-part markdown message, stash
// it in a Feishu Doc and post just the link. Falls back to the markdown dump (caller
// decides) if doc creation is unavailable or fails.

// Only stash the answer in a doc once it is genuinely long. A run card can also fail
// to show a SHORT answer (e.g. the card is wedged and updates keep failing); those
// stay as a chat message rather than spawning a doc for a few lines.
export const LARK_OVERFLOW_DOC_MIN_CHARS = 6000;

/** A concise doc title derived from the first meaningful line of the answer. */
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
 * Create a Feishu Doc with the full answer and post its link. Returns true when the
 * link was posted (caller should then NOT also dump the full markdown), false when
 * doc creation/link failed (caller falls back to the markdown dump so the content is
 * never lost).
 */
export async function postLarkOverflowAnswerDoc(input: {
  channel: LarkChannelLike;
  createDocument: (docInput: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
  chatId: string;
  replyOptions: LarkSendOptions | undefined;
  text: string;
  locale: Locale;
}): Promise<boolean> {
  try {
    const created = await input.createDocument({
      title: larkOverflowDocTitle(input.text, input.locale),
      content: input.text,
      // Create with the operator's USER identity so they OWN the doc and can open
      // the link. A bot-created doc isn't granted to the user (permission_grant is
      // skipped without a user open_id), producing a link they can't open. If the
      // instance has no user session, lark-cli errors here → caller falls back to
      // the markdown dump, so the content is never lost or unreachable.
      as: "user",
    });
    if (!created.url) {
      return false;
    }
    await input.channel.send(
      input.chatId,
      { markdown: renderLarkOverflowDocLink(created.url, input.locale, created.warning) },
      input.replyOptions,
    );
    return true;
  } catch {
    return false;
  }
}
