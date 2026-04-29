import path from "node:path";

import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import { UsageRecordSchema } from "./usage-state-schema.js";

export interface UsageRecord {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  requestCount: number;
  lastUpdatedAt: string;
  daily?: Record<string, UsageBucket>;
  monthly?: Record<string, UsageBucket>;
}

export interface UsageBucket {
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

function createEmptyBucket(): UsageBucket {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalCostUsd: 0,
    requestCount: 0,
    lastUpdatedAt: "",
  };
}

function addTurnUsage(target: UsageRecord | UsageBucket, turn: TurnUsage, timestamp: string): void {
  target.totalInputTokens += turn.inputTokens;
  target.totalOutputTokens += turn.outputTokens;
  target.totalCachedTokens += turn.cachedTokens ?? 0;
  target.totalCostUsd = Number((target.totalCostUsd + (turn.costUsd ?? 0)).toFixed(12));
  target.requestCount += 1;
  target.lastUpdatedAt = timestamp;
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

  async record(turn: TurnUsage, now = new Date()): Promise<void> {
    const task = async () => {
      await withFileMutex(this.filePath, async () => {
        const current = await this.load();
        const timestamp = now.toISOString();
        addTurnUsage(current, turn, timestamp);
        const dayKey = timestamp.slice(0, 10);
        const monthKey = timestamp.slice(0, 7);
        current.daily ??= {};
        current.monthly ??= {};
        current.daily[dayKey] ??= createEmptyBucket();
        current.monthly[monthKey] ??= createEmptyBucket();
        addTurnUsage(current.daily[dayKey], turn, timestamp);
        addTurnUsage(current.monthly[monthKey], turn, timestamp);
        await this.store.write(current);
      });
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
