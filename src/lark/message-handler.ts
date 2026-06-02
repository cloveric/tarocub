import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import type { ChatQueueWaitEvent } from "../runtime/chat-queue.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import type { TurnPoolWaitEvent } from "../runtime/turn-pool.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../telegram/instance-config.js";
import { createDefaultTranscribeVoice } from "../telegram/message-input.js";
import { handleLarkCrewWorkflow } from "./bus.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkApprovalTextCommand, isLarkApprovalTextCommand, requestLarkApproval } from "./card-actions.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import {
  ELEMENT_CONTENT_MAX_BYTES,
  LARK_CARD_ANSWER_MAX,
  LARK_MAX_OVERFLOW_CARDS,
  applyLarkEngineEvent,
  cleanCardText,
  initialLarkRunState,
  renderLarkContinuationCard,
  renderLarkQueueWaitCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
  renderLarkRunCardMinimal,
  splitLarkAnswerIntoCardChunks,
  type LarkRunState,
} from "./card-renderer.js";
import {
  extractLarkMessageBody,
  formatLarkAccessReply,
  handleLarkGroupCommandBeforeAccess,
  handleLarkSimpleCommand,
  isLarkLocalEngineCommand,
  isStopCommand,
} from "./commands.js";
import { deliverLarkResponse, sendLarkMarkdown } from "./delivery.js";
import { LARK_OVERFLOW_DOC_MIN_CHARS, postLarkOverflowAnswerDoc } from "./overflow-doc.js";
import { renderLarkUserFacingError } from "./errors.js";
import { LarkGroupModeStore } from "./group-mode-store.js";
import { LarkKnownChatStore } from "./known-chats.js";
import {
  renderLarkBackgroundTaskHeader,
  renderLarkChatAccessDenied,
  renderLarkConversationQueueWait,
  renderLarkMediaTranscriptionFailure,
  renderLarkQueuedTaskSkipped,
  renderLarkStopResult,
  renderLarkTurnPoolWait,
  resolveLarkLocale,
} from "./locale.js";
import {
  boundLarkArchiveSummary,
  cleanupLarkMessageArtifacts,
  downloadLarkAttachments,
  prepareLarkFileWorkflow,
  renderLarkArchiveContinueCard,
  safeSegment,
  type DownloadedLarkAttachment,
} from "./files.js";
import {
  buildLarkConversationKey,
  normalizeLarkMessage,
  stableLarkNumericId,
  type LarkChatMode,
  type LarkIncomingMessage,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { sendManagedCard, updateManagedCard, type ManagedCardHandle } from "./managed-card.js";
import { redactLarkErrorDetail } from "./redaction.js";
import { verifyLarkNumericIds } from "./id-map.js";
import type { LarkQueueCardRef, LarkServiceRuntime } from "./runtime.js";
import { type LarkReactionSettings, withLarkMessageReactions } from "./reactions.js";
import type { LarkBridgeLike, LarkChannelLike, LarkFetchedMessage, LarkSendOptions } from "./types.js";
import type { Locale } from "../telegram/message-renderer.js";
import { appendLarkTimelineEvent } from "./timeline.js";

const defaultTranscribeLarkMedia = createDefaultTranscribeVoice();

/**
 * How long a chat's resolved session mode (conversation vs topic form) is cached.
 * Short enough that toggling a group's 群消息形式 takes effect within the window
 * without a service restart, long enough to avoid a chat.get on every message.
 */
const CHAT_FORM_CACHE_TTL_MS = 30_000;

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }
  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
}

