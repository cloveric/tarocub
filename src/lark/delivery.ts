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
import { executeTelegramTool } from "../tools/telegram-tool-executor.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { parseLarkDocumentCreateInput } from "./document-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import { resolveLarkLocale } from "./locale.js";
import { maybeSendLarkScopeAuthCard } from "./scope-auth.js";
import { resolveLarkMentionsInText, shouldResolveLarkMentions } from "./mention-resolver.js";
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
  instanceName?: string;
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

  for (const match of toolMatches) {
    let toolName = "unknown";
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      toolName = parsed.name;
      await executeLarkToolTag({
        ...input,
        name: parsed.name,
        payload: parsed.payload,
        locale,
      });
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        await appendLarkToolErrorTimeline(input, toolName, error);
      }
      // A Feishu-native tool (lark.doc / lark.card / …) that failed because the app lacks a
      // permission scope becomes an actionable "go authorize" card instead of a raw error.
      const handledAsScope = !(error instanceof SyntaxError) && await maybeSendLarkScopeAuthCard({
        channel: input.channel,
        chatId: input.chatId,
        appId: input.runtime.appInfo?.appId,
        domain: input.runtime.appInfo?.domain,
        options: replyOptions,
        locale,
      }, error);
      if (!handledAsScope) {
        await input.channel.send(input.chatId, {
          text: renderLarkToolTagParseError(error, locale),
        }, replyOptions);
      }
    }
  }

  for (const match of cronAddMatches) {
    try {
      await executeLarkToolTag({
        ...input,
        name: "cron.add",
        payload: match.payload,
        locale,
      });
    } catch (error) {
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

    // Images are collected and delivered together as one card (a titled series stays
    // grouped — see deliverLarkPendingImages); files are sent inline as we go.
    const pendingImages: Array<{ caption?: string; body: Buffer; real: string; originalPath: string }> = [];
    for (const match of matches) {
      const filePath = match.path;
      try {
        const real = await realpath(filePath);
        if (
          !input.allowAnyAbsolutePath &&
          !larkAnyFilePathAllowed() &&
          !real.startsWith(workspacePrefix) &&
          !(outputPrefix && real.startsWith(outputPrefix)) &&
          !(overridePrefix && real.startsWith(overridePrefix))
        ) {
          await appendLarkFileRejectedTimeline(input, {
            path: filePath,
            realPath: real,
            reason: "outside-workspace",
            kind: match.preferPhoto ? "image" : "file",
          });
          await input.channel.send(input.chatId, { text: renderLarkFileDeliveryError("outside-workspace", locale, workspaceRoot) }, replyOptions);
          continue;
        }
        const body = await readFile(real);
        if (match.preferPhoto) {
          // Pair each image with the caption that precedes its tag; the whole batch
          // is rendered as one card below so a titled series (e.g. 小红书 P1/P2/…)
          // stays grouped and legible instead of arriving as a bare, unlabelled pile.
          pendingImages.push({
            caption: captionForLarkImage(input.text, match.index),
            body,
            real,
            originalPath: filePath,
          });
        } else {
          await input.channel.send(input.chatId, {
            file: {
              source: body,
              fileName: path.basename(real),
            },
          }, replyOptions);
          await appendLarkFileAcceptedTimeline(input, {
            fileName: path.basename(real),
            bytes: body.length,
            kind: "file",
          });
        }
      } catch (error) {
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

    if (pendingImages.length > 0) {
      try {
        await deliverLarkPendingImages(input, pendingImages, replyOptions);
      } catch {
        // Best-effort: image delivery must never abort the text reply or the rest of
        // the turn. (Previously this call sat outside the per-match try/catch, so a
        // send failure threw out of deliverLarkResponse and dropped the text answer.)
        // Per-image failures already record rejected-timeline events inside
        // deliverLarkPendingImages / sendLarkImageWithFileFallback.
      }
    }
  }

  // Deliver the cleaned answer text even when a tool tag or file was rejected —
  // the rejection notices above are sent IN ADDITION to the text (Telegram
  // parity), never instead of it: one bad tag must not swallow the whole answer.
  if (input.sendText !== false && cleanedText) {
    await sendLarkMarkdownBestEffort(input.channel, input.chatId, cleanedText, replyOptions);
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
    const resolvedChunk = await resolveLarkMentionsInText({
      enabled: shouldResolveLarkMentions(process.env),
      channel,
      chatId,
      text: chunk,
    });
    await channel.send(chatId, { markdown: resolvedChunk }, options);
  }
}

async function sendLarkMarkdownBestEffort(
  channel: LarkChannelLike,
  chatId: string,
  markdown: string,
  options: LarkSendOptions | undefined,
): Promise<void> {
  for (const chunk of chunkLarkMarkdown(markdown)) {
    try {
      const resolvedChunk = await resolveLarkMentionsInText({
        enabled: shouldResolveLarkMentions(process.env),
        channel,
        chatId,
        text: chunk,
      });
      await channel.send(chatId, { markdown: resolvedChunk }, options);
    } catch {
      // Delivery is post-turn best-effort. A later chunk failure must not turn a
      // successful engine run into a failed run card; earlier chunks are already
      // visible and the delivery error is surfaced by the channel/runtime logs.
    }
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
  instanceName?: string;
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
      instanceName: input.instanceName ?? "lark",
    });
    await sendLarkMarkdown(input.channel, input.chatId, result.message, larkReplyOptions(input.replyTo, input.replyInThread));
    return result.ok;
  }

  if (input.name.startsWith("cron.")) {
    const result = await executeTelegramTool({
      name: input.name,
      payload: input.payload,
      context: {
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
        instanceName: input.instanceName ?? "lark",
      },
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
      ...(typeof payload?.caption === "string" && payload.caption.trim() ? { caption: payload.caption.trim() } : {}),
    });
  }

  if (input.name === "send.batch") {
    let ok = true;
    const invalidField = invalidStringArrayField(payload, ["files", "audios", "videos"]);
    if (invalidField) {
      await input.channel.send(input.chatId, {
        text: renderInvalidLarkToolPayload("send.batch", "string_array", input.locale, invalidField),
      }, larkReplyOptions(input.replyTo, input.replyInThread));
      return false;
    }
    // images accept paths OR {path, caption} objects so a batch can carry per-image titles.
    const imageEntries = normalizeLarkBatchImages(payload?.images);
    if (imageEntries === null) {
      await input.channel.send(input.chatId, {
        text: renderInvalidLarkToolPayload("send.batch", "image_entries", input.locale, "images"),
      }, larkReplyOptions(input.replyTo, input.replyInThread));
      return false;
    }
    const message = typeof payload?.message === "string" ? payload.message : "";
    for (const image of imageEntries) {
      ok = await sendLarkPath({ ...input, filePath: image.path, kind: "image", ...(image.caption ? { caption: image.caption } : {}) }) && ok;
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

  if (
    input.name === "lark.choice" ||
    input.name === "send.choice" ||
    input.name === "request_user_input" ||
    input.name === "lark.request_user_input" ||
    input.name === "lark.plan" ||
    input.name === "plan.choice"
  ) {
    const cardPayload = input.name === "request_user_input" || input.name === "lark.request_user_input"
      ? normalizeLarkRequestUserInputPayload(payload, input.locale)
      : normalizeLarkChoicePayload(payload, input.locale);
    const card = buildLarkToolCard(
      cardPayload,
      input.conversationKey,
      input.bridgeChatType,
      input.replyInThread,
      input.locale,
    );
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card,
      fallbackText: renderLarkToolCardFallback(cardPayload, input.locale),
      options: larkReplyOptions(input.replyTo, input.replyInThread),
      locale: input.locale,
    });
    return true;
  }

  if (input.name === "lark.card" || input.name === "send.card") {
    const card = buildLarkToolCard(payload, input.conversationKey, input.bridgeChatType, input.replyInThread, input.locale);
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card,
      fallbackText: renderLarkToolCardFallback(payload, input.locale),
      options: larkReplyOptions(input.replyTo, input.replyInThread),
      locale: input.locale,
    });
    return true;
  }

  if (input.name === "lark.doc.create" || input.name === "lark.doc") {
    const docInput = parseLarkDocumentCreateInput(payload);
    const created = await input.runtime.createDocument(docInput);
    const label = created.title ?? docInput.title ?? "飞书文档";
    const location = created.url ?? created.documentId ?? "(created)";
    const warning = created.warning
      ? input.locale === "en"
        ? `\n\nNote: ${created.warning}`
        : `\n\n提示：${created.warning}`
      : "";
    await sendLarkMarkdown(input.channel, input.chatId, input.locale === "en"
      ? `Created ${label}:\n${location}${warning}`
      : `已创建 ${label}：\n${location}${warning}`, larkReplyOptions(input.replyTo, input.replyInThread));
    return true;
  }
  await input.channel.send(input.chatId, {
    text: input.locale === "en" ? `Unsupported Lark tool ${input.name}.` : `错误：不支持的飞书工具 ${input.name}。`,
  }, larkReplyOptions(input.replyTo, input.replyInThread));
  return false;
}

