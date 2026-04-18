import path from "node:path";

import { JsonStore } from "./json-store.js";
import { UsageRecordSchema } from "./usage-state-schema.js";

export interface UsageRecord {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  requestCount: number;
  lastUpdatedAt: string;
}

const defaultUsage: UsageRecord = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCachedTokens: 0,
  totalCostUsd: 0,
  requestCount: 0,
  lastUpdatedAt: "",
};

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

export class UsageStore {
  private readonly store: JsonStore<UsageRecord>;
  // Serialize read-modify-write so concurrent chats don't clobber each
  // other's increments. Same pattern as SessionStore.enqueueWrite.
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.store = new JsonStore<UsageRecord>(path.join(stateDir, "usage.json"), (value) => {
      const result = UsageRecordSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid usage state");
    });
  }

  async load(): Promise<UsageRecord> {
    return await this.store.read({ ...defaultUsage });
  }

  async record(turn: TurnUsage): Promise<void> {
    const task = async () => {
      const current = await this.load();
      current.totalInputTokens += turn.inputTokens;
      current.totalOutputTokens += turn.outputTokens;
      current.totalCachedTokens += turn.cachedTokens ?? 0;
      current.totalCostUsd += turn.costUsd ?? 0;
      current.requestCount += 1;
      current.lastUpdatedAt = new Date().toISOString();
      await this.store.write(current);
    };
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }
}
