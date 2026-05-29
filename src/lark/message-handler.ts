import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import type { ChatQueueWaitEvent } from "../runtime/chat-queue.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import type { TurnPoolWaitEvent } from "../runtime/turn-pool.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../telegram/instance-config.js";
import { createDefaultTranscribeVoice } from "../telegram/message-input.js";
import { handleLarkCrewWorkflow } from "./bus.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkApprovalTextCommand, isLarkApprovalTextCommand, requestLarkApproval } from "./card-actions.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import {
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkQueueWaitCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
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

  const message = await resolveLarkMessageChatMode(input.channel, input.runtime, input.stateDir, input.message);
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
  stateDir: string,
  message: LarkIncomingMessage,
): Promise<LarkIncomingMessage> {
  if (message.chatMode) {
    runtime.chatModeCache.set(message.chatId, message.chatMode);
    return await preserveExistingLarkThreadSession(stateDir, message, message.chatMode);
  }
  if (message.chatType === "p2p") {
    return { ...message, chatMode: "p2p" };
  }

  const cached = runtime.chatModeCache.get(message.chatId);
  if (cached) {
    return await preserveExistingLarkThreadSession(stateDir, message, cached);
  }

  const resolved = await resolveLarkChannelChatMode(channel, message.chatId);
  if (!resolved) {
    return { ...message, chatMode: message.threadId ? "topic" : "group" };
  }
  runtime.chatModeCache.set(message.chatId, resolved);
  return await preserveExistingLarkThreadSession(stateDir, message, resolved);
}

async function preserveExistingLarkThreadSession(
  stateDir: string,
  message: LarkIncomingMessage,
  chatMode: LarkChatMode,
): Promise<LarkIncomingMessage> {
  if (chatMode !== "group" || !message.threadId || message.chatType === "p2p") {
    return { ...message, chatMode };
  }

  const threadConversationKey = buildLarkConversationKey(message.chatId, message.threadId);
  const existingSession = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(threadConversationKey);
  return existingSession.record
    ? { ...message, chatMode: "topic" }
    : { ...message, chatMode };
}

async function resolveLarkChannelChatMode(
  channel: LarkChannelLike,
  chatId: string,
): Promise<LarkChatMode | undefined> {
  if (!channel.getChatMode) {
    return undefined;
  }
  try {
    const mode = await channel.getChatMode(chatId);
    return isLarkChatMode(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

function isLarkChatMode(value: unknown): value is LarkChatMode {
  return value === "p2p" || value === "group" || value === "topic";
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
    const active = input.runtime.activeRuns.get(normalized.conversationKey);
    active?.abortController.abort();
    const skippedQueued = input.runtime.chatQueue.clearPending(normalized.conversationKey);
    await input.channel.send(normalized.chatId, { text: renderLarkStopResult(Boolean(active || skippedQueued), messageLocale) }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: active || skippedQueued ? "success" : "noop",
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
        waitedMs: event.waitedMs,
        replyInThread: Boolean(normalized.threadId),
        locale: messageLocale,
      });
      // Reuse a single card across repeated wait notifications, and remember its
      // id so the run card can take it over (queued → running → done) instead of
      // leaving a stale "queued" card behind once the task starts.
      const existing = input.runtime.queueCards.get(normalized.conversationKey);
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
        input.runtime.queueCards.set(normalized.conversationKey, sent.messageId);
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
    waitNotifyAfterMs: 10_000,
    onWait,
    onSkipped: async () => {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: {
          phase: "queue",
        },
      });
      // A skipped turn must not leave its "queued" card spinning forever.
      const queuedCardId = input.runtime.queueCards.get(normalized.conversationKey);
      input.runtime.queueCards.delete(normalized.conversationKey);
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
      const queuedCardId = input.runtime.queueCards.get(normalized.conversationKey);
      input.runtime.queueCards.delete(normalized.conversationKey);
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
        await runCard?.finish(result.text);
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
          text: result.text,
          // The run card is the single canonical reply: it renders the full
          // answer in its block stream. Only fall back to a separate markdown
          // message when the card failed to create (runCard undefined).
          // deliverLarkResponse still processes tool tags / files / images.
          sendText: runCard === undefined,
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
  finish(text: string): Promise<void>;
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
  // Terminal update: guarantee the card leaves the "running" state and the
  // answer is not lost. Try the full card, then the compact card, and as a
  // last resort deliver the text directly so a failed patch never swallows it.
  const finalize = async (text?: string): Promise<void> => {
    if (!degraded && await tryUpdate(renderLarkRunCard(state, input.locale))) {
      return;
    }
    degraded = true;
    if (await tryUpdate(renderLarkRunCardCompact(state, input.locale))) {
      return;
    }
    if (text && text.trim()) {
      await input.channel.send(
        input.chatId,
        { text },
        larkReplyOptions(input.replyTo, input.replyInThread),
      ).catch(() => undefined);
    }
  };
  return {
    apply: async (event) => {
      state = applyLarkEngineEvent(state, event);
      await update().catch(() => undefined);
    },
    finish: async (text) => {
      // Reuse the reducer so non-streaming engines (which emit no incremental
      // assistant_text) still get the final answer seeded into the block stream.
      state = applyLarkEngineEvent(state, { type: "result", text });
      await finalize(text);
    },
    fail: async (text) => {
      state = {
        ...state,
        status: "error",
        errorText: text,
        footer: null,
      };
      await finalize();
    },
    interrupt: async () => {
      state = { ...state, status: "interrupted", footer: null };
      await finalize();
    },
    idleTimeout: async (minutes) => {
      state = { ...state, status: "idle_timeout", idleTimeoutMinutes: minutes, footer: null };
      await finalize();
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