/**
 * Normalizes a send.batch `images` field, which accepts either a path string or
 * a `{ path, caption }` object (so a batch can carry per-image titles). Returns
 * the normalized entries, [] when absent, or null when malformed.
 */
function normalizeLarkBatchImages(value: unknown): Array<{ path: string; caption?: string }> | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: Array<{ path: string; caption?: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (!entry.trim()) {
        return null;
      }
      out.push({ path: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const pathValue = (entry as { path?: unknown }).path;
    if (typeof pathValue !== "string" || !pathValue.trim()) {
      return null;
    }
    const captionRaw = (entry as { caption?: unknown }).caption;
    const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : undefined;
    out.push(caption ? { path: pathValue, caption } : { path: pathValue });
  }
  return out;
}

function renderInvalidLarkToolPayload(
  toolName: string,
  reason: "requires_path" | "string_array" | "image_entries",
  locale: Locale,
  field?: string,
): string {
  if (locale === "en") {
    if (reason === "requires_path") {
      return `Invalid Lark tool payload: ${toolName} requires payload.path.`;
    }
    if (reason === "image_entries") {
      return `Invalid Lark tool payload: ${toolName} images must be path strings or {path, caption} objects.`;
    }
    return `Invalid Lark tool payload: ${toolName} ${field ?? "field"} must be an array of strings.`;
  }
  if (reason === "requires_path") {
    return `错误：飞书工具参数无效：${toolName} 需要 payload.path。`;
  }
  if (reason === "image_entries") {
    return `错误：飞书工具参数无效：${toolName} images 必须是路径字符串或 {path, caption} 对象。`;
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
  /** Optional title for an image — renders it as a caption + image card. */
  caption?: string;
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
  if (!larkAnyFilePathAllowed() && !prefixes.some((prefix) => real.startsWith(prefix))) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.filePath,
      realPath: real,
      reason: "outside-workspace",
      kind: input.kind,
    });
    await input.channel.send(input.chatId, { text: renderLarkFileDeliveryError("outside-workspace", input.locale, workspaceRoot) }, larkReplyOptions(input.replyTo, input.replyInThread));
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
    // A captioned image (e.g. a titled send.batch entry, or send.image with a
    // caption) is delivered as a single card pairing the title with the image,
    // so a 小红书 P1/P2/… series stays legible. Falls back to the plain image
    // message if there's no caption, or if the upload/card path fails.
    if (input.caption) {
      const cardSent = await sendLarkCaptionedImageCard({
        channel: input.channel,
        chatId: input.chatId,
        replyOptions: larkReplyOptions(input.replyTo, input.replyInThread),
        body,
        caption: input.caption,
      }).catch(() => false);
      if (cardSent) {
        await appendLarkFileAcceptedTimeline(input, {
          fileName: path.basename(real),
          bytes: body.length,
          kind: "image",
        });
        return true;
      }
    }
    await sendLarkImageWithFileFallback({
      ...input,
      body,
      realPath: real,
      originalPath: input.filePath,
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

const LARK_IMAGE_CAPTION_MAX = 80;

/**
 * The caption for an image is the title line that sits directly above its
 * `[send-image:…]` tag — Claude's natural shape for a captioned series
 * ("P1 标题\n[send-image:…]"), and what the agent instructions ask for. Returns
 * undefined when the preceding non-empty line is itself a delivery tag (the
 * image has no caption) or is too long to be a title (likely prose, not a label).
 * `tagIndex` indexes into the same string passed here; the matcher's masking
 * preserves length + newlines, so indices stay aligned with the raw text.
 */
export function captionForLarkImage(text: string, tagIndex: number): string | undefined {
  const before = text.slice(0, tagIndex);
  const lines = before.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) {
      continue;
    }
    if (/\[send-(?:file|image):[^\]]+\]/.test(line)) {
      return undefined;
    }
    if (line.length > LARK_IMAGE_CAPTION_MAX) {
      return undefined;
    }
    // Drop a leading markdown heading marker so it renders at normal body size.
    return line.replace(/^#{1,6}\s+/, "").trim() || undefined;
  }
  return undefined;
}

/**
 * Deliver one image as a single card: caption (if any) + the image, so a batch of
 * titled images stays legible. Returns false (caller falls back to a bare image
 * message) when the channel can't upload or the upload yields no key.
 */
interface LarkRawImageClient {
  im?: {
    v1?: {
      image?: {
        create?: (req: { data: { image_type: string; image: Buffer } }) =>
          Promise<{ image_key?: string; data?: { image_key?: string } }>;
      };
    };
  };
}

/**
 * Uploads an image via the SDK channel's raw client and returns its image_key.
 * The SDK channel does NOT expose a standalone uploadImage; `rawClient.im.v1.image.create`
 * is the supported path (verified against real Feishu). Returns undefined when the
 * raw client / method isn't available so the caller falls back to a bare image.
 */
async function uploadLarkImageKey(channel: LarkChannelLike, body: Buffer): Promise<string | undefined> {
  const image = (channel as { rawClient?: LarkRawImageClient }).rawClient?.im?.v1?.image;
  if (!image || typeof image.create !== "function") {
    return undefined;
  }
  const res = await image.create({ data: { image_type: "message", image: body } });
  return res?.image_key ?? res?.data?.image_key ?? undefined;
}

/**
 * Builds a Card 2.0 holding one or more images, each preceded by its caption (if
 * any). One image → a single titled card; many images → the whole batch in one card
 * (a 小红书 series stays grouped). There is no preset count limit — the only real
 * ceiling is the Feishu message byte size, which {@link deliverLarkPendingImages}
 * discovers at send time and works around by splitting.
 */
function buildLarkImageCard(items: Array<{ caption?: string; imgKey: string }>): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item.caption) {
      elements.push({ tag: "markdown", content: item.caption });
    }
    elements.push({
      tag: "img",
      img_key: item.imgKey,
      alt: { tag: "plain_text", content: item.caption && item.caption.length > 0 ? item.caption : "图片" },
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: { direction: "vertical", padding: "12px 12px 12px 12px", elements },
  };
}

