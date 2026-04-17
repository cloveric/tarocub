import { JsonStore } from "./json-store.js";
import type { SessionRecord, SessionState } from "../types.js";

export const SESSION_STATE_UNREADABLE_WARNING = "session state unreadable";

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionRecord>;
  return (
    typeof candidate.telegramChatId === "number" &&
    typeof candidate.codexSessionId === "string" &&
    (candidate.status === "idle" ||
      candidate.status === "running" ||
      candidate.status === "queued" ||
      candidate.status === "blocked") &&
    isIsoTimestamp(candidate.updatedAt)
  );
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionState>;
  return Array.isArray(candidate.chats) && candidate.chats.every(isSessionRecord);
}

export function createDefaultSessionState(): SessionState {
  return { chats: [] };
}

export class SessionStore {
  private readonly store: JsonStore<SessionState>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.store = new JsonStore<SessionState>(filePath, (value) => {
      if (isSessionState(value)) {
        return value;
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
      const index = state.chats.findIndex((entry) => entry.telegramChatId === record.telegramChatId);

      if (index === -1) {
        state.chats.push(record);
      } else {
        state.chats[index] = record;
      }

      await this.store.write(state);
    });
  }

  async findByChatId(telegramChatId: number): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => record.telegramChatId === telegramChatId) ?? null;
  }

  async findByChatIdSafe(
    telegramChatId: number,
  ): Promise<{ record: SessionRecord | null; warning?: string; repairable?: boolean }> {
    const { state, warning, repairable } = await this.inspect();
    return {
      record: state.chats.find((entry) => entry.telegramChatId === telegramChatId) ?? null,
      warning,
      repairable,
    };
  }

  async updateLastContextTokens(telegramChatId: number, tokens: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      const record = state.chats.find((entry) => entry.telegramChatId === telegramChatId);
      if (!record) return;
      record.lastContextTokens = tokens;
      record.updatedAt = new Date().toISOString();
      await this.store.write(state);
    });
  }

  async removeByChatId(telegramChatId: number): Promise<boolean> {
    let removed = false;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      const nextChats = state.chats.filter((record) => {
        if (record.telegramChatId === telegramChatId) {
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

  async reset(): Promise<void> {
    await this.store.write(createDefaultSessionState());
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
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
