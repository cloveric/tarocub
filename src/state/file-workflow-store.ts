import path from "node:path";

import { FileWorkflowStateSchema } from "./file-workflow-schema.js";
import { JsonStore } from "./json-store.js";

export const FILE_WORKFLOW_STATE_UNREADABLE_WARNING = "file workflow state unreadable";

export type FileWorkflowKind = "image" | "document" | "archive";
export type FileWorkflowStatus = "preparing" | "processing" | "awaiting_continue" | "completed" | "failed";

export interface FileWorkflowRecord {
  uploadId: string;
  chatId: number;
  userId: number;
  kind: FileWorkflowKind;
  status: FileWorkflowStatus;
  sourceFiles: string[];
  derivedFiles: string[];
  summary: string;
  summaryMessageId?: number;
  extractedPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface FileWorkflowState {
  records: FileWorkflowRecord[];
}

export interface FileWorkflowListFilter {
  chatId?: number;
  status?: FileWorkflowStatus;
}

function createDefaultState(): FileWorkflowState {
  return { records: [] };
}

function selectLatestRecord(records: FileWorkflowRecord[]): FileWorkflowRecord | null {
  let latest: FileWorkflowRecord | null = null;

  for (const record of records) {
    if (latest === null || record.updatedAt.localeCompare(latest.updatedAt) > 0) {
      latest = record;
    }
  }

  return latest;
}

export function resolveFileWorkflowStatePath(stateDir: string): string {
  return path.join(stateDir, "file-workflow.json");
}

export class FileWorkflowStore {
  private readonly store: JsonStore<FileWorkflowState>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.store = new JsonStore<FileWorkflowState>(resolveFileWorkflowStatePath(stateDir), (value) => {
      const result = FileWorkflowStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid file workflow state");
    });
  }

  async load(): Promise<FileWorkflowState> {
    try {
      return await this.store.read(createDefaultState());
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("invalid file workflow state", { cause: error });
      }

      throw error;
    }
  }

  async inspect(): Promise<{ state: FileWorkflowState; warning?: string }> {
    try {
      return { state: await this.load() };
    } catch (error) {
      if (isUnreadableFileWorkflowStateError(error)) {
        return {
          state: createDefaultState(),
          warning: FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
        };
      }

      throw error;
    }
  }

  async append(record: FileWorkflowRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      state.records.push(record);
      await this.store.write(state);
    });
  }

  async list(filter: FileWorkflowListFilter = {}): Promise<FileWorkflowRecord[]> {
    const state = await this.load();
    const records = state.records.filter((record) => {
      if (filter.chatId !== undefined && record.chatId !== filter.chatId) {
        return false;
      }

      if (filter.status !== undefined && record.status !== filter.status) {
        return false;
      }

      return true;
    });

    return [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async find(uploadId: string): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    return state.records.find((record) => record.uploadId === uploadId) ?? null;
  }

  async findSafe(uploadId: string): Promise<{ record: FileWorkflowRecord | null; warning?: string }> {
    const { state, warning } = await this.inspect();
    return {
      record: state.records.find((entry) => entry.uploadId === uploadId) ?? null,
      warning,
    };
  }

  async remove(uploadId: string): Promise<boolean> {
    let removed = false;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      const nextRecords = state.records.filter((record) => {
        if (record.uploadId === uploadId) {
          removed = true;
          return false;
        }

        return true;
      });

      if (!removed) {
        return;
      }

      state.records = nextRecords;
      await this.store.write(state);
    });

    return removed;
  }

  async removeRecovering(uploadId: string): Promise<{ removed: boolean; repaired: boolean }> {
    try {
      return {
        removed: await this.remove(uploadId),
        repaired: false,
      };
    } catch (error) {
      if (!isRepairableFileWorkflowStateError(error)) {
        throw error;
      }

      await this.store.quarantineCurrentFile("corrupt");
      await this.reset();
      return { removed: false, repaired: true };
    }
  }

  async update(uploadId: string, mutate: (record: FileWorkflowRecord) => void): Promise<FileWorkflowRecord | null> {
    let updated: FileWorkflowRecord | null = null;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      const record = state.records.find((entry) => entry.uploadId === uploadId);
      if (!record) {
        return;
      }

      mutate(record);
      record.updatedAt = new Date().toISOString();
      await this.store.write(state);
      updated = record;
    });

    return updated;
  }

  async getLatestAwaitingArchive(chatId: number): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    const candidates = state.records.filter((record) => record.chatId === chatId && record.kind === "archive" && record.status === "awaiting_continue");
    return selectLatestRecord(candidates);
  }

  async getAwaitingArchive(chatId: number, uploadId: string): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    return state.records.find((record) =>
      record.chatId === chatId &&
      record.uploadId === uploadId &&
      record.kind === "archive" &&
      record.status === "awaiting_continue",
    ) ?? null;
  }

  async getAwaitingArchiveBySummaryMessageId(chatId: number, summaryMessageId: number): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    return state.records.find((record) =>
      record.chatId === chatId &&
      record.kind === "archive" &&
      record.status === "awaiting_continue" &&
      record.summaryMessageId === summaryMessageId,
    ) ?? null;
  }

  async getArchiveContinuationTarget(input: {
    chatId: number;
    uploadId?: string;
    summaryMessageId?: number;
  }): Promise<FileWorkflowRecord | null> {
    if (input.uploadId === undefined && input.summaryMessageId === undefined) {
      return null;
    }

    const state = await this.load();
    return state.records.find((record) =>
      record.chatId === input.chatId &&
      record.kind === "archive" &&
      (
        (input.uploadId !== undefined && record.uploadId === input.uploadId) ||
        (input.summaryMessageId !== undefined && record.summaryMessageId === input.summaryMessageId)
      ),
    ) ?? null;
  }

  async beginArchiveContinuation(input: {
    chatId: number;
    uploadId?: string;
    summaryMessageId?: number;
  }): Promise<FileWorkflowRecord | null> {
    let claimedRecord: FileWorkflowRecord | null = null;

    await this.enqueueWrite(async () => {
      const state = await this.load();
      const isExplicitTarget = input.uploadId !== undefined || input.summaryMessageId !== undefined;
      const matchingRecords = state.records.filter((record) =>
        record.chatId === input.chatId &&
        record.kind === "archive" &&
        (
          record.status === "awaiting_continue" ||
          (isExplicitTarget && record.status === "failed")
        ),
      );

      const record =
        input.uploadId
          ? matchingRecords.find((entry) => entry.uploadId === input.uploadId)
          : input.summaryMessageId !== undefined
            ? matchingRecords.find((entry) => entry.summaryMessageId === input.summaryMessageId) ?? null
            : selectLatestRecord(matchingRecords);

      if (!record) {
        return;
      }

      record.status = "processing";
      record.updatedAt = new Date().toISOString();
      await this.store.write(state);
      claimedRecord = { ...record };
    });

    return claimedRecord;
  }

  async reset(): Promise<void> {
    await this.store.write(createDefaultState());
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

export function isRepairableFileWorkflowStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "invalid file workflow state")
  );
}

function isUnreadableFileWorkflowStateError(error: unknown): boolean {
  return (
    isRepairableFileWorkflowStateError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  );
}
