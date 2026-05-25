import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import {
  extractDeliveryTagMatches,
  stripDeliveryTags,
} from "../telegram/delivery-tags.js";
import {
  extractCronAddTagMatches,
  stripCronAddTags,
} from "../telegram/cron-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
  stripTelegramToolTags,
} from "../telegram/tool-tags.js";
import type { Locale } from "../telegram/message-renderer.js";
import { executeCronAddTool } from "../tools/cron-add-tool.js";
import { parseLarkDocumentCreateInput } from "./document-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import { resolveLarkLocale } from "./locale.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

type LarkSendPathKind = "file" | "image" | "audio" | "video";
type LarkFileRejectReason = "outside-workspace" | "not-found" | "permission-denied" | "read-error";
const LARK_MARKDOWN_CHUNK_LIMIT = 3500;

export async function deliverLarkResponse(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  text: string;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  bridgeChatId?: number;
  bridgeUserId?: number;
  larkThreadId?: string;
  larkMessageId?: string;
  sendText?: boolean;
  allowAnyAbsolutePath?: boolean;
}): Promise<void> {
  const wholeFileBlock = extractWholeResponseFileBlock(input.text);
  if (wholeFileBlock) {
    await input.channel.send(input.chatId, {
      file: {
        source: Buffer.from(wholeFileBlock.body, "utf8"),
        fileName: wholeFileBlock.fileName,
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkFileAcceptedTimeline(input, {
      fileName: wholeFileBlock.fileName,
      bytes: Buffer.byteLength(wholeFileBlock.body, "utf8"),
      kind: "file",
    });
    return;
  }

  const toolMatches = extractTelegramToolTagMatches(input.text);
  const cronAddMatches = extractCronAddTagMatches(input.text);
  const matches = extractDeliveryTagMatches(input.text);
  const cleanedText = stripCronAddTags(stripTelegramToolTags(stripDeliveryTags(input.text)));
  const replyOptions = larkReplyOptions(input.replyTo, input.replyInThread);
  const locale = await resolveLarkLocale(input.stateDir);
  let hadRejectedTool = false;

  for (const match of toolMatches) {
    let toolName = "unknown";
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      toolName = parsed.name;
      const ok = await executeLarkToolTag({
        ...input,
        name: parsed.name,
        payload: parsed.payload,
        locale,
      });
      if (!ok) {
        hadRejectedTool = true;
      }
    } catch (error) {
      hadRejectedTool = true;
      if (!(error instanceof SyntaxError)) {
        await appendLarkToolErrorTimeline(input, toolName, error);
      }
      await input.channel.send(input.chatId, {
        text: renderLarkToolTagParseError(error, locale),
      }, replyOptions);
    }
  }

  for (const match of cronAddMatches) {
    try {
      const ok = await executeLarkToolTag({
        ...input,
        name: "cron.add",
        payload: match.payload,
        locale,
      });
      if (!ok) {
        hadRejectedTool = true;
      }
    } catch (error) {
      hadRejectedTool = true;
      await input.channel.send(input.chatId, {
        text: renderLarkUserFacingError(error, "tool", locale),
      }, replyOptions);
    }
  }

  if (matches.length > 0) {
    const workspaceRoot = await realpath(path.join(input.stateDir, "workspace"))
      .catch(() => path.join(input.stateDir, "workspace"));
    const outputRoot = input.requestOutputDir
      ? await realpath(input.requestOutputDir).catch(() => input.requestOutputDir)
      : undefined;
    const overrideRoot = input.workspaceOverride
      ? await realpath(input.workspaceOverride).catch(() => input.workspaceOverride)
      : undefined;
    const workspacePrefix = workspaceRoot + path.sep;
    const outputPrefix = outputRoot ? `${outputRoot}${path.sep}` : undefined;
    const overridePrefix = overrideRoot ? `${overrideRoot}${path.sep}` : undefined;

    for (const match of matches) {
      const filePath = match.path;
      try {
        const real = await realpath(filePath);
        if (
          !input.allowAnyAbsolutePath &&
          !real.startsWith(workspacePrefix) &&
          !(outputPrefix && real.startsWith(outputPrefix)) &&
          !(overridePrefix && real.startsWith(overridePrefix))
        ) {
          hadRejectedTool = true;
          await appendLarkFileRejectedTimeline(input, {
            path: filePath,
            realPath: real,
            reason: "outside-workspace",
            kind: match.preferPhoto ? "image" : "file",
          });
          await input.channel.send(input.chatId, { text: renderLarkFileDeliveryError("outside-workspace", locale) }, replyOptions);
          continue;
        }
        const body = await readFile(real);
        if (match.preferPhoto) {
          await input.channel.send(input.chatId, { image: { source: body } }, replyOptions);
        } else {
          await input.channel.send(input.chatId, {
            file: {
              source: body,
              fileName: path.basename(real),
            },
          }, replyOptions);
        }
        await appendLarkFileAcceptedTimeline(input, {
          fileName: path.basename(real),
          bytes: body.length,
          kind: match.preferPhoto ? "image" : "file",
        });
      } catch (error) {
        hadRejectedTool = true;
        await appendLarkFileRejectedTimeline(input, {
          path: filePath,
          reason: larkFileRejectReasonFromError(error),
          detail: errorDetail(error),
          kind: match.preferPhoto ? "image" : "file",
        });
        await input.channel.send(input.chatId, {
          text: renderLarkFileDeliveryError("read-error", locale),
        }, replyOptions);
      }
    }
  }

  if (input.sendText !== false && cleanedText && !hadRejectedTool) {
    await sendLarkMarkdown(input.channel, input.chatId, cleanedText, replyOptions);
  }

  if (matches.length === 0) {
    return;
  }
}

export async function sendLarkMarkdown(
  channel: LarkChannelLike,
  chatId: string,
  markdown: string,
  options: LarkSendOptions | undefined,
): Promise<void> {
  for (const chunk of chunkLarkMarkdown(markdown)) {
    await channel.send(chatId, { markdown: chunk }, options);
  }
}

function chunkLarkMarkdown(markdown: string): string[] {
  if (markdown.length <= LARK_MARKDOWN_CHUNK_LIMIT) {
    return [markdown];
  }

  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining.length > LARK_MARKDOWN_CHUNK_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n\n", LARK_MARKDOWN_CHUNK_LIMIT);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", LARK_MARKDOWN_CHUNK_LIMIT);
    }
    if (splitAt <= 0) {
      splitAt = LARK_MARKDOWN_CHUNK_LIMIT;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function extractWholeResponseFileBlock(text: string): { fileName: string; body: string } | null {
  const fileMatch = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/);
  if (!fileMatch || text.replace(fileMatch[0], "").trim().length > 0) {
    return null;
  }
  const fileName = path.basename((fileMatch[1] ?? "").trim());
  const body = fileMatch[2] ?? "";
  if (!fileName || Buffer.byteLength(body, "utf8") === 0) {
    return null;
  }
  return { fileName, body };
}

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }

  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
}

