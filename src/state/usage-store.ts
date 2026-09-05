import { readFile } from "node:fs/promises";
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
  unmeteredRequestCount?: number;
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
  unmeteredRequestCount?: number;
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

export class UsageStateCorruptError extends Error {
  constructor(filePath: string, cause?: unknown) {
    super(`Usage state is corrupt and no valid last-good backup is available: ${filePath}`, { cause });
    this.name = "UsageStateCorruptError";
  }
}

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

function addUnmeteredUsage(target: UsageRecord | UsageBucket, timestamp: string): void {
  target.unmeteredRequestCount = (target.unmeteredRequestCount ?? 0) + 1;
  target.lastUpdatedAt = timestamp;
}

/** Corrupt-content errors recoverable by quarantine+reset (vs transient I/O). */
function isRepairableUsageStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "invalid usage state")
  );
}

export class UsageStore {
  private readonly store: JsonStore<UsageRecord>;
  private readonly backupStore: JsonStore<UsageRecord>;
  private static pendingWrites = new Map<string, Promise<void>>();
  private readonly filePath: string;
  private readonly backupPath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "usage.json");
    this.backupPath = path.join(stateDir, "usage.last-good.json");
    this.store = new JsonStore<UsageRecord>(this.filePath, parseUsageRecord);
    this.backupStore = new JsonStore<UsageRecord>(this.backupPath, parseUsageRecord);
  }

  async load(): Promise<UsageRecord> {
    return await withFileMutex(this.filePath, async () => await this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<UsageRecord> {
    try {
      return await this.store.read({ ...defaultUsage });
    } catch (error) {
      if (!isRepairableUsageStateError(error)) {
        // Transient I/O error — rethrow so the intact file is retried rather
        // than silently losing usage history.
        throw error;
      }
      // Never reset a corrupt budget ledger to zero: that silently re-opens spend.
      // Recover from an independently persisted last-good snapshot when possible;
      // otherwise keep the corrupt file in place and fail closed on every request.
      try {
        const recovered = parseUsageRecord(JSON.parse(await readFile(this.backupPath, "utf8")) as unknown);
        console.error(`Corrupt ${this.filePath}; restoring the last-good usage snapshot:`, error instanceof Error ? error.message : error);
        await this.store.quarantineCurrentFile("corrupt");
        await this.store.write(recovered);
        return recovered;
      } catch (backupError) {
        throw new UsageStateCorruptError(this.filePath, backupError);
      }
    }
  }

  async record(turn: TurnUsage, now = new Date()): Promise<void> {
    const task = async () => {
      await withFileMutex(this.filePath, async () => {
        const current = await this.loadUnlocked();
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
        const validated = parseUsageRecord(current);
        await this.store.write(validated);
        await this.backupStore.write(validated);
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

  async recordUnmetered(now = new Date()): Promise<void> {
    const task = async () => {
      await withFileMutex(this.filePath, async () => {
        const current = await this.loadUnlocked();
        const timestamp = now.toISOString();
        addUnmeteredUsage(current, timestamp);
        const dayKey = timestamp.slice(0, 10);
        const monthKey = timestamp.slice(0, 7);
        current.daily ??= {};
        current.monthly ??= {};
        current.daily[dayKey] ??= createEmptyBucket();
        current.monthly[monthKey] ??= createEmptyBucket();
        addUnmeteredUsage(current.daily[dayKey], timestamp);
        addUnmeteredUsage(current.monthly[monthKey], timestamp);
        const validated = parseUsageRecord(current);
        await this.store.write(validated);
        await this.backupStore.write(validated);
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

function parseUsageRecord(value: unknown): UsageRecord {
  const result = UsageRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error("invalid usage state");
  }
  return result.data;
}
