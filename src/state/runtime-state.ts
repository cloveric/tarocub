import { JsonStore } from "./json-store.js";
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
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.store = new JsonStore<RuntimeState>(filePath, (value) => {
      const result = RuntimeStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid runtime state");
    });
  }

  async load(): Promise<RuntimeState> {
    return this.store.read(createDefaultRuntimeState());
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
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