function renderLarkToolTagParseError(error: unknown, locale: Locale): string {
  if (error instanceof SyntaxError) {
    return locale === "en"
      ? "Invalid tool tag JSON; nothing was executed. For batch files or long text, use a fenced tool-call code block."
      : "错误：tool tag JSON 格式无效，未执行。批量文件或长文本请改用 fenced tool-call 代码块。";
  }
  return renderLarkUserFacingError(error, "tool", locale);
}

async function appendLarkToolErrorTimeline(
  input: Parameters<typeof deliverLarkResponse>[0],
  toolName: string,
  error: unknown,
): Promise<void> {
  await appendTimelineEventBestEffort(input.stateDir, {
    type: "service.error",
    channel: "lark",
    chatId: input.bridgeChatId,
    userId: input.bridgeUserId,
    conversationKey: input.conversationKey,
    outcome: "error",
    detail: redactLarkErrorDetail(error),
    metadata: {
      phase: "tool",
      tool: toolName,
      larkChatId: input.chatId,
      larkMessageId: input.larkMessageId ?? input.replyTo,
      bridgeChatType: input.bridgeChatType,
    },
  }, "Lark tool error timeline event");
}

async function executeLarkToolTag(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  name: string;
  payload: unknown;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  bridgeChatId?: number;
  bridgeUserId?: number;
  larkThreadId?: string;
  larkMessageId?: string;
  locale: Locale;
}): Promise<boolean> {
  const payload = payloadObject(input.payload);
  if (input.name === "cron.add") {
    const result = await executeCronAddTool(input.payload, {
      cronRuntime: input.runtime.cronRuntime ?? null,
      stateDir: input.stateDir,
      channel: "lark",
      chatId: input.bridgeChatId ?? stableLarkNumericId(input.conversationKey ?? `lark:${input.chatId}`),
      userId: input.bridgeUserId ?? stableLarkNumericId(`user:${input.conversationKey ?? input.chatId}`),
      chatType: input.bridgeChatType ?? "private",
      conversationKey: input.conversationKey,
      larkChatId: input.chatId,
      larkThreadId: input.larkThreadId,
      larkMessageId: input.larkMessageId ?? input.replyTo,
      locale: input.locale,
      instanceName: "lark",
    });
    await sendLarkMarkdown(input.channel, input.chatId, result.message, larkReplyOptions(input.replyTo, input.replyInThread));
    return result.ok;
  }

  if (
    input.name === "send.file" ||
    input.name === "send.image" ||
    input.name === "send.audio" ||
    input.name === "send.video"
  ) {
    if (typeof payload?.path !== "string" || payload.path.trim() === "") {
      await input.channel.send(input.chatId, {
        text: renderInvalidLarkToolPayload(input.name, "requires_path", input.locale),
      }, larkReplyOptions(input.replyTo, input.replyInThread));
      return false;
    }
    return await sendLarkPath({
      ...input,
      filePath: payload.path,
      kind: input.name.slice("send.".length) as LarkSendPathKind,
    });
  }

  if (input.name === "send.batch") {
    let ok = true;
    const invalidField = invalidStringArrayField(payload, ["images", "files", "audios", "videos"]);
    if (invalidField) {
      await input.channel.send(input.chatId, {
        text: renderInvalidLarkToolPayload("send.batch", "string_array", input.locale, invalidField),
      }, larkReplyOptions(input.replyTo, input.replyInThread));
      return false;
    }
    const message = typeof payload?.message === "string" ? payload.message : "";
    for (const image of stringArray(payload?.images)) {
      ok = await sendLarkPath({ ...input, filePath: image, kind: "image" }) && ok;
    }
    for (const file of stringArray(payload?.files)) {
      ok = await sendLarkPath({ ...input, filePath: file, kind: "file" }) && ok;
    }
    for (const audio of stringArray(payload?.audios)) {
      ok = await sendLarkPath({ ...input, filePath: audio, kind: "audio" }) && ok;
    }
    for (const video of stringArray(payload?.videos)) {
      ok = await sendLarkPath({ ...input, filePath: video, kind: "video" }) && ok;
    }
    if (ok && message.trim()) {
      await sendLarkMarkdown(input.channel, input.chatId, message.trim(), larkReplyOptions(input.replyTo, input.replyInThread));
    }
    return ok;
  }

  if (input.name === "lark.post" || input.name === "send.post") {
    const post = payload?.post ?? payload;
    if (!post || typeof post !== "object" || Array.isArray(post)) {
      throw new Error(`${input.name} requires an object payload`);
    }
    await input.channel.send(input.chatId, { post }, larkReplyOptions(input.replyTo, input.replyInThread));
    return true;
  }

  if (input.name === "lark.card" || input.name === "send.card") {
    const card = buildLarkToolCard(payload, input.conversationKey, input.bridgeChatType, input.replyInThread);
    await input.channel.send(input.chatId, { card }, larkReplyOptions(input.replyTo, input.replyInThread));
    return true;
  }

  if (input.name === "lark.doc.create" || input.name === "lark.doc") {
    const docInput = parseLarkDocumentCreateInput(payload);
    const created = await input.runtime.createDocument(docInput);
    const label = created.title ?? docInput.title ?? "飞书文档";
    const location = created.url ?? created.documentId ?? "(created)";
    await sendLarkMarkdown(input.channel, input.chatId, input.locale === "en"
      ? `Created ${label}:\n${location}`
      : `已创建 ${label}：\n${location}`, larkReplyOptions(input.replyTo, input.replyInThread));
    return true;
  }
  await input.channel.send(input.chatId, {
    text: input.locale === "en" ? `Unsupported Lark tool ${input.name}.` : `错误：不支持的飞书工具 ${input.name}。`,
  }, larkReplyOptions(input.replyTo, input.replyInThread));
  return false;
}

