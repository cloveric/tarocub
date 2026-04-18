import { JsonStore } from "./json-store.js";
import { RuntimeStateSchema } from "./runtime-state-schema.js";

export interface RuntimeState {
  lastHandledUpdateId: number | null;
}

export function createDefaultRuntimeState(): RuntimeState {
  return {
    lastHandledUpdateId: null,
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

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
