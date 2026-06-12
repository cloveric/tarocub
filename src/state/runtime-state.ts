import { JsonStore } from "./json-store.js";
import { withFileMutex } from "./file-mutex.js";
import { RuntimeStateSchema } from "./runtime-state-schema.js";

export interface RuntimeState {
  lastHandledUpdateId: number | null;
  activeTurnCount: number;
  activeTurnStartedAt?: string;
  activeTurnUpdatedAt?: string;
}

export function createDefaultRuntimeState(): RuntimeState {
  return {
    lastHandledUpdateId: null,
    activeTurnCount: 0,
  };
}

export class RuntimeStateStore {
  private readonly store: JsonStore<RuntimeState>;
  private readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new JsonStore<RuntimeState>(filePath, (value) => {
      const result = RuntimeStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid runtime state");
    });
  }

  async load(): Promise<RuntimeState> {
    try {
      return await this.store.read(createDefaultRuntimeState());
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && error.message === "invalid runtime state")
      ) {
        throw error; // transient I/O — retry the intact file
      }
      // Corruption: quarantine and reset so polling/turn-tracking can't wedge on
      // a bad write. The update watermark resets (a few recent updates may be
      // re-fetched; in-memory dedup guards against double-processing).
      console.error(`Corrupt runtime state file; quarantining and resetting:`, error instanceof Error ? error.message : error);
      await this.store.quarantineCurrentFile("corrupt");
      return createDefaultRuntimeState();
    }
  }

  async markHandledUpdateId(updateId: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      if (state.lastHandledUpdateId !== null && updateId <= state.lastHandledUpdateId) {
        return;
      }

      state.lastHandledUpdateId = updateId;
      await this.store.write(state);
    });
  }

  async markTurnStarted(now = new Date()): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      const timestamp = now.toISOString();
      state.activeTurnCount = Math.max(0, state.activeTurnCount ?? 0) + 1;
      state.activeTurnStartedAt ??= timestamp;
      state.activeTurnUpdatedAt = timestamp;
      await this.store.write(state);
    });
  }

  async markTurnActivity(now = new Date()): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      if ((state.activeTurnCount ?? 0) <= 0) {
        return;
      }

      state.activeTurnUpdatedAt = now.toISOString();
      await this.store.write(state);
    });
  }

  async markTurnCompleted(now = new Date()): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      state.activeTurnCount = Math.max(0, (state.activeTurnCount ?? 0) - 1);
      if (state.activeTurnCount === 0) {
        delete state.activeTurnStartedAt;
        delete state.activeTurnUpdatedAt;
      } else {
        state.activeTurnUpdatedAt = now.toISOString();
      }
      await this.store.write(state);
    });
  }

  async resetActiveTurns(): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      state.activeTurnCount = 0;
      delete state.activeTurnStartedAt;
      delete state.activeTurnUpdatedAt;
      await this.store.write(state);
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
