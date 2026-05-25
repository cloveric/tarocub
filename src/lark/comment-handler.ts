import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommentEvent } from "@larksuiteoapi/node-sdk";

import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { stripDeliveryTags } from "../telegram/delivery-tags.js";
import { stripTelegramToolTags } from "../telegram/tool-tags.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import type { LarkCommentContext, LarkCommentFileType } from "./comment-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import { safeSegment } from "./files.js";
import { assertStableLarkIdMappings } from "./id-map.js";
import { larkOperatorRawId } from "./identity.js";
import { stableLarkNumericId } from "./message-normalizer.js";
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
      locale: "zh",
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
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
      const result = await input.bridge.handleAuthorizedMessage({
        chatId: bridgeChatId,
        userId: bridgeUserId,
        chatType: "group",
        conversationKey,
        text: buildLarkCommentPrompt(input.event, fileType, context),
        files: [],
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        instructions: larkAgentInstructions(),
      });
      const cleaned = stripTelegramToolTags(stripDeliveryTags(result.text)).trim() || "（空回复）";
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: cleaned,
      });
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        channel: "lark",
        chatId: bridgeChatId,
        userId: bridgeUserId,
        conversationKey,
        outcome: "success",
        metadata: {
          larkSurface: "comment",
          fileToken: input.event.fileToken,
          fileType,
          commentId: input.event.commentId,
        },
      }, "Lark comment timeline event");
      return true;
    } catch (error) {
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: renderLarkUserFacingError(error, "engine"),
      });
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        channel: "lark",
        chatId: bridgeChatId,
        userId: bridgeUserId,
        conversationKey,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          larkSurface: "comment",
          fileToken: input.event.fileToken,
          fileType,
          commentId: input.event.commentId,
        },
      }, "Lark comment timeline event");
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
