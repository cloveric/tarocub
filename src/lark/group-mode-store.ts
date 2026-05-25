import path from "node:path";

import { JsonStore } from "../state/json-store.js";

interface LarkGroupModeState {
  listenAllChatIds: string[];
}

function parseState(value: unknown): LarkGroupModeState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listenAllChatIds = Array.isArray(raw.listenAllChatIds)
    ? raw.listenAllChatIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    listenAllChatIds: [...new Set(listenAllChatIds)],
  };
}

export class LarkGroupModeStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly store: JsonStore<LarkGroupModeState>;
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "lark-group-mode.json");
    this.store = new JsonStore(this.filePath, parseState);
  }

  async isListenAll(chatId: string): Promise<boolean> {
    const state = await this.store.read({ listenAllChatIds: [] });
    return state.listenAllChatIds.includes(chatId);
  }

  async setListenAll(chatId: string, enabled: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.store.read({ listenAllChatIds: [] });
      const next = enabled
        ? [...new Set([...state.listenAllChatIds, chatId])]
        : state.listenAllChatIds.filter((entry) => entry !== chatId);
      await this.store.write({ listenAllChatIds: next });
    });
  }

  async countListenAll(): Promise<number> {
    const state = await this.store.read({ listenAllChatIds: [] });
    return state.listenAllChatIds.length;
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const previous = LarkGroupModeStore.writeQueues.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const queued = next.catch(() => undefined);
    LarkGroupModeStore.writeQueues.set(this.filePath, queued);
    try {
      await next;
    } finally {
      if (LarkGroupModeStore.writeQueues.get(this.filePath) === queued) {
        LarkGroupModeStore.writeQueues.delete(this.filePath);
      }
    }
  }
}
