import { mkdir } from "node:fs/promises";
import path from "node:path";

import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { CronAccessDeniedError } from "../runtime/cron-errors.js";
import type { CronExecutor } from "../runtime/cron-scheduler.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { renderLarkReminderCard } from "./card-renderer.js";
import { sendLarkMarkdown } from "./delivery.js";
import { larkAccessChatIdFromConversationKey, stableLarkNumericId } from "./message-normalizer.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike, LarkSendOptions } from "./types.js";

const LARK_CRON_TEXT_LIMIT = 3500;
const LARK_CRON_FAILURE_PROMPT_LIMIT = 700;

type LarkCronDeliverResponse = (input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  text: string;
  stateDir: string;
  requestOutputDir: string;
  workspaceOverride?: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  bridgeChatId?: number;
  bridgeUserId?: number;
  larkThreadId?: string;
  larkMessageId?: string;
  replyTo?: string;
  replyInThread?: boolean;
  /** When false, only files/overflow are delivered (the text is already in the run card). */
  sendText?: boolean;
}) => Promise<void>;

export function buildLarkCronExecutor(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  workspaceOverride?: string;
  agentInstructions?: () => string;
  deliverResponse?: LarkCronDeliverResponse;
  /** Factory for the run card an AI-task cron renders its result into (injected to avoid a cron→message-handler import cycle). */
  createRunCard?: typeof import("./message-handler.js")["createLarkRunCardController"];
}): CronExecutor {
  return async (job: CronJobRecord, abortSignal?: AbortSignal): Promise<void> => {
    if (job.channel !== "lark") {
      throw new Error(`cannot execute non-Lark cron job ${job.id} on Lark service`);
    }
    if (!job.larkChatId) {
      throw new Error(`Lark cron job ${job.id} is missing larkChatId`);
    }
    const bridgeChatType = job.chatType === "group" ? "group" : "private";
    const conversationKey = job.conversationKey ?? `lark:${job.larkChatId}`;
    const accessChatId = larkAccessChatIdFromConversationKey(conversationKey);
    const conversationChatId = stableLarkNumericId(conversationKey);
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: accessChatId,
        conversationChatId,
        userId: job.userId,
        chatType: bridgeChatType,
        conversationKey,
        locale: job.locale ?? "zh",
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      throw new CronAccessDeniedError(accessDecision.text ? `cron access denied: ${accessDecision.text}` : undefined);
    }

    if (job.deliveryMode === "notify") {
      if (!job.mute) {
        const locale = job.locale === "en" ? "en" : "zh";
        // Reminder card — each fire sends its own card, so it is still a separate
        // push (never batched). Falls back to the plain "⏰ 提醒" text if the card
        // can't be sent, so a reminder is never silently dropped.
        await sendLarkCardWithFallback({
          channel: input.channel,
          chatId: job.larkChatId,
          card: renderLarkReminderCard(larkReminderBody(job), locale),
          fallbackText: renderLarkCronNotification(job),
          options: larkCronReplyOptions(job),
          locale,
        });
      }
      return;
    }

    const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", `cron-${job.id}`);
    await mkdir(requestOutputDir, { recursive: true });
    const replyFields = larkCronReplyFields(job);
    const locale = job.locale === "en" ? "en" : "zh";
    const cfg = await loadInstanceConfig(input.stateDir);
    const budgetExhausted = await checkBudgetAvailability(input.stateDir, cfg.budgetUsd, locale);
    if (budgetExhausted) {
      if (!job.mute) {
        await sendLarkMarkdown(input.channel, job.larkChatId, budgetExhausted.message, replyFields);
      }
      return;
    }
    // Render the AI task's result into a run card (same UX as a chat reply): open
    // the card, run the turn, then finish it with the answer. Skipped for muted
    // jobs (no card) and when no run-card factory is wired (older callers).
    const runCard = !job.mute && input.createRunCard
      ? await input.createRunCard({
        channel: input.channel,
        chatId: job.larkChatId,
        conversationKey,
        bridgeChatType,
	        locale,
        ...(replyFields.replyTo
          ? { replyTo: replyFields.replyTo, replyInThread: replyFields.replyInThread ?? false }
          : {}),
      })
      : undefined;
    let result: Awaited<ReturnType<typeof input.bridge.handleAuthorizedMessage>>;
    try {
      result = await input.bridge.handleAuthorizedMessage({
        chatId: accessChatId,
        userId: job.userId,
        chatType: bridgeChatType,
        text: job.prompt,
        conversationKey,
        locale: job.locale ?? "zh",
        files: [],
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        abortSignal,
        instructions: input.agentInstructions?.(),
      });
    } catch (error) {
      // Don't leave the AI-task run card stuck on "running" when the engine errors
      // or times out: flip it to interrupted (job aborted, e.g. /stop) or failed,
      // then rethrow so the scheduler still records the failure, retries, and sends
      // its own failure notification (which carries the error detail).
      if (runCard) {
        if (abortSignal?.aborted) {
          await runCard.interrupt().catch(() => {});
        } else {
          await runCard.fail(job.locale === "en" ? "Scheduled task failed." : "定时任务执行失败。").catch(() => {});
        }
      }
      throw error;
    }
    await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
    if (job.mute) {
      return;
    }
    // Finish the card with the answer; finish() reports whether the full answer
    // fit, which decides if deliverResponse should still send the text — it always
    // delivers file/image tags + any overflow regardless.
    let answerShownInCard = false;
    if (runCard) {
      answerShownInCard = (await runCard.finish(result.text || renderLarkEmptyCronAgentReply(job))).shown;
    }
    if (input.deliverResponse) {
      await input.deliverResponse({
        channel: input.channel,
        runtime: input.runtime,
        chatId: job.larkChatId,
        text: result.text,
        stateDir: input.stateDir,
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        conversationKey,
        bridgeChatType,
        bridgeChatId: job.chatId,
        bridgeUserId: job.userId,
        larkThreadId: job.larkThreadId,
        larkMessageId: job.larkMessageId,
        sendText: runCard ? !answerShownInCard : true,
        ...replyFields,
      });
      return;
    }
    if (!runCard) {
      await sendLarkMarkdown(input.channel, job.larkChatId, result.text || renderLarkEmptyCronAgentReply(job), {
        ...replyFields,
      });
    }
  };
}