function renderInvalidLarkToolPayload(
  toolName: string,
  reason: "requires_path" | "string_array",
  locale: Locale,
  field?: string,
): string {
  if (locale === "en") {
    if (reason === "requires_path") {
      return `Invalid Lark tool payload: ${toolName} requires payload.path.`;
    }
    return `Invalid Lark tool payload: ${toolName} ${field ?? "field"} must be an array of strings.`;
  }
  if (reason === "requires_path") {
    return `错误：飞书工具参数无效：${toolName} 需要 payload.path。`;
  }
  return `错误：飞书工具参数无效：${toolName} ${field ?? "字段"} 必须是字符串数组。`;
}

async function sendLarkPath(input: {
  channel: LarkChannelLike;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  filePath: string;
  kind: LarkSendPathKind;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  conversationKey?: string;
  bridgeChatId?: number;
  bridgeUserId?: number;
  bridgeChatType?: "private" | "group";
  larkMessageId?: string;
  locale: Locale;
}): Promise<boolean> {
  const workspaceRoot = await realpath(path.join(input.stateDir, "workspace"))
    .catch(() => path.join(input.stateDir, "workspace"));
  const outputRoot = input.requestOutputDir
    ? await realpath(input.requestOutputDir).catch(() => input.requestOutputDir)
    : undefined;
  const overrideRoot = input.workspaceOverride
    ? await realpath(input.workspaceOverride).catch(() => input.workspaceOverride)
    : undefined;
  const prefixes = [
    workspaceRoot + path.sep,
    ...(outputRoot ? [outputRoot + path.sep] : []),
    ...(overrideRoot ? [overrideRoot + path.sep] : []),
  ];
  let real: string;
  try {
    real = await realpath(input.filePath);
  } catch (error) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.filePath,
      reason: larkFileRejectReasonFromError(error),
      detail: errorDetail(error),
      kind: input.kind,
    });
    await input.channel.send(input.chatId, {
      text: renderLarkFileDeliveryError("read-error", input.locale),
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return false;
  }
  if (!prefixes.some((prefix) => real.startsWith(prefix))) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.filePath,
      realPath: real,
      reason: "outside-workspace",
      kind: input.kind,
    });
    await input.channel.send(input.chatId, { text: renderLarkFileDeliveryError("outside-workspace", input.locale) }, larkReplyOptions(input.replyTo, input.replyInThread));
    return false;
  }
  let body: Buffer;
  try {
    body = await readFile(real);
  } catch (error) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.filePath,
      realPath: real,
      reason: larkFileRejectReasonFromError(error),
      detail: errorDetail(error),
      kind: input.kind,
    });
    await input.channel.send(input.chatId, {
      text: renderLarkFileDeliveryError("read-error", input.locale),
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return false;
  }
  if (input.kind === "image") {
    await input.channel.send(input.chatId, { image: { source: body } }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkFileAcceptedTimeline(input, {
      fileName: path.basename(real),
      bytes: body.length,
      kind: input.kind,
    });
    return true;
  }
  if (input.kind === "audio") {
    await input.channel.send(input.chatId, {
      audio: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkFileAcceptedTimeline(input, {
      fileName: path.basename(real),
      bytes: body.length,
      kind: input.kind,
    });
    return true;
  }
  if (input.kind === "video") {
    await input.channel.send(input.chatId, {
      video: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkFileAcceptedTimeline(input, {
      fileName: path.basename(real),
      bytes: body.length,
      kind: input.kind,
    });
    return true;
  }
  await input.channel.send(input.chatId, {
    file: {
      source: body,
      fileName: path.basename(real),
    },
  }, larkReplyOptions(input.replyTo, input.replyInThread));
  await appendLarkFileAcceptedTimeline(input, {
    fileName: path.basename(real),
    bytes: body.length,
    kind: input.kind,
  });
  return true;
}

function renderLarkFileDeliveryError(reason: "outside-workspace" | "read-error", locale: Locale): string {
  if (locale === "en") {
    return reason === "outside-workspace"
      ? "File was not sent: the path is outside the allowed directories."
      : "File was not sent: failed to read the file; details were recorded in logs.";
  }
  return reason === "outside-workspace"
    ? "文件未发送：路径不在允许目录内。"
    : "文件未发送：读取文件失败，详细原因已记录到日志。";
}

async function appendLarkFileAcceptedTimeline(
  input: {
    stateDir: string;
    chatId: string;
    conversationKey?: string;
    bridgeChatId?: number;
    bridgeUserId?: number;
    bridgeChatType?: "private" | "group";
    larkMessageId?: string;
    replyTo?: string;
  },
  file: {
    fileName: string;
    bytes: number;
    kind: LarkSendPathKind;
  },
): Promise<void> {
  const conversationKey = input.conversationKey ?? `lark:${input.chatId}`;
  await appendTimelineEventBestEffort(input.stateDir, {
    type: "file.accepted",
    channel: "lark",
    chatId: input.bridgeChatId ?? stableLarkNumericId(conversationKey),
    ...(input.bridgeUserId !== undefined ? { userId: input.bridgeUserId } : {}),
    conversationKey,
    outcome: "accepted",
    metadata: {
      fileName: file.fileName,
      bytes: file.bytes,
      kind: file.kind,
      via: "post-turn",
      larkChatId: input.chatId,
      larkMessageId: input.larkMessageId ?? input.replyTo,
      ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
    },
  }, "Lark file delivery timeline event");
}

async function appendLarkFileRejectedTimeline(
  input: {
    stateDir: string;
    chatId: string;
    conversationKey?: string;
    bridgeChatId?: number;
    bridgeUserId?: number;
    bridgeChatType?: "private" | "group";
    larkMessageId?: string;
    replyTo?: string;
  },
  rejection: {
    path: string;
    realPath?: string;
    reason: LarkFileRejectReason;
    detail?: string;
    kind: LarkSendPathKind;
  },
): Promise<void> {
  const conversationKey = input.conversationKey ?? `lark:${input.chatId}`;
  await appendTimelineEventBestEffort(input.stateDir, {
    type: "file.rejected",
    channel: "lark",
    chatId: input.bridgeChatId ?? stableLarkNumericId(conversationKey),
    ...(input.bridgeUserId !== undefined ? { userId: input.bridgeUserId } : {}),
    conversationKey,
    outcome: "rejected",
    detail: rejection.reason,
    metadata: {
      path: rejection.path,
      reason: rejection.reason,
      kind: rejection.kind,
      via: "post-turn",
      larkChatId: input.chatId,
      larkMessageId: input.larkMessageId ?? input.replyTo,
      ...(rejection.realPath ? { realPath: rejection.realPath } : {}),
      ...(rejection.detail ? { detail: rejection.detail } : {}),
      ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
    },
  }, "Lark file delivery rejection timeline event");
}

function larkFileRejectReasonFromError(error: unknown): LarkFileRejectReason {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") {
    return "not-found";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "permission-denied";
  }
  return "read-error";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function invalidStringArrayField(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return key;
    }
  }
  return null;
}

function buildLarkToolCard(
  payload: Record<string, unknown> | null,
  conversationKey: string | undefined,
  bridgeChatType: "private" | "group" | undefined,
  replyInThread: boolean | undefined,
): object {
  if (!payload) {
    throw new Error("lark.card requires an object payload");
  }
  if (payload.card && typeof payload.card === "object" && !Array.isArray(payload.card)) {
    return decorateRawLarkCard(payload.card as Record<string, unknown>, conversationKey, bridgeChatType, replyInThread);
  }

  const title = typeof payload.title === "string" ? payload.title : "请选择";
  const body = typeof payload.body === "string" ? payload.body : "";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: body || title,
    },
  ];
  if (actions.length > 0) {
    elements.push({
      tag: "column_set",
      columns: actions
        .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === "object" && !Array.isArray(action))
        .map((action) => {
          const label = typeof action.label === "string" ? action.label : "选择";
          const value = action.value ?? label;
          return {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                text: {
                  tag: "plain_text",
                  content: label,
                },
                type: action.type === "danger" || action.type === "primary" || action.type === "default"
                  ? action.type
                  : "primary",
                behaviors: [callbackBehavior({
                  cctb_lark: "choice",
                  ...(conversationKey ? { conversationKey } : {}),
                  ...(bridgeChatType ? { bridgeChatType } : {}),
                  ...(replyInThread ? { replyInThread: true } : {}),
                  label,
                  value,
                })],
              },
            ],
          };
        }),
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: title,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: {
      direction: "vertical",
      elements,
    },
  };
}

