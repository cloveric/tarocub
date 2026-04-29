import { randomBytes } from "node:crypto";
import path from "node:path";

import { JsonStore } from "./json-store.js";
import { withFileMutex } from "./file-mutex.js";
import {
  CronJobRecordSchema,
  CronStoreStateSchema,
  type CronJobRecord,
  type CronLocale,
  type CronSessionMode,
} from "./cron-store-schema.js";

export type { CronJobRecord, CronLocale, CronSessionMode } from "./cron-store-schema.js";

export interface CronJobInput {
  chatId: number;
  userId: number;
  chatType?: string;
  locale?: CronLocale;
  cronExpr: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
  runOnce?: boolean;
  targetAt?: string;
  sessionMode?: CronSessionMode;
  mute?: boolean;
  silent?: boolean;
  timeoutMins?: number;
  maxFailures?: number;
}

export interface CronJobUpdate {
  cronExpr?: string;
  prompt?: string;
  description?: string | null;
  enabled?: boolean;
  runOnce?: boolean;
  targetAt?: string | null;
  sessionMode?: CronSessionMode;
  mute?: boolean;
  silent?: boolean;
  timeoutMins?: number;
  maxFailures?: number;
}

export interface CronRunResult {
  success: boolean;
  error?: string;
  ranAt: string;
}

interface CronStoreState {
  jobs: CronJobRecord[];
}

export function resolveCronStorePath(stateDir: string): string {
  return path.join(stateDir, "cron-jobs.json");
}

export function generateCronJobId(): string {
  return randomBytes(4).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultState(): CronStoreState {
  return { jobs: [] };
}

export class CronStore {
  private readonly filePath: string;
  private readonly store: JsonStore<CronStoreState>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = resolveCronStorePath(stateDir);
    this.store = new JsonStore<CronStoreState>(this.filePath, (value) => {
      const result = CronStoreStateSchema.safeParse(value);
      if (result.success) {
        return { jobs: result.data.jobs };
      }
      throw new Error(`invalid cron store state: ${result.error.message}`);
    });
  }

  async list(): Promise<CronJobRecord[]> {
    const state = await this.store.read(createDefaultState());
    return [...state.jobs];
  }

  async listByChat(chatId: number): Promise<CronJobRecord[]> {
    const jobs = await this.list();
    return jobs.filter((job) => job.chatId === chatId);
  }

  async get(id: string): Promise<CronJobRecord | null> {
    const jobs = await this.list();
    return jobs.find((job) => job.id === id) ?? null;
  }

  async add(input: CronJobInput): Promise<CronJobRecord> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const id = generateCronJobId();
      const timestamp = nowIso();
      const record = CronJobRecordSchema.parse({
        id,
        chatId: input.chatId,
        userId: input.userId,
        chatType: input.chatType ?? "private",
        locale: input.locale,
        cronExpr: input.cronExpr,
        prompt: input.prompt,
        description: input.description,
        enabled: input.enabled ?? true,
        runOnce: input.runOnce ?? false,
        targetAt: input.targetAt,
        sessionMode: input.sessionMode ?? "reuse",
        mute: input.mute ?? false,
        silent: input.silent ?? false,
        timeoutMins: input.timeoutMins ?? 30,
        maxFailures: input.maxFailures ?? 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      state.jobs = [...state.jobs, record];
      await this.store.write(state);
      return record;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const next = state.jobs.filter((job) => job.id !== id);
      if (next.length === state.jobs.length) {
        return false;
      }
      state.jobs = next;
      await this.store.write(state);
      return true;
    });
  }

  async update(id: string, patch: CronJobUpdate): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        return null;
      }
      const existing = state.jobs[index]!;
      const merged: CronJobRecord = {
        ...existing,
        cronExpr: patch.cronExpr ?? existing.cronExpr,
        prompt: patch.prompt ?? existing.prompt,
        description:
          patch.description === null
            ? undefined
            : patch.description ?? existing.description,
        enabled: patch.enabled ?? existing.enabled,
        runOnce: patch.runOnce ?? existing.runOnce,
        targetAt:
          patch.targetAt === null
            ? undefined
            : patch.targetAt ?? existing.targetAt,
        sessionMode: patch.sessionMode ?? existing.sessionMode,
        mute: patch.mute ?? existing.mute,
        silent: patch.silent ?? existing.silent,
        timeoutMins: patch.timeoutMins ?? existing.timeoutMins,
        maxFailures: patch.maxFailures ?? existing.maxFailures,
        updatedAt: nowIso(),
      };
      const validated = CronJobRecordSchema.parse(merged);
      state.jobs = [...state.jobs];
      state.jobs[index] = validated;
      await this.store.write(state);
      return validated;
    });
  }

  async toggleEnabled(id: string): Promise<CronJobRecord | null> {
    const job = await this.get(id);
    if (!job) {
      return null;
    }
    return this.update(id, { enabled: !job.enabled });
  }

  async recordRun(id: string, result: CronRunResult): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        return null;
      }
      const existing = state.jobs[index]!;
      const historyEntry = result.success
        ? { ranAt: result.ranAt, success: true }
        : { ranAt: result.ranAt, success: false, error: result.error ?? "unknown error" };
      const merged: CronJobRecord = {
        ...existing,
        lastRunAt: result.ranAt,
        lastSuccessAt: result.success ? result.ranAt : existing.lastSuccessAt,
        lastError: result.success ? undefined : result.error ?? "unknown error",
        failureCount: result.success ? 0 : (existing.failureCount ?? 0) + 1,
        runHistory: [...(existing.runHistory ?? []), historyEntry].slice(-10),
        updatedAt: nowIso(),
      };
      const validated = CronJobRecordSchema.parse(merged);
      state.jobs = [...state.jobs];
      state.jobs[index] = validated;
      await this.store.write(state);
      return validated;
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
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