export async function sendLarkCronFailureNotification(
  channel: LarkChannelLike,
  job: CronJobRecord,
  detail: string,
): Promise<void> {
  if (job.channel !== "lark" || !job.larkChatId || job.mute) {
    return;
  }
  const message = buildLarkCronFailureMessage(job, detail);
  const replyOptions = larkCronReplyOptions(job);
  if (replyOptions) {
    await channel.send(job.larkChatId, { text: message }, replyOptions);
    return;
  }
  await channel.send(job.larkChatId, { text: message });
}

function buildLarkCronFailureMessage(job: CronJobRecord, detail: string): string {
  const prompt = truncateLarkCronText(
    job.prompt,
    LARK_CRON_FAILURE_PROMPT_LIMIT,
    job.locale === "en" ? "..." : "…",
  );
  const prefix = job.locale === "en"
    ? `⚠️ Scheduled task failed\nID  ${job.id}\n📝 ${prompt}\nError: `
    : `⚠️ 定时任务执行失败\nID  ${job.id}\n📝 ${prompt}\n错误：`;
  const remaining = Math.max(0, LARK_CRON_TEXT_LIMIT - prefix.length);
  const truncationNotice = job.locale === "en"
    ? "\n... (error detail truncated; see service logs or timeline.)"
    : "\n…（错误详情过长，已截断；完整详情见服务日志或 timeline。）";
  return `${prefix}${truncateLarkCronText(detail, remaining, truncationNotice)}`;
}

function truncateLarkCronText(value: string, limit: number, truncationNotice: string): string {
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  if (limit <= truncationNotice.length) {
    return truncationNotice.slice(0, limit);
  }
  return `${text.slice(0, limit - truncationNotice.length).trimEnd()}${truncationNotice}`;
}

function stripLarkReminderPrefix(prompt: string): string {
  const trimmed = prompt.trim();
  const stripped = trimmed
    .replace(/^(?:提醒我|提醒一下我|提醒一下|提醒)[\s:：,，。.]*/u, "")
    .replace(/^remind me(?:\s+to)?[\s:：,，.]*/i, "")
    .trim();
  return stripped || trimmed;
}

function stripLeadingLarkReminderTimeAnchors(prompt: string): string {
  let body = prompt.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stripped = body
      .replace(
        /^(?:(?:大后天|明上午|明下午|明晚上|今天|明天|后天|今晚|今早|明早|明晚|早上|上午|中午|下午|晚上|凌晨)(?:的)?|(?:下下|本|这|下)?周[一二三四五六日天](?:的)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?(?:的)?)[\s:：,，。.]*/u,
        "",
      )
      .replace(/^(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|next\s+\w+)(?:'s)?[\s:：,，.]*/i, "")
      .trim();
    if (stripped === body || stripped.length === 0) {
      break;
    }
    body = stripped;
  }
  return body || prompt.trim();
}

/** The reminder text with the "提醒我…" prefix and leading time anchors stripped — shared by the card body and the plain-text fallback. */
function larkReminderBody(job: CronJobRecord): string {
  return stripLeadingLarkReminderTimeAnchors(stripLarkReminderPrefix(job.prompt));
}

function renderLarkCronNotification(job: CronJobRecord): string {
  const prefix = job.locale === "en" ? "⏰ Reminder\n" : "⏰ 提醒\n";
  const truncationNotice = job.locale === "en"
    ? "\n... (reminder text truncated.)"
    : "\n…（提醒内容过长，已截断。）";
  return `${prefix}${truncateLarkCronText(larkReminderBody(job), LARK_CRON_TEXT_LIMIT - prefix.length, truncationNotice)}`;
}

function renderLarkEmptyCronAgentReply(job: CronJobRecord): string {
  return job.locale === "en" ? "(empty reply)" : "（空回复）";
}

function larkCronReplyOptions(job: CronJobRecord): LarkSendOptions | undefined {
  return larkReplyOptions(...larkCronReplyTuple(job));
}

function larkCronReplyFields(job: CronJobRecord): { replyTo?: string; replyInThread?: boolean } {
  const [replyTo, replyInThread] = larkCronReplyTuple(job);
  return replyTo ? { replyTo, replyInThread } : {};
}

function larkCronReplyTuple(job: CronJobRecord): [string | undefined, boolean | undefined] {
  return job.larkThreadId && job.larkMessageId ? [job.larkMessageId, true] : [undefined, undefined];
}

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }
  return {
    replyTo,
    ...(replyInThread !== undefined ? { replyInThread } : {}),
  };
}