function decorateRawLarkCard(
  card: Record<string, unknown>,
  conversationKey: string | undefined,
  bridgeChatType: "private" | "group" | undefined,
  replyInThread: boolean | undefined,
): Record<string, unknown> {
  if (!conversationKey) {
    return card;
  }
  return decorateLarkCardNode(card, conversationKey, bridgeChatType, replyInThread) as Record<string, unknown>;
}

function decorateLarkCardNode(
  value: unknown,
  conversationKey: string,
  bridgeChatType: "private" | "group" | undefined,
  replyInThread: boolean | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decorateLarkCardNode(item, conversationKey, bridgeChatType, replyInThread));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const node = value as Record<string, unknown>;
  const decorated: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    decorated[key] = decorateLarkCardNode(item, conversationKey, bridgeChatType, replyInThread);
  }

  if (decorated.tag === "button") {
    const currentValue = payloadObject(decorated.value);
    const behaviors = arrayValue(decorated.behaviors);
    const existingCallback = findLarkCallbackValue(behaviors);
    if (!currentValue?.cctb_lark && !existingCallback?.cctb_lark && behaviors.length === 0) {
      const label = extractButtonLabel(decorated);
      decorated.behaviors = [
        callbackBehavior({
          cctb_lark: "choice",
          conversationKey,
          ...(bridgeChatType ? { bridgeChatType } : {}),
          ...(replyInThread ? { replyInThread: true } : {}),
          label,
          value: currentValue ?? label,
        }),
      ];
      delete decorated.value;
    } else if (currentValue?.cctb_lark && !existingCallback?.cctb_lark) {
      decorated.behaviors = [
        ...behaviors,
        callbackBehavior(withLarkThreadRouting(currentValue, replyInThread)),
      ];
      delete decorated.value;
    } else if (currentValue?.cctb_lark && existingCallback?.cctb_lark) {
      delete decorated.value;
    } else if (existingCallback?.cctb_lark && replyInThread) {
      decorated.behaviors = behaviors.map((behavior) => {
        if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) {
          return behavior;
        }
        const entry = behavior as Record<string, unknown>;
        if (entry.type !== "callback") {
          return behavior;
        }
        const callbackValue = payloadObject(entry.value);
        if (!callbackValue?.cctb_lark) {
          return behavior;
        }
        return {
          ...entry,
          value: withLarkThreadRouting(callbackValue, replyInThread),
        };
      });
    }
  }

  return decorated;
}

function withLarkThreadRouting(value: Record<string, unknown>, replyInThread: boolean | undefined): Record<string, unknown> {
  return replyInThread ? { ...value, replyInThread: true } : value;
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    value,
  };
}

function findLarkCallbackValue(behaviors: unknown): Record<string, unknown> | null {
  for (const behavior of arrayValue(behaviors)) {
    if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) {
      continue;
    }
    const entry = behavior as Record<string, unknown>;
    if (entry.type === "callback") {
      return payloadObject(entry.value);
    }
  }
  return null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractButtonLabel(button: Record<string, unknown>): string {
  const text = payloadObject(button.text);
  const content = text && typeof text.content === "string" ? text.content.trim() : "";
  return content || "choice";
}