// Deliver chunks 2..N of a long answer as standalone continuation cards (card 1, the
// run card, already carries chunk 1). Each is its own push so it lands in order and as a
// separate notification; sendLarkCardWithFallback drops to plain text per card so a
// chunk is never lost if a card render is rejected.
async function deliverLarkContinuationCards(input: {
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

type LarkTurnTermination =
  | { kind: "interrupted" }
  | { kind: "idle_timeout"; minutes: number }
  | { kind: "error" };

/**
 * Classify why an engine turn ended in error so the run card can show the
 * right terminal marker: user/stop interruption, an idle-timeout auto-stop
 * (the adapter kills a turn that goes silent for N minutes), or a real error.
 */
// Exported for focused testing: this predicate is what feeds the reaction layer's
// `isFailure` gate. A turn ended by the user (/stop, abort) or by the idle watchdog
// must classify as interrupted/idle_timeout — NOT "error" — so it is not stamped with
// the failure reaction.
export function classifyLarkTurnTermination(error: unknown, signal: AbortSignal | undefined): LarkTurnTermination {
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const idleMatch = text.match(/inactive after (\d+)\s*minute/);
  if (idleMatch) {
    return { kind: "idle_timeout", minutes: Number.parseInt(idleMatch[1] ?? "0", 10) || 0 };
  }
  if (signal?.aborted || /\b(stopped by user|task was stopped|aborted)\b/.test(text)) {
    return { kind: "interrupted" };
  }
  return { kind: "error" };
}

export async function handleLarkMessage(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  instanceName?: string;
  message: LarkIncomingMessage;
  requireMentionInGroup?: boolean;
  workspaceOverride?: string;
  reactionSettings?: LarkReactionSettings;
}): Promise<boolean> {
  const requireMentionInGroup = await resolveLarkMessageMentionRequirement({
    stateDir: input.stateDir,
    message: input.message,
    defaultRequireMentionInGroup: input.requireMentionInGroup,
  });
  const preflightNormalized = normalizeLarkMessage(input.message, {
    requireMentionInGroup,
  });
  if (!preflightNormalized) {
    return false;
  }

  const message = await resolveLarkMessageChatMode(input.channel, input.runtime, input.message);
  const baseNormalized = normalizeLarkMessage(message, {
    requireMentionInGroup,
  });
  if (!baseNormalized) {
    return false;
  }
  const expandedNormalized = await enrichLarkMergedForwardContext(input.channel, baseNormalized, message);
  const cardNormalized = await enrichLarkInteractiveCardContext(input.channel, expandedNormalized, message);
  const normalized = await enrichLarkReplyContext(input.channel, cardNormalized);
  return await runAcceptedLarkMessage(input, normalized);
}

async function resolveLarkMessageChatMode(
  channel: LarkChannelLike,
  runtime: LarkServiceRuntime,
  message: LarkIncomingMessage,
): Promise<LarkIncomingMessage> {
  if (message.chatType === "p2p") {
    return { ...message, chatMode: "p2p" };
  }
  const now = Date.now();
  // An explicitly-provided mode (e.g. tests) wins.
  if (message.chatMode) {
    runtime.chatModeCache.set(message.chatId, { mode: message.chatMode, expiresAt: now + CHAT_FORM_CACHE_TTL_MS });
    return { ...message };
  }
  const cached = runtime.chatModeCache.get(message.chatId);
  if (cached && cached.expiresAt > now) {
    return { ...message, chatMode: cached.mode };
  }
  // Resolve the chat's message form. Topic form (a native topic group, or a
  // conversation group switched to the topic message form) isolates each topic;
  // conversation form shares one group session. We map both to "topic"/"group"
  // so larkSessionThreadIdForMessage isolates only the former. Cached briefly so
  // toggling 群消息形式 takes effect without a restart.
  const mode = await resolveLarkChatSessionMode(channel, message.chatId);
  if (mode) {
    runtime.chatModeCache.set(message.chatId, { mode, expiresAt: now + CHAT_FORM_CACHE_TTL_MS });
    return { ...message, chatMode: mode };
  }
  // Couldn't determine the form (no channel support, or a transient error): do
  // NOT cache, so the next message retries. A threaded message is most likely a
  // topic (isolate to avoid bleeding contexts); a plain one is a group.
  return { ...message, chatMode: message.threadId ? "topic" : "group" };
}

/**
 * Resolve whether a group chat should isolate each topic ("topic") or share one
 * session ("group"). Prefers the topic-message-form signal (chat_mode='topic'
 * OR group_message_type='thread'); falls back to chat_mode alone, then gives up
 * (undefined) so the caller can apply a transient default without caching it.
 */
async function resolveLarkChatSessionMode(
  channel: LarkChannelLike,
  chatId: string,
): Promise<"topic" | "group" | undefined> {
  if (channel.getChatTopicForm) {
    try {
      return (await channel.getChatTopicForm(chatId)) ? "topic" : "group";
    } catch {
      // Transient failure of the precise signal: don't downgrade to the coarser
      // chat_mode (which can't see group_message_type and would mislabel a
      // thread-form group as shared). Give up so the caller retries uncached.
      return undefined;
    }
  }
  // Older channel without topic-form support: chat_mode is the best we have.
  if (channel.getChatMode) {
    try {
      return (await channel.getChatMode(chatId)) === "topic" ? "topic" : "group";
    } catch {
      // fall through to the caller's transient default
    }
  }
  return undefined;
}

async function runAcceptedLarkMessage(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: LarkNormalizedBridgeMessage,
): Promise<boolean> {
  await recordKnownLarkChat(input.stateDir, normalized);
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "input.received",
    outcome: "accepted",
    metadata: {
      messageId: normalized.messageId,
      attachments: normalized.attachments.length,
    },
  });
  await verifyLarkNumericIds(input.stateDir, normalized);

  const commandText = extractLarkMessageBody(normalized.text);
  const messageLocale = await resolveLarkLocale(input.stateDir);
  if (isStopCommand(commandText)) {
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: normalized.bridgeAccessChatId,
        conversationChatId: normalized.bridgeChatId,
        userId: normalized.bridgeUserId,
        chatType: normalized.bridgeChatType,
        conversationKey: normalized.conversationKey,
        locale: messageLocale,
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      await input.channel.send(normalized.chatId, {
        text: formatLarkDeniedAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(messageLocale), normalized, messageLocale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "denied",
        detail: "/stop",
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
    // Stop only the currently-running task; let the queue advance so other
    // queued tasks are NOT cancelled (clearPending would skip the whole queue).
    const active = input.runtime.activeRuns.get(normalized.conversationKey);
    active?.abortController.abort();
    // When the active run has a live run card, its in-place update to "已中断" is the
    // acknowledgment — skip the redundant "已停止。" text. Send text only when nothing
    // was running, or the run had no card (fallback) to reflect the stop.
    if (!active?.hasRunCard) {
      await input.channel.send(normalized.chatId, { text: renderLarkStopResult(Boolean(active), messageLocale) }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
    }
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: active ? "success" : "noop",
      detail: "/stop",
    });
    return true;
  }

  if (await handleLarkGroupCommandBeforeAccess({ ...input, requestApproval: requestLarkApproval }, normalized, commandText, messageLocale)) {
    return true;
  }

  if (isLarkApprovalTextCommand(commandText)) {
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: normalized.bridgeAccessChatId,
        conversationChatId: normalized.bridgeChatId,
        userId: normalized.bridgeUserId,
        chatType: normalized.bridgeChatType,
        conversationKey: normalized.conversationKey,
        locale: messageLocale,
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      await input.channel.send(normalized.chatId, {
        text: formatLarkDeniedAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(messageLocale), normalized, messageLocale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "denied",
        detail: "approval",
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
    const approvalResult = await handleLarkApprovalTextCommand({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      replyInThread: Boolean(normalized.threadId),
      text: commandText,
      locale: messageLocale,
    });
    if (approvalResult.handled) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: approvalResult.outcome,
        detail: "approval",
        metadata: {
          command: "approval",
          choice: approvalResult.choice,
          ...(approvalResult.requestId ? { requestId: approvalResult.requestId } : {}),
          ...(approvalResult.reason ? { reason: approvalResult.reason } : {}),
        },
      });
    }
    return approvalResult.handled;
  }

  const handleConversationQueueWait = async (event: ChatQueueWaitEvent): Promise<void> => {
    // If the user already cancelled this queued task from its card, do not
    // re-render a "queued" wait card. The cancel tap terminalizes the card to
    // "cancelled"; a wait notification that fires just after (in-flight) would
    // otherwise overwrite it back to "queued" — the reported flicker-then-revert.
    if (input.runtime.cancelledQueueTaskIds.has(normalized.messageId)) {
      return;
    }
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "engine.lock.waiting",
      detail: "waiting for Lark conversation queue",
      metadata: {
        waitedMs: event.waitedMs,
        reason: event.reason,
      },
    });
    try {
      const card = renderLarkQueueWaitCard({
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        taskId: normalized.messageId,
        waitedMs: event.waitedMs,
        replyInThread: Boolean(normalized.threadId),
        locale: messageLocale,
      });
      // Reuse a single card across repeated wait notifications, and remember it
      // so the run card can take it over (queued → running → done) instead of
      // leaving a stale "queued" card behind once the task starts.
      const existing = input.runtime.queueCards.get(normalized.messageId);
      if (existing && await updateLarkQueueCardInPlace(input.channel, existing, card)) {
        return;
      }
      // Prefer a CardKit managed card so the cancel tap can flip it to "已取消"
      // IN PLACE (CardKit survives a post-interaction update; im.message.patch
      // reverts a just-clicked card). Fall back to a normal inline card when
      // CardKit is unavailable.
      const managed = await sendManagedCard(input.channel, normalized.chatId, card, {
        replyTo: normalized.messageId,
        ...(normalized.threadId ? { replyInThread: true } : {}),
      });
      if (managed) {
        input.runtime.queueCards.set(normalized.messageId, { messageId: managed.messageId, handle: managed });
        return;
      }
      const sent = await sendLarkCardWithFallback({
        channel: input.channel,
        chatId: normalized.chatId,
        card,
        fallbackText: renderLarkConversationQueueWait(messageLocale),
        options: larkReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
        locale: messageLocale,
      });
      if (!sent.fallback) {
        input.runtime.queueCards.set(normalized.messageId, { messageId: sent.messageId });
      }
    } catch (error) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "engine.event.delivery_failed",
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        metadata: {
          eventType: "engine.lock.waiting",
          phase: "queue",
        },
      });
    }
  };

  if (shouldBatchLarkMessage(input.runtime, normalized, commandText)) {
    return await scheduleBatchedLarkTurn(input, normalized, messageLocale, handleConversationQueueWait);
  }

  preemptActiveLarkTurnIfEnabled(input, normalized, commandText);

  return await enqueueLarkTurn(input, normalized, messageLocale, handleConversationQueueWait);
}

