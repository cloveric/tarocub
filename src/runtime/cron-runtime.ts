import { CronStore } from "../state/cron-store.js";
import { CronScheduler, type CronExecutor, type CronFailureHandler } from "./cron-scheduler.js";

/**
 * Holds the singleton CronStore + CronScheduler for the current bot service.
 * Lifecycle:
 *  - {@link initializeCronRuntime} is called once during `src/index.ts` boot
 *    after access store / runtime state recovery completes.
 *  - The same store and scheduler instances back BOTH the per-tick scheduler
 *    timers AND the user-facing `/cron` Telegram commands. Sharing the store
 *    avoids file write races and lets `/cron add` synchronously refresh the
 *    in-memory schedule.
 *  - {@link shutdownCronRuntime} is awaited in `src/index.ts` finally so
 *    in-flight jobs can drain (up to 30s) before the process exits.
 *
 * Tests can override the singleton with {@link setActiveCronRuntimeForTest}
 * and clear it with {@link clearActiveCronRuntimeForTest}.
 */
export interface CronRuntime {
  store: CronStore;
  scheduler: CronScheduler;
}

let active: CronRuntime | null = null;

export function getActiveCronRuntime(): CronRuntime | null {
  return active;
}

export interface InitializeCronRuntimeOptions {
  stateDir: string;
  executor: CronExecutor;
  instanceName?: string;
  defaultTimezone?: string;
  logger?: Pick<Console, "error" | "warn">;
  onJobFailure?: CronFailureHandler;
}

export async function initializeCronRuntime(options: InitializeCronRuntimeOptions): Promise<CronRuntime> {
  const store = new CronStore(options.stateDir, { defaultTimezone: options.defaultTimezone });
  const scheduler = new CronScheduler({
    store,
    executor: options.executor,
    stateDir: options.stateDir,
    instanceName: options.instanceName,
    logger: options.logger,
    onJobFailure: options.onJobFailure,
  });
  await scheduler.start();
  active = { store, scheduler };
  return active;
}

export async function shutdownCronRuntime(): Promise<void> {
  if (!active) {
    return;
  }
  const current = active;
  active = null;
  await current.scheduler.stop();
}

/** @internal Test-only override. */
export function setActiveCronRuntimeForTest(runtime: CronRuntime | null): void {
  active = runtime;
}

/** @internal Test-only reset. */
export function clearActiveCronRuntimeForTest(): void {
  active = null;
}
