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
import { buildLarkRecoveryResponse, deliverLarkResponse } from "./delivery.js";
import { extractWholeResponseFileBlock } from "./delivery-preflight.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import { createLarkServiceRuntime, type LarkServiceRuntime } from "./runtime.js";
import type { LarkChannelLike } from "./types.js";

export interface LarkRedeliveryChannel {
  send(to: string, input: unknown, opts?: { replyTo?: string; replyInThread?: boolean }): Promise<unknown>;
  rawClient?: unknown;
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
  runtime?: LarkServiceRuntime;
  log?: (message: string) => void;
}): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;
  const claimed = await sweepRecoverableDeliveries(input.stateDir, { channel: "lark" });
  for (const row of claimed) {
    const conversationKey = row.conversationKey ?? `lark:${row.chatId}`;
    try {
      const safeReplay = buildLarkRecoveryResponse(row.content).trim() || (input.locale === "en"
        ? "A recovered reply contained only actions that are unsafe to rerun, so those actions were skipped."
        : "恢复的回复只包含不适合自动重跑的操作，因此已跳过这些操作。");
      const wholeFile = Boolean(extractWholeResponseFileBlock(safeReplay));
      const replyOptions = {
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        ...(row.replyInThread !== undefined ? { replyInThread: row.replyInThread } : {}),
      };
      if (row.needsMarker && wholeFile) {
        await input.channel.send(row.chatId, { markdown: recoveredReplyMarker(input.locale) }, replyOptions);
      }
      const delivery = await deliverLarkResponse({
        channel: input.channel as LarkChannelLike,
        runtime: input.runtime ?? createLarkServiceRuntime(),
        chatId: row.chatId,
        text: row.needsMarker && !wholeFile
          ? `${recoveredReplyMarker(input.locale)}\n\n${safeReplay}`
          : safeReplay,
        stateDir: input.stateDir,
        conversationKey,
        bridgeChatId: stableLarkNumericId(conversationKey),
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        ...(row.replyInThread !== undefined ? { replyInThread: row.replyInThread } : {}),
        ...(input.instanceName ? { instanceName: input.instanceName } : {}),
      });
      if (!delivery.ok) {
        throw new Error("recovered delivery remained unconfirmed");
      }
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