async function sendLarkCaptionedImageCard(input: {
  channel: LarkChannelLike;
  chatId: string;
  replyOptions: LarkSendOptions | undefined;
  body: Buffer;
  caption?: string;
}): Promise<boolean> {
  const imgKey = await uploadLarkImageKey(input.channel, input.body);
  if (!imgKey) {
    return false;
  }
  await input.channel.send(input.chatId, {
    card: buildLarkImageCard([{ caption: input.caption, imgKey }]),
  }, input.replyOptions);
  return true;
}

interface LarkUploadedImage {
  caption?: string;
  imgKey: string;
  real: string;
  originalPath: string;
  body: Buffer;
}

type LarkImageDeliveryInput = {
  channel: LarkChannelLike;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  stateDir: string;
  conversationKey?: string;
  bridgeChatId?: number;
  bridgeUserId?: number;
  bridgeChatType?: "private" | "group";
  larkMessageId?: string;
};

/**
 * Delivers a batch of `[send-image:…]` images as a SINGLE card (each image keeps its
 * own caption above it) so a titled series — e.g. a 小红书 P1/P2/… deck — arrives as
 * one grouped deliverable rather than one card per image. There is no preset image
 * count: the whole batch goes in one card. The only real ceiling is the Feishu message
 * byte size (img_key references are tiny — an 18-image card is ~3 KB), so we don't
 * guess a number; if the channel ever rejects the card as too large, we split it in
 * half and retry each half (see sendLarkImageCardOrSplit). Any image whose upload
 * fails — or a lone image whose card is still rejected — degrades to a bare image
 * message, never worse than before.
 */
