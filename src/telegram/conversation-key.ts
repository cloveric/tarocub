export function getTelegramConversationKey(chatId: number, messageThreadId?: number): string {
  return typeof messageThreadId === "number"
    ? `chat:${chatId}:topic:${messageThreadId}`
    : `chat:${chatId}`;
}

export function getNormalizedTelegramConversationKey(input: {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}): string {
  return input.conversationKey ?? getTelegramConversationKey(input.chatId, input.messageThreadId);
}

export function getTelegramConversationLogScope(input: {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}): { messageThreadId?: number; conversationKey: string } {
  return {
    ...(typeof input.messageThreadId === "number" ? { messageThreadId: input.messageThreadId } : {}),
    conversationKey: getNormalizedTelegramConversationKey(input),
  };
}

export function isSameTelegramConversation(
  left: { chatId: number; messageThreadId?: number },
  right: { chatId: number; messageThreadId?: number },
): boolean {
  return left.chatId === right.chatId && left.messageThreadId === right.messageThreadId;
}
