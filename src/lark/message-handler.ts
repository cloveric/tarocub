import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import type { ChatQueueWaitEvent } from "../runtime/chat-queue.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import { createDefaultTranscribeVoice } from "../telegram/message-input.js";
import { handleLarkCrewWorkflow } from "./bus.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkApprovalTextCommand, isLarkApprovalTextCommand, requestLarkApproval } from "./card-actions.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
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
import {
  renderLarkBackgroundTaskHeader,
  renderLarkChatAccessDenied,
  renderLarkConversationQueueWait,
  renderLarkMediaTranscriptionFailure,
  renderLarkQueuedTaskSkipped,
  renderLarkStopResult,
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
  if (message.chatMode) {
    runtime.chatModeCache.set(message.chatId, message.chatMode);
    return message;
  }
  if (message.chatType === "p2p") {
    return { ...message, chatMode: "p2p" };
  }

  const cached = runtime.chatModeCache.get(message.chatId);
  if (cached) {
    return { ...message, chatMode: cached };
  }

  const resolved = await resolveLarkChannelChatMode(channel, message.chatId);
  if (!resolved) {
    return { ...message, chatMode: message.threadId ? "topic" : "group" };
  }
  runtime.chatModeCache.set(message.chatId, resolved);
  return { ...message, chatMode: resolved };
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
        text: formatLarkAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(messageLocale)),
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
        text: formatLarkAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(messageLocale)),
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
      await sendLarkMarkdown(
        input.channel,
        normalized.chatId,
        renderLarkConversationQueueWait(messageLocale),
        larkReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
      );
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

  return await input.runtime.chatQueue.enqueue(normalized.conversationKey, async () => {
    return await runNormalizedLarkMessage(input, normalized);
  }, {
    waitNotifyAfterMs: 10_000,
    onWait: handleConversationQueueWait,
    onSkipped: async () => {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: {
          phase: "queue",
        },
      });
      await input.channel.send(normalized.chatId, { text: renderLarkQueuedTaskSkipped(messageLocale) }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
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
  const workspaceOverride = input.workspaceOverride ?? cfg.resume?.workspacePath;
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
    await input.channel.send(normalized.chatId, { text: formatLarkAccessReply(accessDecision.text ?? renderLarkChatAccessDenied(locale)) }, {
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

    try {
      const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
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
          instructions: larkAgentInstructions(),
        });
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
          text: result.text,
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
      await input.channel.send(normalized.chatId, {
        text: renderLarkUserFacingError(error, "engine", locale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "error",
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
