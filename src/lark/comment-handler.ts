import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommentEvent } from "@larksuiteoapi/node-sdk";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { stripCronAddTags } from "../telegram/cron-tags.js";
import { stripDeliveryTags } from "../telegram/delivery-tags.js";
import { stripTelegramToolTags } from "../telegram/tool-tags.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import type { LarkCommentContext, LarkCommentFileType } from "./comment-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import { safeSegment } from "./files.js";
import { assertStableLarkIdMappings } from "./id-map.js";
import { larkOperatorRawId } from "./identity.js";
import { renderLarkBackgroundTaskHeader, resolveLarkLocale } from "./locale.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike } from "./types.js";

export async function handleLarkComment(input: {
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  event: CommentEvent;
  workspaceOverride?: string;
}): Promise<boolean> {
  if (!input.event.mentionedBot) {
    return false;
  }
  if (!input.runtime.commentClient) {
    throw new Error("Lark comment client is not configured");
  }

  const fileType = normalizeLarkCommentFileType(input.event.fileType);
  const operatorRawId = larkOperatorRawId(input.event.operator);
  const conversationKey = `lark-comment:${input.event.fileToken}`;
  const bridgeChatId = stableLarkNumericId(conversationKey);
  const bridgeUserId = stableLarkNumericId(`user:${operatorRawId}`);
  const locale = await resolveLarkLocale(input.stateDir);
  await assertStableLarkIdMappings(input.stateDir, [
    ["chat", bridgeChatId, conversationKey],
    ["user", bridgeUserId, operatorRawId],
  ]);

  const accessDecision = input.bridge.checkUserAuthorization
    ? await input.bridge.checkUserAuthorization({
      chatId: bridgeChatId,
      userId: bridgeUserId,
      chatType: "group",
      conversationKey,
      locale,
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await appendLarkCommentTimelineEvent(input.stateDir, {
      type: "turn.completed",
      bridgeChatId,
      bridgeUserId,
      conversationKey,
      outcome: "denied",
      detail: "access denied",
      event: input.event,
      fileType,
    });
    await input.runtime.commentClient.createReply({
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
      text: accessDecision.text ?? "当前操作者未获授权。",
    });
    return true;
  }

  return await input.runtime.chatQueue.enqueue(conversationKey, async () => {
    const context = await input.runtime.commentClient!.getCommentContext({
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
    });
    const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.event.commentId));
    await mkdir(requestOutputDir, { recursive: true });
    try {
      await appendLarkCommentTimelineEvent(input.stateDir, {
        type: "turn.started",
        bridgeChatId,
        bridgeUserId,
        conversationKey,
        event: input.event,
        fileType,
      });
      const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
        await appendLarkCommentTimelineEvent(input.stateDir, {
          type: "engine.event",
          bridgeChatId,
          bridgeUserId,
          conversationKey,
          detail: event.type,
          event: input.event,
          fileType,
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
          await input.runtime.commentClient!.createReply({
            fileToken: input.event.fileToken,
            fileType,
            commentId: input.event.commentId,
            text: notificationText,
          });
        } catch (error) {
          await appendLarkCommentTimelineEvent(input.stateDir, {
            type: "engine.event.delivery_failed",
            bridgeChatId,
            bridgeUserId,
            conversationKey,
            outcome: "error",
            detail: redactLarkErrorDetail(error),
            event: input.event,
            fileType,
            metadata: {
              eventType: event.type,
            },
          });
        }
      };
      const result = await input.bridge.handleAuthorizedMessage({
        chatId: bridgeChatId,
        userId: bridgeUserId,
        chatType: "group",
        conversationKey,
        text: buildLarkCommentPrompt(input.event, fileType, context),
        locale,
        files: [],
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        instructions: larkAgentInstructions(),
        onEngineEvent: handleEngineEvent,
      });
      const cleaned = stripCronAddTags(stripTelegramToolTags(stripDeliveryTags(result.text))).trim() || "（空回复）";
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: cleaned,
      });
      await appendLarkCommentTimelineEvent(input.stateDir, {
        type: "turn.completed",
        bridgeChatId,
        bridgeUserId,
        conversationKey,
        outcome: "success",
        event: input.event,
        fileType,
      });
      return true;
    } catch (error) {
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: renderLarkUserFacingError(error, "engine", locale),
      });
      await appendLarkCommentTimelineEvent(input.stateDir, {
        type: "turn.completed",
        bridgeChatId,
        bridgeUserId,
        conversationKey,
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        event: input.event,
        fileType,
      });
      return true;
    }
  });
}

export function normalizeLarkCommentFileType(value: string): LarkCommentFileType {
  switch (value) {
    case "doc":
    case "docx":
    case "sheet":
    case "file":
    case "slides":
    case "bitable":
      return value;
    default:
      return "file";
  }
}

async function appendLarkCommentTimelineEvent(
  stateDir: string,
  input: {
    type: "turn.started" | "turn.completed" | "engine.event" | "engine.event.delivery_failed";
    bridgeChatId: number;
    bridgeUserId: number;
    conversationKey: string;
    outcome?: string;
    detail?: string;
    event: CommentEvent;
    fileType: LarkCommentFileType;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(stateDir, {
    type: input.type,
    channel: "lark",
    chatId: input.bridgeChatId,
    userId: input.bridgeUserId,
    conversationKey: input.conversationKey,
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      larkSurface: "comment",
      fileToken: input.event.fileToken,
      fileType: input.fileType,
      commentId: input.event.commentId,
      ...input.metadata,
    },
  }, "Lark comment timeline event");
}

function buildLarkCommentPrompt(
  event: CommentEvent,
  fileType: LarkCommentFileType,
  context: LarkCommentContext,
): string {
  const latestReply = context.replies.at(-1);
  const replies = context.replies
    .map((reply, index) => [
      `reply_${index + 1}:`,
      reply.replyId ? `  reply_id: ${reply.replyId}` : undefined,
      reply.userId ? `  user_id: ${reply.userId}` : undefined,
      `  text: ${reply.text || "(empty)"}`,
      reply.docsLinks.length > 0 ? `  docs_links: ${reply.docsLinks.join(", ")}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n"))
    .join("\n");

  return [
    "<lark_comment_context>",
    `file_token: ${event.fileToken}`,
    `file_type: ${fileType}`,
    `comment_id: ${event.commentId}`,
    event.replyId ? `reply_id: ${event.replyId}` : undefined,
    `operator_id: ${larkOperatorRawId(event.operator)}`,
    `mentioned_bot: ${event.mentionedBot}`,
    context.quote ? `selected_quote: ${context.quote}` : "selected_quote: (none)",
    replies ? "comment_replies:" : "comment_replies: (none)",
    replies || undefined,
    "</lark_comment_context>",
    "",
    "你正在飞书云文档评论线程里回复用户。请直接回答评论里的请求，必要时可用 lark-cli 读取文档上下文。",
    latestReply?.text ? `用户评论：${latestReply.text}` : "用户在云文档评论中 @ 了你，请根据上下文回复。",
  ].filter((line): line is string => line !== undefined).join("\n");
}
