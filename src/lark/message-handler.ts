import { mkdir } from "node:fs/promises";
import path from "node:path";

import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { requestLarkApproval } from "./card-actions.js";
import {
  extractLarkMessageBody,
  formatLarkAccessReply,
  handleLarkSimpleCommand,
  isStopCommand,
} from "./commands.js";
import { deliverLarkResponse } from "./delivery.js";
import { renderLarkUserFacingError } from "./errors.js";
import {
  boundLarkArchiveSummary,
  downloadLarkAttachments,
  prepareLarkFileWorkflow,
  safeSegment,
  type DownloadedLarkAttachment,
} from "./files.js";
import {
  normalizeLarkMessage,
  type LarkIncomingMessage,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { verifyLarkNumericIds } from "./id-map.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike } from "./types.js";
import { appendLarkTimelineEvent } from "./timeline.js";

export async function handleLarkMessage(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  message: LarkIncomingMessage;
  requireMentionInGroup?: boolean;
  workspaceOverride?: string;
}): Promise<boolean> {
  const normalized = normalizeLarkMessage(input.message, {
    requireMentionInGroup: input.requireMentionInGroup,
  });
  if (!normalized) {
    return false;
  }
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
  if (isStopCommand(commandText)) {
    const active = input.runtime.activeRuns.get(normalized.conversationKey);
    active?.abortController.abort();
    const skippedQueued = input.runtime.chatQueue.clearPending(normalized.conversationKey);
    await input.channel.send(normalized.chatId, { text: active || skippedQueued ? "已停止。" : "当前没有正在运行的任务。" }, {
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

  return await input.runtime.chatQueue.enqueue(normalized.conversationKey, async () => {
    return await runNormalizedLarkMessage(input, normalized);
  }, {
    onSkipped: async () => {
      await input.channel.send(normalized.chatId, { text: "已跳过排队中的任务。" }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
}

async function runNormalizedLarkMessage(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    workspaceOverride?: string;
  },
  normalized: LarkNormalizedBridgeMessage,
): Promise<boolean> {
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale: "zh",
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await input.channel.send(normalized.chatId, { text: formatLarkAccessReply(accessDecision.text ?? "当前聊天未获授权。") }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "reply",
      detail: "access denied",
    });
    return true;
  }

  const commandText = extractLarkMessageBody(normalized.text);
  if (await handleLarkSimpleCommand({ ...input, requestApproval: requestLarkApproval }, normalized, commandText)) {
    return true;
  }

  const abortController = new AbortController();

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
    files = downloadedAttachments.map((attachment) => attachment.localPath);
    const workflowResult = await prepareLarkFileWorkflow({
      stateDir: input.stateDir,
      normalized,
      commandText,
      downloadedAttachments,
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
      await input.channel.send(normalized.chatId, { markdown: deliveryText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
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
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        phase: "prepare",
      },
    });
    await input.channel.send(normalized.chatId, {
      text: renderLarkUserFacingError(error, "prepare"),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    return true;
  }

  input.runtime.activeRuns.set(normalized.conversationKey, { abortController });
  try {
    const result = await input.bridge.handleAuthorizedMessage({
      chatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      text: requestText,
      conversationKey: normalized.conversationKey,
      files,
      requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      abortSignal: abortController.signal,
      onApprovalRequest: async (request) => await requestLarkApproval({
        channel: input.channel,
        runtime: input.runtime,
        chatId: normalized.chatId,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        replyTo: normalized.messageId,
        request,
        abortSignal: request.abortSignal ?? abortController.signal,
      }),
      instructions: larkAgentInstructions(),
    });
    await deliverLarkResponse({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      text: result.text,
      stateDir: input.stateDir,
      requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
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
  } catch (error) {
    await input.channel.send(normalized.chatId, {
      text: renderLarkUserFacingError(error, "engine"),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
    return true;
  } finally {
    input.runtime.activeRuns.delete(normalized.conversationKey);
  }
}