async function enqueueLarkTurn(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: LarkNormalizedBridgeMessage,
  locale: "zh" | "en",
  onWait: (event: ChatQueueWaitEvent) => Promise<void>,
): Promise<boolean> {
  return await input.runtime.chatQueue.enqueue(normalized.conversationKey, async () => {
    return await runNormalizedLarkMessage(input, normalized);
  }, {
    taskId: normalized.messageId,
    waitNotifyAfterMs: 10_000,
    onWait,
    onSkipped: async () => {
      // A task the user cancelled from its card was already acknowledged (card
      // updated to "cancelled") by the stop handler — stay silent here so the
      // skip doesn't post a duplicate notice.
      if (input.runtime.cancelledQueueTaskIds.delete(normalized.messageId)) {
        input.runtime.queueCards.delete(normalized.messageId);
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "skipped",
          detail: "queued turn cancelled by user",
          metadata: { phase: "queue" },
        });
        return true;
      }
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: {
          phase: "queue",
        },
      });
      // A skipped turn must not leave its "queued" card spinning forever.
      const queuedRef = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      const skippedText = renderLarkQueuedTaskSkipped(locale);
      if (queuedRef && await updateLarkQueueCardInPlace(input.channel, queuedRef, {
        schema: "2.0",
        config: { update_multi: true },
        body: {
          direction: "vertical",
          padding: "12px 12px 12px 12px",
          elements: [{ tag: "markdown", content: skippedText }],
        },
      })) {
        return true;
      }
      await input.channel.send(normalized.chatId, { text: skippedText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
}

/**
 * Update a "queued" card in place. Prefers CardKit (lands even right after the
 * user taps the card's cancel button, where im.message.patch reverts), falling
 * back to im.message.patch for a plain inline card. Returns whether the in-place
 * update landed; on false the caller sends a fresh card/notice instead.
 */
async function updateLarkQueueCardInPlace(
  channel: LarkChannelLike,
  ref: LarkQueueCardRef,
  card: Record<string, unknown>,
): Promise<boolean> {
  if (ref.handle) {
    return await updateManagedCard(channel, ref.handle, card);
  }
  if (channel.updateCard) {
    try {
      await channel.updateCard(ref.messageId, card);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function settleLingeringLarkQueueCard(
  channel: LarkChannelLike,
  ref: LarkQueueCardRef,
  locale: "zh" | "en",
): Promise<void> {
  // A queued task ran without a run card taking this "queued" card over — most
  // commonly a slash command, which handleLarkSimpleCommand processes and returns
  // from before the run-card hand-off (that hand-off is what normally transitions
  // the card in place). The task's real outcome was already posted as its own
  // message, so this card is now stale. Recall it for a clean thread; if the
  // channel can't recall, at least flip it out of the "排队中" state so its
  // now-dead Cancel/Wait buttons can't mislead the user into thinking it's stuck.
  if (channel.recallMessage) {
    await channel.recallMessage(ref.messageId).catch(() => undefined);
    return;
  }
  await updateLarkQueueCardInPlace(channel, ref, {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{ tag: "markdown", content: locale === "en" ? "✅ Done." : "✅ 已结束。" }],
    },
  }).catch(() => undefined);
}

function shouldBatchLarkMessage(
  runtime: LarkServiceRuntime,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): boolean {
  return runtime.queuePolicy.batchWindowMs > 0 &&
    // Only batch in private chats. In a group, messages on one conversationKey
    // can come from DIFFERENT users; merging them would run a second user's text
    // under the first sender's authorization (and attribution). p2p has a single
    // sender, so coalescing is safe there.
    normalized.bridgeChatType === "private" &&
    !isSlashCommand(commandText) &&
    normalized.attachments.length === 0;
}

function preemptActiveLarkTurnIfEnabled(
  input: { runtime: LarkServiceRuntime },
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): void {
  if (!input.runtime.queuePolicy.preempt || isSlashCommand(commandText)) {
    return;
  }
  const active = input.runtime.activeRuns.get(normalized.conversationKey);
  active?.abortController.abort();
  input.runtime.chatQueue.clearPending(normalized.conversationKey);
}

function isSlashCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function scheduleBatchedLarkTurn(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: LarkNormalizedBridgeMessage,
  locale: "zh" | "en",
  onWait: (event: ChatQueueWaitEvent) => Promise<void>,
): Promise<boolean> {
  const existing = input.runtime.pendingBatches.get(normalized.conversationKey);
  if (existing) {
    clearTimeout(existing.timer);
    existing.normalized = {
      ...existing.normalized,
      messageId: normalized.messageId,
      text: mergeBatchedTexts([...existing.texts, normalized.text]),
    };
    existing.texts.push(normalized.text);
    return new Promise<boolean>((resolve, reject) => {
      existing.resolve.push(resolve);
      existing.reject.push(reject);
      existing.timer = setTimeout(() => {
        void flushBatchedLarkTurn(input, normalized.conversationKey, locale, onWait);
      }, input.runtime.queuePolicy.batchWindowMs);
      existing.timer.unref?.();
    });
  }

  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      void flushBatchedLarkTurn(input, normalized.conversationKey, locale, onWait);
    }, input.runtime.queuePolicy.batchWindowMs);
    timer.unref?.();
    input.runtime.pendingBatches.set(normalized.conversationKey, {
      normalized: { ...normalized },
      texts: [normalized.text],
      timer,
      resolve: [resolve],
      reject: [reject],
    });
  });
}

async function flushBatchedLarkTurn(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  conversationKey: string,
  locale: "zh" | "en",
  onWait: (event: ChatQueueWaitEvent) => Promise<void>,
): Promise<void> {
  const batch = input.runtime.pendingBatches.get(conversationKey);
  if (!batch) {
    return;
  }
  input.runtime.pendingBatches.delete(conversationKey);
  try {
    preemptActiveLarkTurnIfEnabled(input, batch.normalized, batch.normalized.text);
    const result = await enqueueLarkTurn(input, batch.normalized, locale, onWait);
    for (const resolve of batch.resolve) {
      resolve(result);
    }
  } catch (error) {
    for (const reject of batch.reject) {
      reject(error);
    }
  }
}

function mergeBatchedTexts(texts: string[]): string {
  return texts
    .map((text, index) => `#${index + 1}\n${text.trim()}`)
    .join("\n\n");
}

function formatLarkDeniedAccessReply(
  text: string,
  normalized: LarkNormalizedBridgeMessage,
  locale: "zh" | "en",
): string {
  const base = formatLarkAccessReply(text);
  if (normalized.bridgeChatType !== "group" || base.includes("/invite group") || base.includes("/group allow")) {
    return base;
  }
  const hint = locale === "en"
    ? "If you are an authorized user, send `/invite group` or `/group allow` in this group. Otherwise, pair with the bot in private chat first."
    : "如果你是已授权用户，可在本群发送 `/invite group` 或 `/group allow` 允许当前群；否则请先私聊 bot 完成配对。";
  return `${base}\n\n${hint}`;
}

async function recordKnownLarkChat(stateDir: string, normalized: LarkNormalizedBridgeMessage): Promise<void> {
  try {
    await new LarkKnownChatStore(stateDir).record(normalized);
  } catch {
    // Chat labels are diagnostic metadata; never let them block message handling.
  }
}

async function resolveLarkMessageMentionRequirement(input: {
  stateDir: string;
  message: LarkIncomingMessage;
  defaultRequireMentionInGroup?: boolean;
}): Promise<boolean> {
  if (input.message.chatType === "p2p") {
    return false;
  }
  const groupMode = (await loadInstanceConfig(input.stateDir)).groupMode;
  if (!groupMode.enabled) {
    return true;
  }
  if (input.defaultRequireMentionInGroup === false) {
    return false;
  }
  if (await new LarkGroupModeStore(input.stateDir).isListenAll(input.message.chatId)) {
    return false;
  }
  const accessChatId = stableLarkNumericId(buildLarkConversationKey(input.message.chatId));
  const conversationChatId = stableLarkNumericId(buildLarkConversationKey(input.message.chatId, input.message.threadId));
  if (groupMode.listenAllChatIds.includes(accessChatId) || groupMode.listenAllChatIds.includes(conversationChatId)) {
    return false;
  }
  return true;
}

