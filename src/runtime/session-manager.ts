import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";
import { getTelegramConversationKey } from "../telegram/conversation-key.js";

export class SessionStateError extends Error {
  readonly repairable: boolean;

  constructor(message: string, repairable: boolean) {
    super(message);
    this.name = "SessionStateError";
    this.repairable = repairable;
  }
}

const REPAIRABLE_SESSION_STATE_ERROR =
  "Session state is unreadable right now. The operator needs to repair session state and retry.";
const NON_REPAIRABLE_SESSION_STATE_ERROR =
  "Session state is unavailable right now. The operator needs to restore read access and retry.";

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getOrCreateSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<{ sessionId: string }> {
    const chatId = typeof scope === "number" ? scope : scope.chatId;
    const messageThreadId = typeof scope === "number" ? undefined : scope.messageThreadId;
    const conversationKey = typeof scope === "number"
      ? getTelegramConversationKey(scope)
      : scope.conversationKey ?? getTelegramConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKeySafe(conversationKey);

    if (existing.warning) {
      throw new SessionStateError(
        existing.repairable ? REPAIRABLE_SESSION_STATE_ERROR : NON_REPAIRABLE_SESSION_STATE_ERROR,
        existing.repairable ?? false,
      );
    }

    if (existing.record) {
      return { sessionId: existing.record.codexSessionId };
    }

    return { sessionId: messageThreadId === undefined ? `telegram-${chatId}` : `telegram-${chatId}-topic-${messageThreadId}` };
  }

  async getExistingSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<{ sessionId: string } | null> {
    const conversationKey = typeof scope === "number"
      ? getTelegramConversationKey(scope)
      : scope.conversationKey ?? getTelegramConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKeySafe(conversationKey);

    if (existing.warning) {
      throw new SessionStateError(
        existing.repairable ? REPAIRABLE_SESSION_STATE_ERROR : NON_REPAIRABLE_SESSION_STATE_ERROR,
        existing.repairable ?? false,
      );
    }

    return existing.record ? { sessionId: existing.record.codexSessionId } : null;
  }

  async bindSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }, sessionId: string): Promise<void> {
    const chatId = typeof scope === "number" ? scope : scope.chatId;
    const messageThreadId = typeof scope === "number" ? undefined : scope.messageThreadId;
    const conversationKey = typeof scope === "number"
      ? getTelegramConversationKey(scope)
      : scope.conversationKey ?? getTelegramConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKey(conversationKey);
    await this.sessionStore.upsert({
      telegramChatId: chatId,
      telegramThreadId: messageThreadId,
      conversationKey,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
      suspendedPrevious: existing?.suspendedPrevious,
    });
  }

  async clearSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<boolean> {
    const conversationKey = typeof scope === "number"
      ? getTelegramConversationKey(scope)
      : scope.conversationKey ?? getTelegramConversationKey(scope.chatId, scope.messageThreadId);
    return await this.sessionStore.removeByConversationKey(conversationKey);
  }
}
