import { SessionStateSchema } from "./session-state-schema.js";
import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import type { SessionRecord, SessionState } from "../types.js";
import { getTelegramConversationKey } from "../telegram/conversation-key.js";

export const SESSION_STATE_UNREADABLE_WARNING = "session state unreadable";

export function createDefaultSessionState(): SessionState {
  return { chats: [] };
}

function recordConversationKey(record: Pick<SessionRecord, "telegramChatId" | "telegramThreadId" | "conversationKey">): string {
  return record.conversationKey ?? getTelegramConversationKey(record.telegramChatId, record.telegramThreadId);
}

function normalizeRecord(record: SessionRecord): SessionRecord {
  if (record.conversationKey === undefined && record.telegramThreadId === undefined) {
    return record;
  }
  return {
    ...record,
    conversationKey: recordConversationKey(record),
  };
}

export class SessionStore {
  private readonly store: JsonStore<SessionState>;
  private readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new JsonStore<SessionState>(filePath, (value) => {
      const result = SessionStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid session state");
    });
  }

  async load(): Promise<SessionState> {
    return this.store.read(createDefaultSessionState());
  }

  async inspect(): Promise<{ state: SessionState; warning?: string; repairable?: boolean }> {
    try {
      return { state: await this.load() };
    } catch (error) {
      if (isUnreadableSessionStateError(error)) {
        return {
          state: createDefaultSessionState(),
          warning: SESSION_STATE_UNREADABLE_WARNING,
          repairable: isRepairableSessionStateError(error),
        };
      }

      throw error;
    }
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      const normalized = normalizeRecord(record);
      const key = recordConversationKey(normalized);
      const index = state.chats.findIndex((entry) => recordConversationKey(entry) === key);

      if (index === -1) {
        state.chats.push(normalized);
      } else {
        state.chats[index] = normalized;
      }

      await this.store.write(state);
    });
  }

  async findByChatId(telegramChatId: number): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => matchesChatId(record, telegramChatId)) ?? null;
  }

  async findByConversationKey(conversationKey: string): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => recordConversationKey(record) === conversationKey) ?? null;
  }

  async findByChatIdSafe(
    telegramChatId: number,
  ): Promise<{ record: SessionRecord | null; warning?: string; repairable?: boolean }> {
    const { state, warning, repairable } = await this.inspect();
    return {
      record: state.chats.find((entry) => matchesChatId(entry, telegramChatId)) ?? null,
      warning,
      repairable,
    };
  }

  async findByConversationKeySafe(
    conversationKey: string,
  ): Promise<{ record: SessionRecord | null; warning?: string; repairable?: boolean }> {
    const { state, warning, repairable } = await this.inspect();
    return {
      record: state.chats.find((entry) => recordConversationKey(entry) === conversationKey) ?? null,
      warning,
      repairable,
    };
  }

  async removeByChatId(telegramChatId: number): Promise<boolean> {
    return this.removeMatching((record) => matchesChatId(record, telegramChatId));
  }

  async removeByConversationKey(conversationKey: string): Promise<boolean> {
    return this.removeMatching((record) => recordConversationKey(record) === conversationKey);
  }

  private async removeMatching(predicate: (record: SessionRecord) => boolean): Promise<boolean> {
    let removed = false;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      const nextChats = state.chats.filter((record) => {
        if (predicate(record)) {
          removed = true;
          return false;
        }

        return true;
      });

      if (!removed) {
        return;
      }

      state.chats = nextChats;
      await this.store.write(state);
    });

    return removed;
  }

  async clearAll(): Promise<number> {
    let removedCount = 0;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      removedCount = state.chats.length;
      if (removedCount === 0) {
        return;
      }

      state.chats = [];
      await this.store.write(state);
    });

    return removedCount;
  }

  async removeByChatIdRecovering(telegramChatId: number): Promise<{ removed: boolean; repaired: boolean }> {
    try {
      return {
        removed: await this.removeByChatId(telegramChatId),
        repaired: false,
      };
    } catch (error) {
      if (!isRepairableSessionStateError(error)) {
        throw error;
      }

      await this.store.quarantineCurrentFile("corrupt");
      await this.reset();
      return { removed: false, repaired: true };
    }
  }

  async removeByConversationKeyRecovering(conversationKey: string): Promise<{ removed: boolean; repaired: boolean }> {
    try {
      return {
        removed: await this.removeByConversationKey(conversationKey),
        repaired: false,
      };
    } catch (error) {
      if (!isRepairableSessionStateError(error)) {
        throw error;
      }

      await this.store.quarantineCurrentFile("corrupt");
      await this.reset();
      return { removed: false, repaired: true };
    }
  }

  async reset(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.store.write(createDefaultSessionState());
    });
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.then(
      () => withFileMutex(this.filePath, task),
      () => withFileMutex(this.filePath, task),
    );
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

function matchesChatId(record: SessionRecord, telegramChatId: number): boolean {
  if (record.telegramThreadId !== undefined) {
    return false;
  }
  if (record.conversationKey?.startsWith("lark:")) {
    return record.telegramChatId === telegramChatId;
  }
  return recordConversationKey(record) === getTelegramConversationKey(telegramChatId);
}

function isUnreadableSessionStateError(error: unknown): boolean {
  return (
    isRepairableSessionStateError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  );
}

function isRepairableSessionStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "invalid session state")
  );
}