async function deliverLarkPendingImages(
  input: LarkImageDeliveryInput,
  images: Array<{ caption?: string; body: Buffer; real: string; originalPath: string }>,
  replyOptions: LarkSendOptions | undefined,
): Promise<void> {
  const uploaded: LarkUploadedImage[] = [];
  const failedUploads: typeof images = [];
  for (const img of images) {
    const imgKey = await uploadLarkImageKey(input.channel, img.body).catch(() => undefined);
    if (imgKey) {
      uploaded.push({ caption: img.caption, imgKey, real: img.real, originalPath: img.originalPath, body: img.body });
    } else {
      failedUploads.push(img);
    }
  }

  await sendLarkImageCardOrSplit(input, uploaded, replyOptions);

  for (const img of failedUploads) {
    await sendLarkImageWithFileFallback({ ...input, body: img.body, realPath: img.real, originalPath: img.originalPath });
  }
}

/**
 * Sends the given images as ONE card. If the channel rejects it (e.g. the card exceeds
 * the message byte budget), splits the batch in half and retries each half — so the
 * real, undocumented size limit is discovered at send time instead of guessed with a
 * magic count. A single image whose card is still rejected falls back to a bare image.
 */
async function sendLarkImageCardOrSplit(
  input: LarkImageDeliveryInput,
  items: LarkUploadedImage[],
  replyOptions: LarkSendOptions | undefined,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  try {
    await input.channel.send(input.chatId, { card: buildLarkImageCard(items) }, replyOptions);
    for (const item of items) {
      await appendLarkFileAcceptedTimeline(input, {
        fileName: path.basename(item.real),
        bytes: item.body.length,
        kind: "image",
      });
    }
  } catch {
    if (items.length === 1) {
      const only = items[0]!;
      await sendLarkImageWithFileFallback({ ...input, body: only.body, realPath: only.real, originalPath: only.originalPath });
      return;
    }
    const mid = Math.floor(items.length / 2);
    await sendLarkImageCardOrSplit(input, items.slice(0, mid), replyOptions);
    await sendLarkImageCardOrSplit(input, items.slice(mid), replyOptions);
  }
}

