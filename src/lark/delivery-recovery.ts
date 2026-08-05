// Boot-time redelivery of Lark delivery obligations recorded by the ledger
// (state/delivery-obligation-store.ts). Runs once per service boot, after the
// channel connects; kept separate from service.ts so it is unit-testable with
// a mock channel. Best-effort: a redelivery failure marks the row failed (a
// later boot retries up to the attempts cap) and never blocks startup.

import {
  markDeliveryDelivered,
  markDeliveryFailed,
  sweepRecoverableDeliveries,
} from "../state/delivery-obligation-store.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";

export interface LarkRedeliveryChannel {
  send(to: string, input: unknown, opts?: { replyTo?: string; replyInThread?: boolean }): Promise<unknown>;
}

/** Visible prefix for redeliveries that might duplicate an already-received
 *  message (crash mid-send / post-rejection retry). Honest at-least-once. */
export function recoveredReplyMarker(locale: "en" | "zh"): string {
  return locale === "zh"
    ? "♻️ 服务重启前有一条回复未确认送达，现补发（可能与之前收到的重复）："
    : "♻️ Recovered reply — the service restarted during delivery, so this may be a duplicate:";
}

export async function redeliverRecoveredLarkObligations(input: {
  channel: LarkRedeliveryChannel;
  stateDir: string;
  instanceName?: string;
  locale: "en" | "zh";
  log?: (message: string) => void;
}): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;
  const claimed = await sweepRecoverableDeliveries(input.stateDir, { channel: "lark" });
  for (const row of claimed) {
    const markdown = row.needsMarker
      ? `${recoveredReplyMarker(input.locale)}\n\n${row.content}`
      : row.content;
    const conversationKey = row.conversationKey ?? `lark:${row.chatId}`;
    try {
      await input.channel.send(row.chatId, { markdown }, {
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        ...(row.replyInThread !== undefined ? { replyInThread: row.replyInThread } : {}),
      });
      await markDeliveryDelivered(input.stateDir, row.id);
      recovered += 1;
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "delivery.recovered",
        ...(input.instanceName ? { instanceName: input.instanceName } : {}),
        channel: "lark",
        chatId: stableLarkNumericId(conversationKey),
        conversationKey,
        outcome: "success",
        detail: `redelivered obligation ${row.id} (attempt ${row.attempts})`,
        metadata: {
          obligationId: row.id,
          attempts: row.attempts,
          withMarker: row.needsMarker,
          contentChars: row.content.length,
        },
      }, "Lark delivery recovery timeline event");
    } catch (error) {
      failed += 1;
      await markDeliveryFailed(input.stateDir, row.id, redactLarkErrorDetail(error));
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "delivery.recovered",
        ...(input.instanceName ? { instanceName: input.instanceName } : {}),
        channel: "lark",
        chatId: stableLarkNumericId(conversationKey),
        conversationKey,
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        metadata: {
          obligationId: row.id,
          attempts: row.attempts,
        },
      }, "Lark delivery recovery timeline event");
      input.log?.(`delivery recovery failed for obligation ${row.id}: ${redactLarkErrorDetail(error)}`);
    }
  }
  return { recovered, failed };
}
