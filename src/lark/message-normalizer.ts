export type LarkBridgeChatType = "private" | "group";

export interface LarkResourceDescriptor {
  type: string;
  fileKey?: string;
  file_key?: string;
  fileName?: string;
  file_name?: string;
}

export interface LarkIncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
  content?: string;
  rawContentType?: string;
  resources?: LarkResourceDescriptor[];
  mentions?: unknown[];
  mentionAll?: boolean;
  mentionedBot?: boolean;
  createTime?: number;
}

export interface LarkMessageNormalizerOptions {
  requireMentionInGroup?: boolean;
}

export interface LarkNormalizedAttachment {
  kind: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
}

export interface LarkNormalizedBridgeMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  senderId: string;
  senderName?: string;
  bridgeChatId: number;
  bridgeUserId: number;
  bridgeChatType: LarkBridgeChatType;
  conversationKey: string;
  text: string;
  replyContext?: {
    messageId: string;
    text: string;
  };
  attachments: LarkNormalizedAttachment[];
}

const SUPPORTED_RESOURCE_TYPES = new Set(["image", "file", "audio", "video"]);

export function stableLarkNumericId(value: string): number {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff;
}

export function normalizeLarkMessage(
  message: LarkIncomingMessage,
  options: LarkMessageNormalizerOptions = {},
): LarkNormalizedBridgeMessage | null {
  const requireMentionInGroup = options.requireMentionInGroup ?? false;
  const isGroupLike = message.chatType !== "p2p";
  const isExplicitSlashCommand = isLarkSlashCommand(message.content);

  if (isGroupLike && requireMentionInGroup && !message.mentionedBot && !message.mentionAll && !isExplicitSlashCommand) {
    return null;
  }

  const conversationKey = buildLarkConversationKey(message.chatId, message.threadId);
  const attachments = normalizeLarkResources(message.resources ?? []);
  const text = buildLarkText(message, attachments);

  return {
    messageId: message.messageId,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    bridgeChatId: stableLarkNumericId(conversationKey),
    bridgeUserId: stableLarkNumericId(`user:${message.senderId}`),
    bridgeChatType: message.chatType === "p2p" ? "private" : "group",
    conversationKey,
    text,
    attachments,
  };
}

function isLarkSlashCommand(content: string | undefined): boolean {
  return Boolean(content?.trim().startsWith("/"));
}

function buildLarkConversationKey(chatId: string, threadId?: string): string {
  return threadId ? `lark:${chatId}:${threadId}` : `lark:${chatId}`;
}

function normalizeLarkResources(resources: LarkResourceDescriptor[]): LarkNormalizedAttachment[] {
  return resources.flatMap((resource) => {
    if (!SUPPORTED_RESOURCE_TYPES.has(resource.type)) {
      return [];
    }

    const fileKey = resource.fileKey ?? resource.file_key;
    if (!fileKey) {
      return [];
    }

    const attachment: LarkNormalizedAttachment = {
      kind: resource.type as LarkNormalizedAttachment["kind"],
      fileKey,
    };
    const fileName = resource.fileName ?? resource.file_name;
    if (fileName) {
      attachment.fileName = fileName;
    }
    return [attachment];
  });
}

function buildLarkText(
  message: LarkIncomingMessage,
  attachments: LarkNormalizedAttachment[],
): string {
  const contextLines = [
    "<lark_context>",
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    ...(message.threadId ? [`thread_id: ${message.threadId}`] : []),
    ...(message.rootId ? [`root_id: ${message.rootId}`] : []),
    ...(message.replyToMessageId ? [`reply_to_message_id: ${message.replyToMessageId}`] : []),
    `message_id: ${message.messageId}`,
    `sender_id: ${message.senderId}`,
    ...(message.senderName ? [`sender_name: ${message.senderName}`] : []),
    ...(typeof message.createTime === "number" ? [`create_time: ${message.createTime}`] : []),
    "</lark_context>",
  ];

  const body = formatLarkBody(message);
  const attachmentSummary = attachments.length > 0
    ? attachments
      .map((attachment) => {
        const name = attachment.fileName ? ` ${attachment.fileName}` : "";
        return `[${attachment.kind}:${attachment.fileKey}${name}]`;
      })
      .join("\n")
    : "";

  return [contextLines.join("\n"), body, attachmentSummary]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function formatLarkBody(message: LarkIncomingMessage): string {
  const body = (message.content ?? "").trim();
  if (!body) {
    return "";
  }
  if (message.rawContentType === "merge_forward") {
    return `<forwarded_lark_messages>\n${body}\n</forwarded_lark_messages>`;
  }
  return body;
}