async function sendLarkImageWithFileFallback(input: {
  channel: LarkChannelLike;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  stateDir: string;
  conversationKey?: string;
  bridgeChatId?: number;
  bridgeUserId?: number;
  bridgeChatType?: "private" | "group";
  larkMessageId?: string;
  body: Buffer;
  realPath: string;
  originalPath: string;
}): Promise<void> {
  const replyOptions = larkReplyOptions(input.replyTo, input.replyInThread);
  try {
    await input.channel.send(input.chatId, { image: { source: input.body } }, replyOptions);
    await appendLarkFileAcceptedTimeline(input, {
      fileName: path.basename(input.realPath),
      bytes: input.body.length,
      kind: "image",
    });
    return;
  } catch (error) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.originalPath,
      realPath: input.realPath,
      reason: larkFileRejectReasonFromError(error),
      detail: `image delivery failed; falling back to file: ${errorDetail(error)}`,
      kind: "image",
    });
  }

  try {
    await input.channel.send(input.chatId, {
      file: {
        source: input.body,
        fileName: path.basename(input.realPath),
      },
    }, replyOptions);
    await appendLarkFileAcceptedTimeline(input, {
      fileName: path.basename(input.realPath),
      bytes: input.body.length,
      kind: "file",
      fallbackFrom: "image",
    });
  } catch (error) {
    await appendLarkFileRejectedTimeline(input, {
      path: input.originalPath,
      realPath: input.realPath,
      reason: larkFileRejectReasonFromError(error),
      detail: `image file fallback failed: ${errorDetail(error)}`,
      kind: "file",
    });
  }
}

