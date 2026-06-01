import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommentEvent } from "@larksuiteoapi/node-sdk";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { extractCronAddTagMatches, stripCronAddTags } from "../telegram/cron-tags.js";
import { extractDeliveryTagMatches, stripDeliveryTags } from "../telegram/delivery-tags.js";
import type { Locale } from "../telegram/message-renderer.js";
import { extractTelegramToolTagMatches, parseTelegramToolTagPayload, stripTelegramToolTags } from "../telegram/tool-tags.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import type { LarkCommentContext, LarkCommentFileType } from "./comment-client.js";
import { parseLarkDocumentCreateInput } from "./document-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import { safeSegment } from "./files.js";
import { assertStableLarkIdMappings } from "./id-map.js";
import { larkOperatorRawId } from "./identity.js";
import { renderLarkBackgroundTaskHeader, renderLarkOperatorAccessDenied, resolveLarkLocale } from "./locale.js";
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
  const commentClient = input.runtime.commentClient;

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
    await createLarkCommentReply(commentClient, {
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
      text: accessDecision.text ?? renderLarkOperatorAccessDenied(locale),
    });
    return true;
  }

  return await input.runtime.chatQueue.enqueue(conversationKey, async () => {
    const context = await commentClient.getCommentContext({
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
    });
    const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.event.commentId));
    await mkdir(requestOutputDir, { recursive: true });
    const reactionReplyId = input.event.replyId ?? context.replies.at(-1)?.replyId;
    let reactionAdded = false;
    if (reactionReplyId) {
      reactionAdded = await commentClient.addReaction?.({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        replyId: reactionReplyId,
        reactionType: "Typing",
      }).then(() => true, () => false) ?? false;
    }

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

        if (event.type !== "task_notification" || event.settlesCurrentTurn) {
          return;
        }

        const notificationText = [
          renderLarkBackgroundTaskHeader(locale),
          event.text.trim(),
        ].filter(Boolean).join("\n");
        try {
          await createLarkCommentReply(commentClient, {
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
        text: buildLarkCommentPrompt(input.event, fileType, context, locale),
        locale,
        files: [],
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        instructions: larkAgentInstructions(),
        onEngineEvent: handleEngineEvent,
      });
      await recordBridgeTurnUsage(input.stateDir, result.usage, undefined);
      const cleaned = await renderLarkCommentReplyFromEngineText({
        rawText: result.text,
        runtime: input.runtime,
        locale,
      });
      await createLarkCommentReply(commentClient, {
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
      await createLarkCommentReply(commentClient, {
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
    } finally {
      if (reactionAdded && reactionReplyId) {
        await commentClient.removeReaction?.({
          fileToken: input.event.fileToken,
          fileType,
          commentId: input.event.commentId,
          replyId: reactionReplyId,
          reactionType: "Typing",
        }).catch(() => undefined);
      }
    }
  });
}

async function createLarkCommentReply(
  client: NonNullable<LarkServiceRuntime["commentClient"]>,
  input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
    text: string;
  },
): Promise<void> {
  try {
    await client.createReply(input);
  } catch (error) {
    if (larkCommentErrorCode(error) === 1069302 && client.createTopLevelComment) {
      await client.createTopLevelComment(input);
      return;
    }
    throw error;
  }
}

function larkCommentErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number") {
    return direct;
  }
  const nested = (error as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  return typeof nested === "number" ? nested : undefined;
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
  locale: Locale,
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
    renderLarkCommentPromptInstruction(locale),
    latestReply?.text
      ? renderLarkLatestCommentLine(latestReply.text, locale)
      : renderLarkMissingLatestCommentLine(locale),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderLarkCommentPromptInstruction(locale: Locale): string {
  return locale === "en"
    ? "You are replying in a Feishu/Lark document comment thread. Answer the user's comment directly; use lark-cli to read document context when needed."
    : "你正在飞书云文档评论线程里回复用户。请直接回答评论里的请求，必要时可用 lark-cli 读取文档上下文。";
}

function renderLarkLatestCommentLine(text: string, locale: Locale): string {
  return locale === "en" ? `User comment: ${text}` : `用户评论：${text}`;
}

function renderLarkMissingLatestCommentLine(locale: Locale): string {
  return locale === "en"
    ? "The user mentioned you in a document comment. Reply using the available context."
    : "用户在云文档评论中 @ 了你，请根据上下文回复。";
}

async function renderLarkCommentReplyFromEngineText(input: {
  rawText: string;
  runtime: LarkServiceRuntime;
  locale: Locale;
}): Promise<string> {
  const toolMatches = extractTelegramToolTagMatches(input.rawText);
  const cronMatches = extractCronAddTagMatches(input.rawText);
  const deliveryMatches = extractDeliveryTagMatches(input.rawText);
  const cleaned = stripCronAddTags(stripTelegramToolTags(stripDeliveryTags(input.rawText))).trim();
  const additions: string[] = [];
  let unsupportedSideEffect = cronMatches.length > 0 || deliveryMatches.length > 0;

  for (const match of toolMatches) {
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      if (parsed.name === "lark.doc.create" || parsed.name === "lark.doc") {
        const docInput = parseLarkDocumentCreateInput(payloadObject(parsed.payload));
        const created = await input.runtime.createDocument(docInput);
        additions.push(renderLarkCommentDocumentCreated(docInput.title, created.title, created.url ?? created.documentId, created.warning, input.locale));
        continue;
      }
      unsupportedSideEffect = true;
    } catch (error) {
      additions.push(renderLarkCommentToolError(error, input.locale));
    }
  }

  if (unsupportedSideEffect) {
    additions.push(renderLarkUnsupportedCommentToolNotice(input.locale));
  }

  return [cleaned, ...additions].filter(Boolean).join("\n\n") || renderLarkEmptyCommentReply(input.locale);
}

function renderLarkCommentDocumentCreated(
  requestedTitle: string | undefined,
  createdTitle: string | undefined,
  location: string | undefined,
  warning: string | undefined,
  locale: Locale,
): string {
  const label = createdTitle ?? requestedTitle ?? "飞书文档";
  const target = location ?? "(created)";
  const note = warning
    ? locale === "en"
      ? `\n\nNote: ${warning}`
      : `\n\n提示：${warning}`
    : "";
  return locale === "en"
    ? `Created ${label}:\n${target}${note}`
    : `已创建 ${label}：\n${target}${note}`;
}

function renderLarkUnsupportedCommentToolNotice(locale: Locale): string {
  return locale === "en"
    ? "Document comments cannot execute chat delivery or scheduled-task tools. Ask in a Lark chat/thread if you need files, cards, media, or reminders."
    : "云文档评论里不能执行聊天投递或定时任务工具。需要发文件、卡片、媒体或提醒时，请在 Lark 聊天/线程里操作。";
}

function renderLarkCommentToolError(error: unknown, locale: Locale): string {
  const detail = redactLarkErrorDetail(error);
  return locale === "en"
    ? `Comment tool was not executed: ${detail}`
    : `评论工具未执行：${detail}`;
}

function renderLarkEmptyCommentReply(locale: Locale): string {
  return locale === "en" ? "(empty reply)" : "（空回复）";
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}