async function runNormalizedLarkMessage(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: LarkNormalizedBridgeMessage,
): Promise<boolean> {
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "turn.started",
    metadata: {
      phase: "queued-job",
    },
  });
  const cfg = await loadInstanceConfig(input.stateDir);
  const workspaceOverride = input.workspaceOverride ?? resolveInstanceWorkspacePath(cfg);
  const locale = await resolveLarkLocale(input.stateDir);
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeAccessChatId,
      conversationChatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale,
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await input.channel.send(normalized.chatId, { text: formatLarkDeniedAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(locale), normalized, locale) }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "denied",
      detail: "access denied",
    });
    return true;
  }

  const commandText = extractLarkMessageBody(normalized.text);

  let abortController: AbortController | undefined;
  const activateRun = (): AbortController => {
    if (!abortController) {
      const active = input.runtime.activeRuns.get(normalized.conversationKey);
      if (active?.goalWatch) {
        active.abortController.abort();
      }
      abortController = new AbortController();
      input.runtime.activeRuns.set(normalized.conversationKey, { abortController });
    }
    return abortController;
  };

  try {
    const simpleCommandController = isLarkLocalEngineCommand(commandText) ? activateRun() : undefined;
    if (await handleLarkSimpleCommand({
      ...input,
      requestApproval: requestLarkApproval,
      abortSignal: simpleCommandController?.signal,
      createRunCard: createLarkRunCardController,
    }, normalized, commandText)) {
      return true;
    }

    const runController = activateRun();

    if (await handleLarkCrewWorkflow({
      ...input,
      requestApproval: requestLarkApproval,
      abortSignal: runController.signal,
    }, normalized, commandText)) {
      return true;
    }

    let downloadedAttachments: DownloadedLarkAttachment[];
    let files: string[];
    let requestText = normalized.text;
    let workflowRecordId: string | undefined;
    let requestOutputDir: string;
    try {
      downloadedAttachments = await downloadLarkAttachments({
        channel: input.channel,
        stateDir: input.stateDir,
        messageId: normalized.messageId,
        attachments: normalized.attachments,
      });
      const mediaDownloads = downloadedAttachments.filter(isTranscribableLarkMedia);
      const workflowDownloads = downloadedAttachments.filter((attachment) => !isTranscribableLarkMedia(attachment));
      if (mediaDownloads.length > 0) {
        const transcribeMedia = input.runtime.transcribeMedia ?? defaultTranscribeLarkMedia;
        for (const media of mediaDownloads) {
          try {
            const transcript = await transcribeMedia(media.localPath);
            if (transcript.trim()) {
              requestText = requestText.trim() ? `${requestText.trim()}\n${transcript.trim()}` : transcript.trim();
            }
          } catch {
            await input.channel.send(normalized.chatId, {
              text: renderLarkMediaTranscriptionFailure(locale),
            }, {
              replyTo: normalized.messageId,
              replyInThread: Boolean(normalized.threadId),
            });
            await appendLarkTimelineEvent(input.stateDir, normalized, {
              type: "turn.completed",
              outcome: "error",
              detail: "lark media transcription failed",
              metadata: {
                phase: "prepare",
                kind: media.attachment.kind,
              },
            });
            return true;
          }
        }
      }
      files = workflowDownloads.map((attachment) => attachment.localPath);
      const workflowResult = await prepareLarkFileWorkflow({
        stateDir: input.stateDir,
        normalized: { ...normalized, text: requestText },
        commandText,
        downloadedAttachments: workflowDownloads,
      });
      if (workflowResult?.workflowRecordId) {
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "workflow.prepared",
          detail: downloadedAttachments.length > 0 ? "attachment workflow prepared" : "workflow prepared",
          metadata: {
            workflowRecordId: workflowResult.workflowRecordId,
            kind: workflowResult.kind,
          },
        });
      }
      if (workflowResult?.kind === "reply") {
        const deliveryText = workflowResult.workflowRecordId
          ? boundLarkArchiveSummary(workflowResult.text)
          : workflowResult.text;
        await sendLarkMarkdown(input.channel, normalized.chatId, deliveryText, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
        if (workflowResult.workflowRecordId) {
          await sendLarkCardWithFallback({
            channel: input.channel,
            chatId: normalized.chatId,
            card: renderLarkArchiveContinueCard({
              uploadId: workflowResult.workflowRecordId,
              conversationKey: normalized.conversationKey,
              bridgeChatType: normalized.bridgeChatType,
              replyInThread: Boolean(normalized.threadId),
              locale,
            }),
            fallbackText: locale === "en"
              ? `Archive prepared. Continue with /resume ${workflowResult.workflowRecordId}`
              : `压缩包已准备好。继续处理请使用 /resume ${workflowResult.workflowRecordId}`,
            options: {
              replyTo: normalized.messageId,
              replyInThread: Boolean(normalized.threadId),
            },
            locale,
          });
        }
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "success",
          metadata: {
            responseChars: deliveryText.length,
            attachments: normalized.attachments.length,
            workflowRecordId: workflowResult.workflowRecordId,
          },
        });
        return true;
      }
      if (workflowResult?.kind === "direct") {
        requestText = workflowResult.text;
        files = [...workflowResult.files];
        workflowRecordId = workflowResult.workflowRecordId;
      }
      requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(normalized.messageId));
      await mkdir(requestOutputDir, { recursive: true });
    } catch (error) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        metadata: {
          phase: "prepare",
        },
      });
      await input.channel.send(normalized.chatId, {
        text: renderLarkUserFacingError(error, "prepare", locale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    }

    // Enforce the spend budget before running the engine — parity with the
    // Telegram and bus entry points, which both gate here. Without this the
    // Lark channel only recorded usage after the fact and silently ignored the
    // configured budgetUsd. Slash commands (handled above) are not gated.
    const budgetExhausted = await checkBudgetAvailability(input.stateDir, cfg.budgetUsd, locale);
    if (budgetExhausted) {
      await input.channel.send(normalized.chatId, { text: budgetExhausted.message }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "noop",
        detail: "budget exhausted",
        metadata: { phase: "budget", budgetUsd: budgetExhausted.budgetUsd, totalCostUsd: budgetExhausted.usage.totalCostUsd },
      });
      return true;
    }

    let runCard: LarkRunCardController | undefined;
    try {
      // If a "queued" card was already shown for this conversation, take it over
      // as the run card so it transitions in place instead of being orphaned: a
      // CardKit-managed queue card is updated by card_id (seamless, survives the
      // take-over), a plain inline one via im.message.patch.
      const queuedRef = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      runCard = await createLarkRunCardController({
        channel: input.channel,
        chatId: normalized.chatId,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
        locale,
        ...(queuedRef ? { existingCard: queuedRef } : {}),
        ...(normalized.goalObjective ? { goalObjective: normalized.goalObjective } : {}),
      });
      // Record whether a live run card exists so the stop handlers can skip the
      // redundant "已停止。" text — the card itself updates in place to "已中断".
      const activeHandle = input.runtime.activeRuns.get(normalized.conversationKey);
      if (activeHandle) {
        activeHandle.hasRunCard = Boolean(runCard);
      }
      const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
        await runCard?.apply(event);
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "engine.event",
          detail: event.type,
          metadata: {
            toolName: "toolName" in event ? event.toolName : undefined,
            textChars: "text" in event ? event.text.length : undefined,
            status: "status" in event ? event.status : undefined,
          },
        });

        if (event.type !== "task_notification" || event.settlesCurrentTurn) {
          return;
        }

        const notificationText = [
          renderLarkBackgroundTaskHeader(locale),
          event.text.trim(),
        ].filter(Boolean).join("\n");
        try {
          await deliverLarkResponse({
            channel: input.channel,
            runtime: input.runtime,
            chatId: normalized.chatId,
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
            text: notificationText,
            stateDir: input.stateDir,
            requestOutputDir,
            workspaceOverride,
            conversationKey: normalized.conversationKey,
            bridgeChatType: normalized.bridgeChatType,
            bridgeChatId: normalized.bridgeChatId,
            bridgeUserId: normalized.bridgeUserId,
            larkThreadId: normalized.threadId,
            larkMessageId: normalized.messageId,
            instanceName: input.instanceName,
          });
        } catch (error) {
          await appendLarkTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactLarkErrorDetail(error),
            metadata: {
              eventType: event.type,
            },
          });
        }
      };
      const handleTurnLockWait = async (event: BridgeTurnLockWaitEvent): Promise<void> => {
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "engine.lock.waiting",
          detail: "waiting for shared engine session lock",
          metadata: {
            sessionId: event.sessionId,
            waitedMs: event.waitedMs,
            reason: event.reason,
          },
        });
        const waitText = locale === "zh"
          ? "另一个入口正在使用同一个 AI session，这条消息已排队等待。前一个任务完成后会继续处理。"
          : "Another entry is using the same AI session. This message is queued and will continue after the active turn finishes.";
        try {
          await deliverLarkResponse({
            channel: input.channel,
            runtime: input.runtime,
            chatId: normalized.chatId,
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
            text: waitText,
            stateDir: input.stateDir,
            requestOutputDir,
            workspaceOverride,
            conversationKey: normalized.conversationKey,
            bridgeChatType: normalized.bridgeChatType,
            bridgeChatId: normalized.bridgeChatId,
            bridgeUserId: normalized.bridgeUserId,
            larkThreadId: normalized.threadId,
            larkMessageId: normalized.messageId,
            instanceName: input.instanceName,
          });
        } catch (error) {
          await appendLarkTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactLarkErrorDetail(error),
            metadata: {
              eventType: "engine.lock.waiting",
            },
          });
        }
      };
      const handleTurnPoolWait = async (event: TurnPoolWaitEvent): Promise<void> => {
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "engine.lock.waiting",
          detail: "waiting for shared AI worker capacity",
          metadata: {
            waitedMs: event.waitedMs,
            activeCount: event.activeCount,
            maxActive: event.maxActive,
            reason: event.reason,
          },
        });
        try {
          await sendLarkMarkdown(
            input.channel,
            normalized.chatId,
            renderLarkTurnPoolWait(locale),
            larkReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
          );
        } catch (error) {
          await appendLarkTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactLarkErrorDetail(error),
            metadata: {
              eventType: "engine.lock.waiting",
              phase: "turn-pool",
            },
          });
        }
      };

      return await runAuthorizedLarkTurnWithReactions(input, normalized, async () => {
        const result = await input.bridge.handleAuthorizedMessage({
          chatId: normalized.bridgeAccessChatId,
          userId: normalized.bridgeUserId,
          chatType: normalized.bridgeChatType,
          locale,
          text: requestText,
          ...(normalized.replyContext ? { replyContext: normalized.replyContext } : {}),
          conversationKey: normalized.conversationKey,
          files,
          requestOutputDir,
          workspaceOverride,
          abortSignal: runController.signal,
          onApprovalRequest: async (request) => await requestLarkApproval({
            channel: input.channel,
            runtime: input.runtime,
            chatId: normalized.chatId,
            conversationKey: normalized.conversationKey,
            bridgeChatType: normalized.bridgeChatType,
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
            locale,
            request,
            abortSignal: request.abortSignal ?? runController.signal,
          }),
          onEngineEvent: handleEngineEvent,
          onTurnLockWait: handleTurnLockWait,
          turnPoolWaitNotifyAfterMs: 10_000,
          onTurnPoolWait: handleTurnPoolWait,
          instructions: larkAgentInstructions(),
          extraEnv: {
            CCTB_LARK_ACTIVE_TURN: "1",
            CCTB_LARK_ACTIVE_INSTANCE: input.instanceName ?? path.basename(input.stateDir),
            CCTB_LARK_ACTIVE_STATE_DIR: input.stateDir,
          },
        });
        // A reply too long for one card spills into continuation cards (card 2 continues
        // card 1) rather than a Feishu Doc, which the operator finds more natural to read
        // inline. The run card becomes card 1 (chunk 1); the rest follow as their own
        // cards. Only a genuinely document-sized reply (more than LARK_MAX_OVERFLOW_CARDS
        // chunks) still uses a Doc, where a long stream of cards would be worse.
        // Split the CLEANED display text (tags stripped, headings downgraded) — the same
        // transform the run card applies — so chunk sizing/boundaries match what is shown,
        // a tag-heavy reply isn't over-split into near-empty cards, and continuation cards
        // render consistently with the run card. deliverLarkResponse still gets the raw
        // result.text below so file/image tags are actually processed.
        const cardDisplayText = runCard !== undefined ? cleanCardText(result.text) : result.text;
        const answerChunks = runCard !== undefined
          ? splitLarkAnswerIntoCardChunks(cardDisplayText)
          : [cardDisplayText];
        const spillToContinuationCards = runCard !== undefined
          && answerChunks.length > 1
          && answerChunks.length <= LARK_MAX_OVERFLOW_CARDS;
        const answerShownInCard =
          (await runCard?.finish(spillToContinuationCards ? answerChunks[0]! : cardDisplayText)) ?? false;
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        let overflowDelivered = false;
        if (spillToContinuationCards && answerShownInCard) {
          // Run card carries chunk 1; send chunks 2..N as continuation cards, each its
          // own push in order. sendLarkCardWithFallback drops to plain text per card, so
          // a chunk is never lost even if a card render is rejected.
          await deliverLarkContinuationCards({
            channel: input.channel,
            chatId: normalized.chatId,
            chunks: answerChunks,
            replyOptions: larkReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
            locale,
          });
          overflowDelivered = true;
        } else if (
          // The card couldn't fit the answer and it's too big to spill into a bounded
          // number of cards → stash the full text in a Feishu Doc and post just the link,
          // instead of dumping a huge multi-part markdown message. The card keeps its
          // truncated preview. If doc creation fails, fall through to the markdown dump so
          // the content is never lost.
          runCard !== undefined
          && !answerShownInCard
          && (result.text.length > LARK_OVERFLOW_DOC_MIN_CHARS
            || Buffer.byteLength(result.text, "utf8") > ELEMENT_CONTENT_MAX_BYTES)
        ) {
          const overflow = await postLarkOverflowAnswerDoc({
            channel: input.channel,
            createDocument: input.runtime.createDocument,
            chatId: normalized.chatId,
            replyOptions: larkReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
            text: result.text,
            locale,
          });
          overflowDelivered = overflow.delivered;
          if (overflow.mode !== "doc") {
            // The Feishu Doc step failed — surface why (it is otherwise swallowed) so
            // the .md-file fallback the operator sees can be traced to its cause.
            await appendLarkTimelineEvent(input.stateDir, normalized, {
              type: "engine.event.delivery_failed",
              detail: "overflow_doc_create_failed",
              metadata: {
                fallback: overflow.mode,
                docError: overflow.docError,
                ...(overflow.mode === "failed" ? { fileError: overflow.fileError } : {}),
              },
            });
          }
        }
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
          text: result.text,
          // The run card is normally the single canonical reply. Send a separate
          // markdown message only when there is no card, OR when the answer was too
          // long to show in the card AND we couldn't post it as a Feishu Doc — so the
          // full text is never lost. deliverLarkResponse still processes tool tags /
          // files / images regardless.
          sendText: runCard === undefined || (!answerShownInCard && !overflowDelivered),
          stateDir: input.stateDir,
          requestOutputDir,
          workspaceOverride,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          bridgeChatId: normalized.bridgeChatId,
          bridgeUserId: normalized.bridgeUserId,
          larkThreadId: normalized.threadId,
          larkMessageId: normalized.messageId,
          instanceName: input.instanceName,
        });
        if (workflowRecordId) {
          await new FileWorkflowStore(input.stateDir).update(workflowRecordId, (record) => {
            record.status = "completed";
          });
          await appendLarkTimelineEvent(input.stateDir, normalized, {
            type: "workflow.completed",
            detail: "workflow marked completed",
            metadata: {
              workflowRecordId,
            },
          });
        }
        await appendLarkTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "success",
          metadata: {
            responseChars: result.text.length,
            attachments: normalized.attachments.length,
          },
        });
        return true;
      });
    } catch (error) {
      const terminal = classifyLarkTurnTermination(error, runController.signal);
      if (terminal.kind === "interrupted") {
        await runCard?.interrupt();
      } else if (terminal.kind === "idle_timeout") {
        await runCard?.idleTimeout(terminal.minutes);
      } else {
        await runCard?.fail(renderLarkUserFacingError(error, "engine", locale));
      }
      // The run card already surfaces the terminal state; only send a separate
      // message when no card is present (fallback) so we don't duplicate it.
      if (!runCard) {
        await input.channel.send(normalized.chatId, {
          text: terminal.kind === "interrupted"
            ? (locale === "en" ? "Stopped." : "已停止。")
            : terminal.kind === "idle_timeout"
              ? (locale === "en"
                ? `No response for ${terminal.minutes} minute(s); the task was auto-stopped. Restart the instance if it keeps happening.`
                : `${terminal.minutes} 分钟无响应，任务已自动终止。若反复出现，请重启实例。`)
              : renderLarkUserFacingError(error, "engine", locale),
        }, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
      }
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: terminal.kind === "interrupted" ? "interrupted" : terminal.kind === "idle_timeout" ? "idle_timeout" : "error",
        detail: redactLarkErrorDetail(error),
      });
      return true;
    }
  } finally {
    if (abortController) {
      const active = input.runtime.activeRuns.get(normalized.conversationKey);
      if (active?.abortController === abortController) {
        input.runtime.activeRuns.delete(normalized.conversationKey);
      }
    }
    // A "queued" card is normally taken over by the run card, whose creation
    // deletes this entry. If it's still tracked, the task finished via an
    // early-return path that never reached that hand-off — most commonly a queued
    // slash command (e.g. /effort max) — so settle the now-stale card instead of
    // leaving it stuck on "排队中" with dead Cancel/Wait buttons. The task's real
    // outcome was already posted as its own message.
    const lingeringQueuedRef = input.runtime.queueCards.get(normalized.messageId);
    if (lingeringQueuedRef) {
      input.runtime.queueCards.delete(normalized.messageId);
      await settleLingeringLarkQueueCard(input.channel, lingeringQueuedRef, locale).catch(() => undefined);
    }
    await cleanupLarkMessageArtifacts(input.stateDir, normalized.messageId).catch(() => undefined);
  }
}

