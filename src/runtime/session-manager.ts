import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";

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

  async getOrCreateSession(chatId: number): Promise<{ sessionId: string }> {
    const existing = await this.sessionStore.findByChatIdSafe(chatId);

    if (existing.warning) {
      throw new SessionStateError(
        existing.repairable ? REPAIRABLE_SESSION_STATE_ERROR : NON_REPAIRABLE_SESSION_STATE_ERROR,
        existing.repairable ?? false,
      );
    }

    if (existing.record) {
      return { sessionId: existing.record.codexSessionId };
    }

    return { sessionId: `telegram-${chatId}` };
  }

  async bindSession(chatId: number, sessionId: string): Promise<void> {
    const existing = await this.sessionStore.findByChatId(chatId);
    await this.sessionStore.upsert({
      telegramChatId: chatId,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
      suspendedPrevious: existing?.suspendedPrevious,
    });
  }
}
