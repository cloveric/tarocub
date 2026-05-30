import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
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
  LARK_CARD_ANSWER_MAX,
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkQueueWaitCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
  renderLarkRunCardMinimal,
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
import { redactLarkErrorDetail } from "./redaction.js";
import { verifyLarkNumericIds } from "./id-map.js";
import type { LarkServiceRuntime } from "./runtime.js";
import { type LarkReactionSettings, withLarkMessageReactions } from "./reactions.js";
import type { LarkBridgeLike, LarkChannelLike, LarkFetchedMessage, LarkSendOptions } from "./types.js";
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

type LarkTurnTermination =
  | { kind: "interrupted" }
  | { kind: "idle_timeout"; minutes: number }
  | { kind: "error" };

/**
 * Classify why an engine turn ended in error so the run card can show the
 * right terminal marker: user/stop interruption, an idle-timeout auto-stop
 * (the adapter kills a turn that goes silent for N minutes), or a real error.
 */
function classifyLarkTurnTermination(error: unknown, signal: AbortSignal | undefined): LarkTurnTermination {
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
  const normalized = await enrichLarkReplyContext(input.channel, expandedNormalized);
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
    await input.channel.send(normalized.chatId, { text: renderLarkStopResult(Boolean(active), messageLocale) }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
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
      // Reuse a single card across repeated wait notifications, and remember its
      // id so the run card can take it over (queued → running → done) instead of
      // leaving a stale "queued" card behind once the task starts.
      const existing = input.runtime.queueCards.get(normalized.messageId);
      if (existing && input.channel.updateCard) {
        try {
          await input.channel.updateCard(existing, card);
          return;
        } catch {
          // fall through to sending a fresh card
        }
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
        input.runtime.queueCards.set(normalized.messageId, sent.messageId);
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
      const queuedCardId = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      const skippedText = renderLarkQueuedTaskSkipped(locale);
      if (queuedCardId && input.channel.updateCard) {
        try {
          await input.channel.updateCard(queuedCardId, {
            schema: "2.0",
            config: { update_multi: true },
            body: {
              direction: "vertical",
              padding: "12px 12px 12px 12px",
              elements: [{ tag: "markdown", content: skippedText }],
            },
          });
          return true;
        } catch {
          // fall through to a plain-text notice
        }
      }
      await input.channel.send(normalized.chatId, { text: skippedText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
}

function shouldBatchLarkMessage(
  runtime: LarkServiceRuntime,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): boolean {
  return runtime.queuePolicy.batchWindowMs > 0 &&
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

    let runCard: LarkRunCardController | undefined;
    try {
      // If a "queued" card was already shown for this conversation, take it over
      // as the run card so it transitions in place instead of being orphaned.
      const queuedCardId = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      runCard = await createLarkRunCardController({
        channel: input.channel,
        chatId: normalized.chatId,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
        locale,
        ...(queuedCardId ? { existingMessageId: queuedCardId } : {}),
      });
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

        if (event.type !== "task_notification") {
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
        const answerShownInCard = (await runCard?.finish(result.text)) ?? false;
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
          text: result.text,
          // The run card is normally the single canonical reply. Send a separate
          // markdown message only when there is no card, OR when the answer was
          // too long to show in the card (truncated / tiny-terminal fallback) so
          // the full text is never lost. deliverLarkResponse still processes tool
          // tags / files / images regardless.
          sendText: runCard === undefined || !answerShownInCard,
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
      input.runtime.activeRuns.delete(normalized.conversationKey);
    }
    await cleanupLarkMessageArtifacts(input.stateDir, normalized.messageId).catch(() => undefined);
  }
}

interface LarkRunCardController {
  apply(event: EngineStreamEvent): Promise<void>;
  /** Finalize with the answer; resolves to whether the answer is fully shown in the card. */
  finish(text: string): Promise<boolean>;
  fail(text: string): Promise<void>;
  interrupt(): Promise<void>;
  idleTimeout(minutes: number): Promise<void>;
}

async function createLarkRunCardController(input: {
  channel: LarkChannelLike;
  chatId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyTo: string;
  replyInThread: boolean;
  locale: "zh" | "en";
  /** Reuse an existing card (e.g. the "queued" card) instead of sending a new one. */
  existingMessageId?: string;
}): Promise<LarkRunCardController | undefined> {
  if (!input.channel.updateCard) {
    return undefined;
  }
  let state: LarkRunState = initialLarkRunState(input.conversationKey, input.bridgeChatType);
  let sent: { messageId: string; fallback: boolean };
  if (input.existingMessageId) {
    // Take over the queued card: turn it into the run card in place.
    try {
      await input.channel.updateCard(input.existingMessageId, renderLarkRunCard(state, input.locale));
      sent = { messageId: input.existingMessageId, fallback: false };
    } catch {
      sent = { messageId: input.existingMessageId, fallback: true };
    }
  } else {
    sent = { messageId: "", fallback: true };
  }
  if (sent.fallback) {
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
  if (sent.fallback) {
    return undefined;
  }
  // Once the full card is too large for Feishu's patch limit, every update
  // fails; switch to the compact render so live progress (and finalization)
  // keep landing instead of freezing the card in its "running" state.
  let degraded = false;
  const tryUpdate = async (card: Record<string, unknown>): Promise<boolean> => {
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
    const answerFitsCard = !text || text.length <= LARK_CARD_ANSWER_MAX;
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
              params: { user_id_type: "open_id" };
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
    params: { user_id_type: "open_id" },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTranscribableLarkMedia(downloaded: DownloadedLarkAttachment): boolean {
  return downloaded.attachment.kind === "audio" || downloaded.attachment.kind === "video";
}