export interface LarkRunCardController {
  apply(event: EngineStreamEvent): Promise<void>;
  /** Finalize with the answer; resolves to whether the answer is fully shown in the card. */
  finish(text: string): Promise<boolean>;
  fail(text: string): Promise<void>;
  interrupt(): Promise<void>;
  idleTimeout(minutes: number): Promise<void>;
}

export async function createLarkRunCardController(input: {
  channel: LarkChannelLike;
  chatId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  /** Optional: a scheduled (cron) run card has no originating message to reply to → send fresh. */
  replyTo?: string;
  replyInThread?: boolean;
  locale: "zh" | "en";
  /** Reuse the queued card (managed → CardKit in place; inline → patch) instead of sending a new one. */
  existingCard?: LarkQueueCardRef;
  /** When set, frames the card as an autonomous /goal pursuit (🎯 banner). */
  goalObjective?: string;
}): Promise<LarkRunCardController | undefined> {
  if (!input.channel.updateCard) {
    return undefined;
  }
  let state: LarkRunState = initialLarkRunState(input.conversationKey, input.bridgeChatType);
  if (input.goalObjective && input.goalObjective.trim()) {
    state = { ...state, goalObjective: input.goalObjective.trim() };
  }
  // When set, the run card is a CardKit managed card updated in place by card_id
  // (it survives the queue→run take-over and post-interaction updates, where
  // im.message.patch reverts). Otherwise it's a plain inline card patched by
  // message id — the fallback when CardKit is unavailable.
  let handle: ManagedCardHandle | undefined;
  let sent: { messageId: string; fallback: boolean } = { messageId: "", fallback: true };

  // 1) Take the queued card over as the run card, in place.
  if (input.existingCard?.handle) {
    handle = input.existingCard.handle;
    if (await updateManagedCard(input.channel, handle, renderLarkRunCard(state, input.locale))) {
      sent = { messageId: handle.messageId, fallback: false };
    } else {
      // CardKit take-over failed → recall the orphan and create a fresh card.
      handle = undefined;
      if (input.channel.recallMessage) {
        await input.channel.recallMessage(input.existingCard.messageId).catch(() => undefined);
      }
    }
  } else if (input.existingCard?.messageId) {
    try {
      await input.channel.updateCard(input.existingCard.messageId, renderLarkRunCard(state, input.locale));
      sent = { messageId: input.existingCard.messageId, fallback: false };
    } catch {
      sent = { messageId: input.existingCard.messageId, fallback: true };
    }
  }

  // 2) No reusable card (or take-over failed) → send a fresh one. Prefer a
  // CardKit managed card so the whole run card updates in place; fall back to a
  // plain inline card when CardKit is unavailable.
  if (sent.fallback) {
    const managed = await sendManagedCard(input.channel, input.chatId, renderLarkRunCard(state, input.locale), {
      replyTo: input.replyTo,
      ...(input.replyInThread ? { replyInThread: true } : {}),
    });
    if (managed) {
      handle = managed;
      sent = { messageId: managed.messageId, fallback: false };
    } else {
      sent = await sendLarkCardWithFallback({
        channel: input.channel,
        chatId: input.chatId,
        card: renderLarkRunCard(state, input.locale),
        fallbackText: input.locale === "en"
          ? "Task is running. Send /stop to cancel it."
          : "任务处理中，可发送 /stop 停止。",
        options: larkReplyOptions(input.replyTo, input.replyInThread),
        locale: input.locale,
      });
    }
  }
  if (sent.fallback) {
    return undefined;
  }
  // Once the full card is too large for Feishu's update limit, every update
  // fails; switch to the compact render so live progress (and finalization)
  // keep landing instead of freezing the card in its "running" state.
  let degraded = false;
  const tryUpdate = async (card: Record<string, unknown>): Promise<boolean> => {
    if (handle) {
      return await updateManagedCard(input.channel, handle, card);
    }
    if (!input.channel.updateCard) {
      return false;
    }
    try {
      await input.channel.updateCard(sent.messageId, card);
      return true;
    } catch {
      return false;
    }
  };
  const update = async (): Promise<void> => {
    if (!degraded) {
      if (await tryUpdate(renderLarkRunCard(state, input.locale))) {
        return;
      }
      degraded = true;
    }
    await tryUpdate(renderLarkRunCardCompact(state, input.locale));
  };
  // Coalesce live updates to at most one patch per THROTTLE_MS, and run every
  // patch through a single serial chain so they never race — same idea as the
  // SDK's streaming throttle + patch queue. Engine events fire-and-forget into
  // this, so it never adds reply latency; it just avoids hammering Feishu's
  // card API on fast token streams, and guarantees the terminal patch lands
  // last (a late "running" patch can't revert a finished card).
  const THROTTLE_MS = 400;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let patchChain: Promise<void> = Promise.resolve();
  const enqueuePatch = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = patchChain.then(fn, fn);
    patchChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const flushUpdate = (): void => {
    updateTimer = undefined;
    void enqueuePatch(update);
  };
  // Leading edge: the very first live update fires immediately so the card
  // shows progress without waiting a full throttle interval; the rest coalesce.
  let firstLiveUpdateDone = false;
  const scheduleUpdate = (): void => {
    if (!firstLiveUpdateDone) {
      firstLiveUpdateDone = true;
      void enqueuePatch(update);
      return;
    }
    if (updateTimer) {
      return;
    }
    updateTimer = setTimeout(flushUpdate, THROTTLE_MS);
    updateTimer.unref?.();
  };
  const cancelScheduledUpdate = (): void => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
    }
  };
  // Terminal update: guarantee the card leaves the "running" state and the
  // answer is not lost. Try the full card, then the compact card, and as a
  // last resort deliver the text directly so a failed patch never swallows it.
  // Returns whether the full answer is visible in the rendered card. When it is
  // not (the card was truncated or fell back to the tiny terminal card), the
  // caller delivers the answer as a separate text message so nothing is lost.
  const finalize = async (text?: string): Promise<boolean> => {
    // Byte-aware, not just char-count: Feishu's element limit is in BYTES (CJK is
    // ~3 bytes/char), so a long Chinese answer can be byte-truncated in the card
    // while its char length is well under the cap. Checking chars alone reported
    // "fit" for a truncated answer → the overflow fallback never fired and the rest
    // was lost. Require BOTH char and byte budgets so a too-big answer is delivered
    // out-of-band instead.
    const answerFitsCard = !text
      || (text.length <= LARK_CARD_ANSWER_MAX && Buffer.byteLength(text, "utf8") <= ELEMENT_CONTENT_MAX_BYTES);
    if (!degraded && await tryUpdate(renderLarkRunCard(state, input.locale))) {
      return answerFitsCard;
    }
    degraded = true;
    if (await tryUpdate(renderLarkRunCardCompact(state, input.locale))) {
      return answerFitsCard;
    }
    // Both the full and compact cards can be rejected when a single element
    // (e.g. a long CJK answer) exceeds Feishu's limit. Fall back to a guaranteed-
    // tiny terminal card so the card never freezes in "running"; the caller then
    // delivers the answer as text.
    await tryUpdate(renderLarkRunCardMinimal(state, input.locale));
    return false;
  };
  return {
    apply: async (event) => {
      state = applyLarkEngineEvent(state, event);
      // Coalesced, non-blocking: never await the live patch.
      scheduleUpdate();
    },
    finish: async (text): Promise<boolean> => {
      // Reuse the reducer so non-streaming engines (which emit no incremental
      // assistant_text) still get the final answer seeded into the block stream.
      state = applyLarkEngineEvent(state, { type: "result", text });
      cancelScheduledUpdate();
      // Returns whether the answer is fully visible in the card.
      return await enqueuePatch(() => finalize(text));
    },
    fail: async (text) => {
      state = {
        ...state,
        status: "error",
        errorText: text,
        footer: null,
      };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
    },
    interrupt: async () => {
      state = { ...state, status: "interrupted", footer: null };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
    },
    idleTimeout: async (minutes) => {
      state = { ...state, status: "idle_timeout", idleTimeoutMinutes: minutes, footer: null };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
    },
  };
}

