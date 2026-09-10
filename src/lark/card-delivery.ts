import type { Locale } from "../telegram/message-renderer.js";
import { renderLarkContinuationCard } from "./card-renderer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

export async function sendLarkCardWithFallback(input: {
  channel: Pick<LarkChannelLike, "send">;
  chatId: string;
  card: object;
  fallbackText: string;
  options?: LarkSendOptions;
  locale: Locale;
}): Promise<{ messageId: string; fallback: boolean }> {
  try {
    const sent = await input.channel.send(input.chatId, { card: input.card }, input.options);
    return { messageId: sent.messageId, fallback: false };
  } catch (error) {
    const sent = await input.channel.send(input.chatId, {
      text: renderLarkCardFallbackText(input.fallbackText, input.locale, error),
    }, input.options);
    return { messageId: sent.messageId, fallback: true };
  }
}

/** Deliver chunks 2..N after a run card has already rendered chunk 1. */
export async function deliverLarkContinuationCards(input: {
  channel: Pick<LarkChannelLike, "send">;
  chatId: string;
  chunks: string[];
  replyOptions: LarkSendOptions | undefined;
  locale: Locale;
}): Promise<void> {
  const total = input.chunks.length;
  for (let index = 1; index < total; index++) {
    const chunk = input.chunks[index]!;
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card: renderLarkContinuationCard(chunk, index + 1, total, input.locale),
      fallbackText: chunk,
      options: input.replyOptions,
      locale: input.locale,
    });
  }
}

export function renderLarkCardFallbackText(fallbackText: string, locale: Locale, error: unknown): string {
  const errorText = error instanceof Error ? error.message.toLowerCase() : "";
  const tableLimit = errorText.includes("card table number over limit")
    || (errorText.includes("errorvalue") && errorText.includes("table"));
  const capacityLimit = tableLimit
    || errorText.includes("element exceeds the limit")
    || errorText.includes("card content exceeds limit");
  const hint = tableLimit
    ? locale === "en"
      ? "The interactive card exceeded Lark's per-card table limit, so it was sent as plain text instead. No content was lost."
      : "交互卡片超过飞书单卡表格上限，已自动改用纯文本发送，内容未丢失。"
    : capacityLimit
      ? locale === "en"
        ? "The interactive card exceeded Lark's card capacity, so it was sent as plain text instead. No content was lost."
        : "交互卡片超过飞书卡片容量上限，已自动改用纯文本发送，内容未丢失。"
      : locale === "en"
        ? "Interactive card delivery failed, so this was sent as plain text. Run `node dist/src/index.js lark doctor` to check card permissions/callbacks."
        : "交互卡片发送失败，已降级为纯文本。请运行 `node dist/src/index.js lark doctor` 检查卡片权限和回调订阅。";
  const detail = error instanceof Error && error.message
    ? locale === "en" ? `\n\nDetail: ${redactLarkErrorDetail(error)}` : `\n\n详情：${redactLarkErrorDetail(error)}`
    : "";
  return [fallbackText.trim(), hint].filter(Boolean).join("\n\n") + detail;
}
