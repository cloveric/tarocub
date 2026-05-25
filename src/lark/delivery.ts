import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  extractDeliveryTagMatches,
  stripDeliveryTags,
} from "../telegram/delivery-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
  stripTelegramToolTags,
} from "../telegram/tool-tags.js";
import { parseLarkDocumentCreateInput } from "./document-client.js";
import { renderLarkUserFacingError } from "./errors.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkChannelLike, LarkSendOptions } from "./service.js";

type LarkSendPathKind = "file" | "image" | "audio" | "video";

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
  sendText?: boolean;
}): Promise<void> {
  const toolMatches = extractTelegramToolTagMatches(input.text);
  const cleanedText = stripTelegramToolTags(stripDeliveryTags(input.text));
  const replyOptions = larkReplyOptions(input.replyTo, input.replyInThread);
  if (input.sendText !== false && cleanedText) {
    await input.channel.send(input.chatId, { markdown: cleanedText }, replyOptions);
  }

  for (const match of toolMatches) {
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      await executeLarkToolTag({
        ...input,
        name: parsed.name,
        payload: parsed.payload,
      });
    } catch (error) {
      await input.channel.send(input.chatId, {
        text: renderLarkUserFacingError(error, "tool"),
      }, replyOptions);
    }
  }

  const matches = extractDeliveryTagMatches(input.text);
  if (matches.length === 0) {
    return;
  }

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
        !real.startsWith(workspacePrefix) &&
        !(outputPrefix && real.startsWith(outputPrefix)) &&
        !(overridePrefix && real.startsWith(overridePrefix))
      ) {
        await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, replyOptions);
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
    } catch {
      await input.channel.send(input.chatId, {
        text: "文件未发送：读取文件失败，详细原因已记录到日志。",
      }, replyOptions);
    }
  }
}

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }

  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
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
}): Promise<void> {
  const payload = payloadObject(input.payload);
  if (
    (input.name === "send.file" || input.name === "send.image" || input.name === "send.audio" || input.name === "send.video") &&
    typeof payload?.path === "string"
  ) {
    await sendLarkPath({
      ...input,
      filePath: payload.path,
      kind: input.name.slice("send.".length) as LarkSendPathKind,
    });
    return;
  }

  if (input.name === "send.batch") {
    const message = typeof payload?.message === "string" ? payload.message : "";
    if (message.trim()) {
      await input.channel.send(input.chatId, { markdown: message.trim() }, larkReplyOptions(input.replyTo, input.replyInThread));
    }
    for (const image of stringArray(payload?.images)) {
      await sendLarkPath({ ...input, filePath: image, kind: "image" });
    }
    for (const file of stringArray(payload?.files)) {
      await sendLarkPath({ ...input, filePath: file, kind: "file" });
    }
    for (const audio of stringArray(payload?.audios)) {
      await sendLarkPath({ ...input, filePath: audio, kind: "audio" });
    }
    for (const video of stringArray(payload?.videos)) {
      await sendLarkPath({ ...input, filePath: video, kind: "video" });
    }
    return;
  }

  if (input.name === "lark.post" || input.name === "send.post") {
    const post = payload?.post ?? payload;
    if (!post || typeof post !== "object" || Array.isArray(post)) {
      throw new Error(`${input.name} requires an object payload`);
    }
    await input.channel.send(input.chatId, { post }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }

  if (input.name === "lark.card" || input.name === "send.card") {
    const card = buildLarkToolCard(payload, input.conversationKey, input.bridgeChatType);
    await input.channel.send(input.chatId, { card }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }

  if (input.name === "lark.doc.create" || input.name === "lark.doc") {
    const docInput = parseLarkDocumentCreateInput(payload);
    const created = await input.runtime.createDocument(docInput);
    const label = created.title ?? docInput.title ?? "飞书文档";
    const location = created.url ?? created.documentId ?? "(created)";
    await input.channel.send(input.chatId, {
      markdown: `已创建 ${label}：\n${location}`,
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
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
}): Promise<void> {
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
  const real = await realpath(input.filePath);
  if (!prefixes.some((prefix) => real.startsWith(prefix))) {
    await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  const body = await readFile(real);
  if (input.kind === "image") {
    await input.channel.send(input.chatId, { image: { source: body } }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  if (input.kind === "audio") {
    await input.channel.send(input.chatId, {
      audio: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  if (input.kind === "video") {
    await input.channel.send(input.chatId, {
      video: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  await input.channel.send(input.chatId, {
    file: {
      source: body,
      fileName: path.basename(real),
    },
  }, larkReplyOptions(input.replyTo, input.replyInThread));
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildLarkToolCard(
  payload: Record<string, unknown> | null,
  conversationKey: string | undefined,
  bridgeChatType: "private" | "group" | undefined,
): object {
  if (!payload) {
    throw new Error("lark.card requires an object payload");
  }
  if (payload.card && typeof payload.card === "object" && !Array.isArray(payload.card)) {
    return decorateRawLarkCard(payload.card as Record<string, unknown>, conversationKey, bridgeChatType);
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
): Record<string, unknown> {
  if (!conversationKey) {
    return card;
  }
  return decorateLarkCardNode(card, conversationKey, bridgeChatType) as Record<string, unknown>;
}

function decorateLarkCardNode(
  value: unknown,
  conversationKey: string,
  bridgeChatType: "private" | "group" | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decorateLarkCardNode(item, conversationKey, bridgeChatType));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const node = value as Record<string, unknown>;
  const decorated: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    decorated[key] = decorateLarkCardNode(item, conversationKey, bridgeChatType);
  }

  if (decorated.tag === "button") {
    const currentValue = payloadObject(decorated.value);
    const existingCallback = findLarkCallbackValue(decorated.behaviors);
    if (!currentValue?.cctb_lark && !existingCallback?.cctb_lark) {
      const label = extractButtonLabel(decorated);
      decorated.behaviors = [
        ...arrayValue(decorated.behaviors),
        callbackBehavior({
          cctb_lark: "choice",
          conversationKey,
          ...(bridgeChatType ? { bridgeChatType } : {}),
          label,
          value: currentValue ?? label,
        }),
      ];
      delete decorated.value;
    } else if (currentValue?.cctb_lark && !existingCallback?.cctb_lark) {
      decorated.behaviors = [
        ...arrayValue(decorated.behaviors),
        callbackBehavior(currentValue),
      ];
      delete decorated.value;
    }
  }

  return decorated;
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