async function runAuthorizedLarkTurnWithReactions<T>(
  input: {
    channel: LarkChannelLike;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: LarkNormalizedBridgeMessage,
  run: () => Promise<T>,
): Promise<T> {
  if (!input.reactionSettings) {
    return await run();
  }
  return await withLarkMessageReactions({
    channel: input.channel,
    messageId: normalized.messageId,
    settings: input.reactionSettings,
    isFailure: (error) => classifyLarkTurnTermination(error, undefined).kind === "error",
    run,
  });
}

async function enrichLarkReplyContext(
  channel: LarkChannelLike,
  normalized: LarkNormalizedBridgeMessage,
): Promise<LarkNormalizedBridgeMessage> {
  if (!normalized.replyToMessageId) {
    return normalized;
  }
  try {
    const fetched = await fetchLarkMessage(channel, normalized.replyToMessageId);
    const text = fetched ? summarizeLarkFetchedMessage(fetched) : "";
    if (!text) {
      return normalized;
    }
    return {
      ...normalized,
      replyContext: {
        messageId: normalized.replyToMessageId,
        text,
      },
    };
  } catch {
    return normalized;
  }
}

async function enrichLarkMergedForwardContext(
  channel: LarkChannelLike,
  normalized: LarkNormalizedBridgeMessage,
  message: LarkIncomingMessage,
): Promise<LarkNormalizedBridgeMessage> {
  if (message.rawContentType !== "merge_forward") {
    return normalized;
  }
  try {
    const fetched = await fetchLarkMessage(channel, message.messageId);
    const expanded = fetched ? summarizeLarkMergedForward(fetched) : "";
    if (!expanded) {
      return normalized;
    }
    return {
      ...normalized,
      text: replaceOrAppendLarkForwardedMessages(normalized.text, expanded),
    };
  } catch {
    return normalized;
  }
}

// The placeholder the channel emits when it can't read an interactive card from the
// receive event (managed/forwarded cards arrive as a reference, not inline content).
const LARK_INTERACTIVE_CARD_PLACEHOLDER = "[interactive card]";

/**
 * A forwarded/received interactive card arrives as an opaque reference, so the channel
 * surfaces only "[interactive card]" and the engine can't see the content. Re-fetch the
 * message with card_msg_content_type=user_card_content (official API: returns the original
 * card JSON) and splice the card's extracted text into the prompt, so the bot can read a
 * forwarded card. No cross-app issue: the bot reads its OWN received message.
 */
async function enrichLarkInteractiveCardContext(
  channel: LarkChannelLike,
  normalized: LarkNormalizedBridgeMessage,
  message: LarkIncomingMessage,
): Promise<LarkNormalizedBridgeMessage> {
  if (message.rawContentType !== "interactive") {
    return normalized;
  }
  if ((message.content ?? "").trim() !== LARK_INTERACTIVE_CARD_PLACEHOLDER) {
    return normalized; // the channel already extracted usable text
  }
  try {
    const cardJson = await fetchLarkCardContent(channel, message.messageId);
    const text = cardJson ? extractLarkCardText(cardJson) : "";
    if (!text) {
      return normalized;
    }
    const block = `<forwarded_card>\n${text.slice(0, 8000)}\n</forwarded_card>`;
    const newText = normalized.text.includes(LARK_INTERACTIVE_CARD_PLACEHOLDER)
      ? normalized.text.replace(LARK_INTERACTIVE_CARD_PLACEHOLDER, block)
      : [normalized.text, block].filter(Boolean).join("\n\n");
    return { ...normalized, text: newText };
  } catch {
    return normalized;
  }
}

/** GET a message with card_msg_content_type=user_card_content → the original card JSON. */
async function fetchLarkCardContent(channel: LarkChannelLike, messageId: string): Promise<Record<string, unknown> | null> {
  const getMessage = (channel as {
    rawClient?: {
      im?: { v1?: { message?: { get(input: {
        params: { user_id_type: "open_id"; card_msg_content_type: "user_card_content" };
        path: { message_id: string };
      }): Promise<unknown> } } };
    };
  }).rawClient?.im?.v1?.message?.get;
  if (!getMessage) {
    return null;
  }
  const response = await getMessage({
    params: { user_id_type: "open_id", card_msg_content_type: "user_card_content" },
    path: { message_id: messageId },
  });
  const data = isRecord(response) ? response.data : undefined;
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const body = items[0] && isRecord(items[0].body) ? items[0].body : undefined;
  const content = body && typeof body.content === "string" ? body.content : undefined;
  return content ? parseJsonObject(content) : null;
}

async function fetchLarkMessage(channel: LarkChannelLike, messageId: string): Promise<LarkFetchedMessage | null> {
  if (channel.fetchMessage) {
    return await channel.fetchMessage(messageId);
  }
  const rawClient = (channel as {
    rawClient?: {
      im?: {
        v1?: {
          message?: {
            get(input: {
              params: { user_id_type: "open_id"; card_msg_content_type: "user_card_content" };
              path: { message_id: string };
            }): Promise<unknown>;
          };
        };
      };
    };
  }).rawClient;
  const getMessage = rawClient?.im?.v1?.message?.get;
  if (!getMessage) {
    return null;
  }
  const response = await getMessage({
    params: { user_id_type: "open_id", card_msg_content_type: "user_card_content" },
    path: { message_id: messageId },
  });
  return normalizeFetchedLarkMessage(response, messageId);
}

function normalizeFetchedLarkMessage(value: unknown, fallbackMessageId: string): LarkFetchedMessage | null {
  const data = isRecord(value) ? value.data : undefined;
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const item = items[0];
  if (!item) {
    return null;
  }
  const parent = normalizeFetchedLarkMessageItem(item, fallbackMessageId);
  const children = items
    .slice(1)
    .filter((child) => child.upper_message_id === undefined || child.upper_message_id === parent.messageId)
    .map((child) => normalizeFetchedLarkMessageItem(child, fallbackMessageId));
  return children.length > 0 ? { ...parent, children } : parent;
}

function normalizeFetchedLarkMessageItem(item: Record<string, unknown>, fallbackMessageId: string): LarkFetchedMessage {
  const body = isRecord(item.body) ? item.body : undefined;
  const sender = isRecord(item.sender) ? item.sender : undefined;
  const messageId = typeof item.message_id === "string" ? item.message_id : fallbackMessageId;
  const messageType = typeof item.msg_type === "string"
    ? item.msg_type
    : typeof item.message_type === "string" ? item.message_type : undefined;
  const content = typeof body?.content === "string"
    ? body.content
    : typeof item.content === "string" ? item.content : undefined;
  const senderId = typeof sender?.id === "string"
    ? sender.id
    : typeof item.sender_id === "string" ? item.sender_id : undefined;
  const senderName = typeof sender?.name === "string"
    ? sender.name
    : typeof item.sender_name === "string" ? item.sender_name : undefined;
  const createTime = typeof item.create_time === "string"
    ? item.create_time
    : typeof item.createTime === "string" ? item.createTime : undefined;
  return {
    messageId,
    ...(messageType ? { messageType } : {}),
    ...(content ? { content } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(createTime ? { createTime } : {}),
  };
}

function replaceOrAppendLarkForwardedMessages(text: string, expanded: string): string {
  const block = `<forwarded_lark_messages>\n${expanded}\n</forwarded_lark_messages>`;
  if (/<forwarded_lark_messages>[\s\S]*?<\/forwarded_lark_messages>/.test(text)) {
    return text.replace(/<forwarded_lark_messages>[\s\S]*?<\/forwarded_lark_messages>/, block);
  }
  return [text, block].filter(Boolean).join("\n\n");
}

function summarizeLarkFetchedMessage(message: LarkFetchedMessage): string {
  const content = message.content?.trim();
  if (!content) {
    return "";
  }
  const parsed = parseJsonObject(content);
  const messageType = message.messageType;
  let text = "";
  if (parsed) {
    if (typeof parsed.text === "string") {
      text = parsed.text;
    } else if (typeof parsed.file_name === "string") {
      text = `[${messageType ?? "file"}: ${parsed.file_name}]`;
    } else if (messageType === "post") {
      text = extractPlainStrings(parsed).join("\n");
    } else if (messageType === "interactive") {
      text = extractLarkCardText(parsed);
    }
  }
  if (!text) {
    text = content;
  }
  return text.replace(/\s+\n/g, "\n").trim().slice(0, 2000);
}

function summarizeLarkMergedForward(message: LarkFetchedMessage): string {
  const children = message.children ?? [];
  if (children.length === 0) {
    return "";
  }
  return children
    .map((child, index) => {
      const text = summarizeLarkFetchedMessage(child);
      if (!text) {
        return "";
      }
      const sender = child.senderName ?? child.senderId ?? "unknown";
      return [
        `message ${index + 1}:`,
        `sender: ${sender}`,
        ...(child.messageType ? [`type: ${child.messageType}`] : []),
        text,
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPlainStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractPlainStrings);
  }
  if (!isRecord(value)) {
    return [];
  }
  const direct = ["title", "text", "href"]
    .flatMap((key) => typeof value[key] === "string" ? [String(value[key]).trim()] : [])
    .filter(Boolean);
  const nested = Object.entries(value)
    .filter(([key]) => !["title", "text", "href"].includes(key))
    .flatMap(([, child]) => extractPlainStrings(child));
  return [...direct, ...nested];
}

/**
 * Pull human-readable text out of a Feishu interactive-card JSON tree (header titles,
 * plain_text / lark_md / markdown content, button labels, form fields, nested
 * elements/columns/body) so a forwarded card's content is readable by the engine.
 * Mirrors the channel SDK's card walker; handles Card 1.0 and 2.0 shapes.
 */
function extractLarkCardText(node: unknown): string {
  const pieces: string[] = [];
  visitLarkCard(node, pieces);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of pieces) {
    const key = piece.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      lines.push(key);
    }
  }
  return lines.join("\n");
}

function visitLarkCard(node: unknown, out: string[]): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      visitLarkCard(child, out);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  const tag = obj.tag;
  if (typeof tag === "string" && (tag === "plain_text" || tag === "lark_md" || tag === "markdown")) {
    if (typeof obj.content === "string") {
      out.push(obj.content);
    }
    return;
  }
  if (isRecord(obj.header)) {
    visitLarkCard(obj.header.title, out);
  }
  if (obj.text) {
    visitLarkCard(obj.text, out);
  }
  if (obj.label) {
    visitLarkCard(obj.label, out);
  }
  if (obj.placeholder) {
    visitLarkCard(obj.placeholder, out);
  }
  if (Array.isArray(obj.options)) {
    for (const option of obj.options) {
      if (isRecord(option)) {
        visitLarkCard(option.text, out);
      }
    }
  }
  for (const key of ["elements", "fields", "actions", "columns"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const el of arr) {
        visitLarkCard(el, out);
      }
    }
  }
  if (obj.body) {
    visitLarkCard(obj.body, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTranscribableLarkMedia(downloaded: DownloadedLarkAttachment): boolean {
  return downloaded.attachment.kind === "audio" || downloaded.attachment.kind === "video";
}