function larkAnyFilePathAllowed(): boolean {
  // Opt-in per instance (set CCTB_LARK_ALLOW_ANY_FILE_PATH=1 in the instance's
  // lark.env): when on, the file/image delivery sandbox is disabled and the bot may
  // send a file from ANY absolute path on the machine. Off by default — only files
  // under the workspace / output / override roots are sendable.
  return /^(?:1|true|yes|on)$/i.test((process.env.CCTB_LARK_ALLOW_ANY_FILE_PATH ?? "").trim());
}

function renderLarkFileDeliveryError(reason: "outside-workspace" | "read-error", locale: Locale, workspaceRoot?: string): string {
  // Name the exact allowed directory so the agent can self-correct — copy the file there
  // and resend — instead of guessing. A file left at a stale/elsewhere path otherwise loops.
  const dir = workspaceRoot ?? (locale === "en" ? "the workspace" : "工作区");
  if (locale === "en") {
    return reason === "outside-workspace"
      ? `This file is outside the allowed send directory — a path restriction, not a send failure. Copy it into ${dir} and resend (only files under that directory can be sent), or set CCTB_LARK_ALLOW_ANY_FILE_PATH=1 on this instance to allow any path.`
      : "File was not sent: failed to read the file; details were recorded in logs.";
  }
  return reason === "outside-workspace"
    ? `该文件不在允许发送的目录内——这是路径限制，不是发送失败。请把文件复制到 ${dir} 再发（只有该目录下的文件可直接发送），或在该实例设置 CCTB_LARK_ALLOW_ANY_FILE_PATH=1 放开任意路径。`
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
    fallbackFrom?: LarkSendPathKind;
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
      ...(file.fallbackFrom ? { fallbackFrom: file.fallbackFrom } : {}),
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
  locale: Locale,
): object {
  if (!payload) {
    throw new Error("lark.card requires an object payload");
  }
  if (payload.card && typeof payload.card === "object" && !Array.isArray(payload.card)) {
    return decorateRawLarkCard(payload.card as Record<string, unknown>, conversationKey, bridgeChatType, replyInThread);
  }

  const title = typeof payload.title === "string" ? payload.title : defaultLarkToolCardTitle(locale);
  const body = typeof payload.body === "string" ? payload.body : "";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: body || title,
    },
  ];
  if (actions.length > 0) {
    const normalizedActions = actions
      .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === "object" && !Array.isArray(action));
    normalizedActions.forEach((action, index) => {
      elements.push(...buildLarkOptionSection({
        action,
        index,
        conversationKey,
        bridgeChatType,
        replyInThread,
        locale,
      }));
      if (index < normalizedActions.length - 1) {
        elements.push({ tag: "hr" });
      }
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

function renderLarkToolCardFallback(payload: Record<string, unknown> | null, locale: Locale): string {
  if (!payload) {
    return locale === "en" ? "Interactive card could not be displayed." : "交互卡片无法显示。";
  }
  const title = stringValue(payload.title) ?? defaultLarkToolCardTitle(locale);
  const body = stringValue(payload.body) ?? "";
  const actions = Array.isArray(payload.actions)
    ? payload.actions.filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === "object" && !Array.isArray(action))
    : [];
  const lines = [
    `**${title}**`,
    body,
    ...actions.map((action, index) => {
      const label = stringValue(action.label) ?? stringValue(action.title) ?? defaultLarkToolCardActionLabel(locale);
      const description = stringValue(action.description) ?? stringValue(action.text) ?? "";
      return `${optionMarker(index)}. ${label}${description && description !== label ? ` — ${description}` : ""}`;
    }),
  ].filter(Boolean);
  return lines.join("\n");
}

function buildLarkOptionSection(input: {
  action: Record<string, unknown>;
  index: number;
  conversationKey: string | undefined;
  bridgeChatType: "private" | "group" | undefined;
  replyInThread: boolean | undefined;
  locale: Locale;
}): unknown[] {
  const label = stringValue(input.action.label) ?? defaultLarkToolCardActionLabel(input.locale);
  const value = input.action.value ?? label;
  const title = stringValue(input.action.title) ?? label;
  const description = stringValue(input.action.description) ??
    stringValue(input.action.body) ??
    stringValue(input.action.detail) ??
    stringValue(input.action.text);
  const buttonLabel = stringValue(input.action.buttonLabel) ??
    stringValue(input.action.cta) ??
    defaultLarkToolCardActionLabel(input.locale);
  const type = input.action.type === "danger" || input.action.type === "primary" || input.action.type === "default"
    ? input.action.type
    : "primary";

  return [
    {
      tag: "collapsible_panel",
      expanded: input.index === 0,
      header: {
        title: { tag: "markdown", content: `**${optionMarker(input.index)}. ${title}**` },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "follow_text",
        icon_expanded_angle: -180,
      },
      border: { color: input.index === 0 ? "blue" : "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: description && description !== title
            ? description
            : input.locale === "en" ? "_Click the button below to choose this option._" : "_点击下方按钮选择此项。_",
          text_size: "notation",
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: buttonLabel,
          },
          width: "fill",
          type,
          behaviors: [callbackBehavior({
            cctb_lark: "choice",
            ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
            ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
            ...(input.replyInThread ? { replyInThread: true } : {}),
            label,
            value,
          })],
        },
      ],
    },
  ];
}

