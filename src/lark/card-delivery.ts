import type { Locale } from "../telegram/message-renderer.js";
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

export function renderLarkCardFallbackText(fallbackText: string, locale: Locale, error: unknown): string {
  const hint = locale === "en"
    ? "Interactive card delivery failed, so this was sent as plain text. Run `node dist/src/index.js lark doctor` to check card permissions/callbacks."
    : "交互卡片发送失败，已降级为纯文本。请运行 `node dist/src/index.js lark doctor` 检查卡片权限和回调订阅。";
  const detail = error instanceof Error && error.message
    ? locale === "en" ? `\n\nDetail: ${redactLarkErrorDetail(error)}` : `\n\n详情：${redactLarkErrorDetail(error)}`
    : "";
  return [fallbackText.trim(), hint].filter(Boolean).join("\n\n") + detail;
}
