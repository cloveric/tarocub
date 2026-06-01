export type LarkBridgeChatType = "private" | "group";
export type LarkChatMode = "p2p" | "group" | "topic";

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
  chatMode?: LarkChatMode;
  chatName?: string;
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
  chatMode?: LarkChatMode;
  chatName?: string;
  threadId?: string;
  replyToMessageId?: string;
  senderId: string;
  senderName?: string;
  bridgeChatId: number;
  bridgeAccessChatId: number;
  bridgeUserId: number;
  bridgeChatType: LarkBridgeChatType;
  conversationKey: string;
  accessConversationKey: string;
  text: string;
  replyContext?: {
    messageId: string;
    text: string;
  };
  mentions: unknown[];
  attachments: LarkNormalizedAttachment[];
  /**
   * Set by the /goal command handler (Claude/Antigravity path) before the message
   * falls through to a normal engine turn: it carries the goal objective so the
   * turn's run card renders the 🎯 goal banner (parity with the Codex goal card).
   */
  goalObjective?: string;
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

  const conversationKey = buildLarkConversationKey(
    message.chatId,
    larkSessionThreadIdForMessage(message.chatType, message.threadId, message.chatMode),
  );
  const accessConversationKey = buildLarkConversationKey(message.chatId);
  const attachments = normalizeLarkResources(message.resources ?? []);
  const text = buildLarkText(message, attachments);

  return {
    messageId: message.messageId,
    chatId: message.chatId,
    ...(message.chatMode ? { chatMode: message.chatMode } : {}),
    ...(message.chatName ? { chatName: message.chatName } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    bridgeChatId: stableLarkNumericId(conversationKey),
    bridgeAccessChatId: stableLarkNumericId(accessConversationKey),
    bridgeUserId: stableLarkNumericId(`user:${message.senderId}`),
    bridgeChatType: message.chatType === "p2p" ? "private" : "group",
    conversationKey,
    accessConversationKey,
    text,
    mentions: message.mentions ?? [],
    attachments,
  };
}

function isLarkSlashCommand(content: string | undefined): boolean {
  return Boolean(content?.trim().startsWith("/"));
}

export function buildLarkConversationKey(chatId: string, threadId?: string): string {
  return threadId ? `lark:${chatId}:${threadId}` : `lark:${chatId}`;
}

export function larkSessionThreadIdForMessage(
  chatType: string,
  threadId?: string,
  chatMode?: LarkChatMode,
): string | undefined {
  // Isolate by thread only when the chat is in topic-message form. The caller
  // (resolveLarkMessageChatMode) resolves chatMode to "topic" for both a native
  // topic group (chat_mode='topic') and a conversation group switched to the
  // topic message form (group_message_type='thread'); a conversation-form group
  // stays "group" so its topic replies share the one group session.
  const effectiveMode = chatMode ?? (chatType === "p2p" ? "p2p" : "topic");
  return effectiveMode === "topic" ? threadId : undefined;
}

/**
 * Decide, from a Feishu `im.v1.chat.get` payload, whether a chat is in
 * topic-message form (each topic = its own isolated session). True for a native
 * topic group (`chat_mode: "topic"`) and for a conversation group switched to
 * the topic message form (`group_message_type: "thread"`). The default
 * conversation form (`group_message_type: "chat"`) shares one group session.
 */
export function larkChatIsTopicForm(chat: { chat_mode?: unknown; group_message_type?: unknown }): boolean {
  return chat.chat_mode === "topic" || chat.group_message_type === "thread";
}

export function larkAccessConversationKeyFromConversationKey(conversationKey: string): string {
  const match = conversationKey.match(/^lark:([^:]+)(?::.+)?$/);
  if (!match) {
    return conversationKey;
  }
  return buildLarkConversationKey(match[1]!);
}

export function larkAccessChatIdFromConversationKey(conversationKey: string): number {
  return stableLarkNumericId(larkAccessConversationKeyFromConversationKey(conversationKey));
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