function optionMarker(index: number): string {
  if (index >= 0 && index < 26) {
    return String.fromCharCode("A".charCodeAt(0) + index);
  }
  return String(index + 1);
}

function normalizeLarkChoicePayload(payload: Record<string, unknown> | null, locale: Locale): Record<string, unknown> {
  if (!payload) {
    throw new Error("lark.choice requires an object payload");
  }
  const prompt = stringValue(payload.prompt) ?? stringValue(payload.body) ?? stringValue(payload.question) ?? "";
  const title = stringValue(payload.title) ?? defaultLarkToolCardTitle(locale);
  const rawOptions = Array.isArray(payload.options)
    ? payload.options
    : Array.isArray(payload.actions)
      ? payload.actions
      : [];
  const actions = rawOptions
    .map((option): Record<string, unknown> | null => {
      if (typeof option === "string") {
        return { label: option, value: option };
      }
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return null;
      }
      const entry = option as Record<string, unknown>;
      const label = stringValue(entry.label) ?? stringValue(entry.text) ?? stringValue(entry.value) ?? defaultLarkToolCardActionLabel(locale);
      return {
        ...entry,
        label,
        value: entry.value ?? label,
      };
    })
    .filter((action): action is Record<string, unknown> => action !== null);

  return {
    title,
    body: prompt,
    actions,
  };
}

function normalizeLarkRequestUserInputPayload(payload: Record<string, unknown> | null, locale: Locale): Record<string, unknown> {
  if (!payload) {
    throw new Error("request_user_input requires an object payload");
  }
  const questions = Array.isArray(payload.questions)
    ? payload.questions.filter((question): question is Record<string, unknown> => Boolean(question) && typeof question === "object" && !Array.isArray(question))
    : [];
  const question = questions[0];
  if (!question) {
    return normalizeLarkChoicePayload(payload, locale);
  }
  const questionId = stringValue(question.id);
  const title = stringValue(question.header) ?? stringValue(payload.title) ?? defaultLarkToolCardTitle(locale);
  const prompt = stringValue(question.question) ?? stringValue(payload.prompt) ?? "";
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options = rawOptions
    .map((option): Record<string, unknown> | null => {
      if (typeof option === "string") {
        return {
          label: option,
          value: questionId ? `${questionId}:${option}` : option,
        };
      }
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return null;
      }
      const entry = option as Record<string, unknown>;
      const label = stringValue(entry.label) ?? stringValue(entry.text) ?? stringValue(entry.value) ?? defaultLarkToolCardActionLabel(locale);
      const rawValue = stringValue(entry.value) ?? label;
      return {
        ...entry,
        label,
        value: questionId ? `${questionId}:${rawValue}` : rawValue,
      };
    })
    .filter((option): option is Record<string, unknown> => option !== null);
  return {
    title,
    body: prompt,
    actions: options,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function defaultLarkToolCardTitle(locale: Locale): string {
  return locale === "en" ? "Choose" : "请选择";
}

function defaultLarkToolCardActionLabel(locale: Locale): string {
  return locale === "en" ? "Choose" : "选择";
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
