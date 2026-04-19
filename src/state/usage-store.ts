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
  private static pendingWrites = new Map<string, Promise<void>>();
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "usage.json");
    this.store = new JsonStore<UsageRecord>(this.filePath, (value) => {
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
      current.totalCostUsd = Number((current.totalCostUsd + (turn.costUsd ?? 0)).toFixed(12));
      current.requestCount += 1;
      current.lastUpdatedAt = new Date().toISOString();
      await this.store.write(current);
    };
    const previous = UsageStore.pendingWrites.get(this.filePath) ?? Promise.resolve();
    const run = previous.then(task, task);
    UsageStore.pendingWrites.set(this.filePath, run.then(
      () => undefined,
      () => undefined,
    ));
    await run;
  }
}
