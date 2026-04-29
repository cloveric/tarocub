import { Cron } from "croner";

import { appendAuditEvent } from "../state/audit-log.js";
import { appendTimelineEventBestEffort } from "./timeline-events.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import type { CronStore } from "../state/cron-store.js";

async function appendAuditEventBestEffort(
  stateDir: string,
  event: Parameters<typeof appendAuditEvent>[1],
): Promise<void> {
  try {
    await appendAuditEvent(stateDir, event);
  } catch {
    // Best-effort audit. Cron must keep running even if disk is full.
  }
}

export type CronExecutor = (job: CronJobRecord, abortSignal?: AbortSignal) => Promise<void>;
export type CronFailureHandler = (job: CronJobRecord, error: string) => Promise<void>;

export interface CronSchedulerOptions {
  store: CronStore;
  executor: CronExecutor;
  stateDir: string;
  instanceName?: string;
  logger?: Pick<Console, "error" | "warn">;
  timeoutMsPerMinute?: number;
  onJobFailure?: CronFailureHandler;
}

interface RunningJob {
  stop: () => void;
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Validates a cron expression by attempting to construct a paused Cron instance.
 * Returns the next-fire date if valid, or null if invalid.
 */
export function validateCronExpression(expr: string): Date | null {
  try {
    const probe = new Cron(expr, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next;
  } catch {
    return null;
  }
}

export class CronScheduler {
  private readonly running = new Map<string, RunningJob>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeJobIds = new Set<string>();
  private readonly inFlightByJobId = new Map<string, AbortController>();
  private readonly store: CronStore;
  private readonly executor: CronExecutor;
  private readonly stateDir: string;
  private readonly instanceName?: string;
  private readonly logger: Pick<Console, "error" | "warn">;
  private readonly timeoutMsPerMinute: number;
  private readonly onJobFailure?: CronFailureHandler;
  private stopped = false;

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.stateDir = options.stateDir;
    this.instanceName = options.instanceName;
    this.logger = options.logger ?? console;
    this.timeoutMsPerMinute = options.timeoutMsPerMinute ?? 60_000;
    this.onJobFailure = options.onJobFailure;
  }

  /** Load all jobs from the store and schedule the enabled ones. */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("CronScheduler has already been stopped");
    }
    const jobs = await this.store.list();
    for (const job of jobs) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Re-read the store and reconcile in-memory schedules with persisted state.
   * Use this after CRUD operations from the helper server / Telegram commands.
   */
  async refresh(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const jobs = await this.store.list();
    const seen = new Set<string>();
    for (const job of jobs) {
      seen.add(job.id);
      if (job.enabled) {
        this.scheduleJob(job);
      } else {
        this.unscheduleJob(job.id);
      }
    }
    for (const id of [...this.running.keys()]) {
      if (!seen.has(id)) {
        this.unscheduleJob(id);
      }
    }
  }

  scheduleJob(job: CronJobRecord): void {
    if (this.stopped) {
      return;
    }
    this.unscheduleJob(job.id);
    if (job.runOnce) {
      this.scheduleRunOnceJob(job);
      return;
    }
    if (validateCronExpression(job.cronExpr) === null) {
      this.logger.warn(`cron: skipping job ${job.id} with invalid expression "${job.cronExpr}"`);
      return;
    }
    const cron = new Cron(job.cronExpr, () => {
      void this.runJob(job.id);
    });
    this.running.set(job.id, { stop: () => cron.stop() });
  }

  unscheduleJob(id: string): void {
    const entry = this.running.get(id);
    if (!entry) {
      return;
    }
    entry.stop();
    this.running.delete(id);
  }

  /**
   * Stop all timers and wait up to {@link SHUTDOWN_DRAIN_TIMEOUT_MS} for
   * currently-running jobs to finish. Pending fires are dropped.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.running.keys()]) {
      this.unscheduleJob(id);
    }
    for (const controller of this.inFlightByJobId.values()) {
      controller.abort();
    }
    if (this.inFlight.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
    ]);
  }

  /** Manually trigger a job by id. Used by `/cron run` and tests. */
  async runJobNow(id: string): Promise<void> {
    return this.runJob(id);
  }

  /** @internal — number of jobs currently scheduled (testing). */
  countScheduled(): number {
    return this.running.size;
  }

  private async runJob(id: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.activeJobIds.has(id)) {
      await this.appendSkippedAlreadyRunning(id);
      return;
    }
    this.activeJobIds.add(id);
    let trackedStarted = false;
    try {
      const job = await this.store.get(id);
      if (!job) {
        this.unscheduleJob(id);
        return;
      }
      if (!job.enabled) {
        return;
      }
      if (this.stopped) {
        return;
      }

      const ranAt = new Date().toISOString();
      await appendTimelineEventBestEffort(this.stateDir, {
        type: "cron.triggered",
        instanceName: this.instanceName,
        channel: "telegram",
        chatId: job.chatId,
        userId: job.userId,
        metadata: {
          cronJobId: job.id,
          cronExpr: job.cronExpr,
          sessionMode: job.sessionMode,
          mute: job.mute,
        },
      });

      const controller = new AbortController();
      this.inFlightByJobId.set(id, controller);
      const tracked = this.executeWithTracking(job, controller);
      trackedStarted = true;
      const finished = tracked.finished.catch(() => undefined).finally(() => {
        this.activeJobIds.delete(id);
        if (this.inFlightByJobId.get(id) === controller) {
          this.inFlightByJobId.delete(id);
        }
        this.inFlight.delete(finished);
      });
      this.inFlight.add(finished);
      try {
        await tracked.reported;
        await this.store.recordRun(id, { success: true, ranAt });
        await appendTimelineEventBestEffort(this.stateDir, {
          type: "cron.completed",
          instanceName: this.instanceName,
          channel: "telegram",
          chatId: job.chatId,
          userId: job.userId,
          outcome: "success",
          metadata: { cronJobId: job.id },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`cron: job ${id} failed: ${message}`);
        const failedRecord = await this.store.recordRun(id, { success: false, error: message, ranAt });
        await appendTimelineEventBestEffort(this.stateDir, {
          type: "cron.completed",
          instanceName: this.instanceName,
          channel: "telegram",
          chatId: job.chatId,
          userId: job.userId,
          outcome: "error",
          detail: message,
          metadata: { cronJobId: job.id },
        });
        if (failedRecord && !failedRecord.runOnce && failedRecord.failureCount >= failedRecord.maxFailures) {
          await this.disableAfterFailures(failedRecord);
        }
        await appendAuditEventBestEffort(this.stateDir, {
          type: "cron.failed",
          instanceName: this.instanceName,
          chatId: job.chatId,
          userId: job.userId,
          outcome: "error",
          detail: message,
          metadata: { cronJobId: job.id },
        });
        await this.notifyJobFailure(job, message);
      } finally {
        if (job.runOnce) {
          await this.store.update(id, { enabled: false });
          this.unscheduleJob(id);
        }
        if (tracked.reported === tracked.finished && this.inFlightByJobId.get(id) === controller) {
          this.inFlightByJobId.delete(id);
        }
      }
    } finally {
      if (!trackedStarted) {
        this.activeJobIds.delete(id);
      }
    }
  }

  private async appendSkippedAlreadyRunning(id: string): Promise<void> {
    const job = await this.store.get(id);
    await appendTimelineEventBestEffort(this.stateDir, {
      type: "cron.skipped",
      instanceName: this.instanceName,
      channel: "telegram",
      chatId: job?.chatId,
      userId: job?.userId,
      outcome: "skipped",
      detail: "cron job is already running",
      metadata: { cronJobId: id, reason: "already_running" },
    });
  }

  private async notifyJobFailure(job: CronJobRecord, message: string): Promise<void> {
    if (!this.onJobFailure) {
      return;
    }
    try {
      await this.onJobFailure(job, message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`cron: failed to notify job ${job.id} failure: ${detail}`);
      await appendTimelineEventBestEffort(this.stateDir, {
        type: "cron.failure_notification_failed",
        instanceName: this.instanceName,
        channel: "telegram",
        chatId: job.chatId,
        userId: job.userId,
        outcome: "error",
        detail,
        metadata: { cronJobId: job.id },
      });
    }
  }

  private async disableAfterFailures(job: CronJobRecord): Promise<void> {
    try {
      await this.store.update(job.id, { enabled: false });
      this.unscheduleJob(job.id);
      await appendTimelineEventBestEffort(this.stateDir, {
        type: "cron.disabled_after_failures",
        instanceName: this.instanceName,
        channel: "telegram",
        chatId: job.chatId,
        userId: job.userId,
        outcome: "disabled",
        detail: `cron job disabled after ${job.failureCount} consecutive failure(s)`,
        metadata: {
          cronJobId: job.id,
          failureCount: job.failureCount,
          maxFailures: job.maxFailures,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`cron: failed to disable job ${job.id} after max failures: ${detail}`);
      await appendTimelineEventBestEffort(this.stateDir, {
        type: "cron.disabled_after_failures",
        instanceName: this.instanceName,
        channel: "telegram",
        chatId: job.chatId,
        userId: job.userId,
        outcome: "error",
        detail: `failed to disable cron job after max failures: ${detail}`,
        metadata: {
          cronJobId: job.id,
          failureCount: job.failureCount,
          maxFailures: job.maxFailures,
        },
      });
    }
  }

  private scheduleRunOnceJob(job: CronJobRecord): void {
    if (!job.targetAt) {
      this.logger.warn(`cron: skipping one-shot job ${job.id} without targetAt`);
      return;
    }
    const targetMs = new Date(job.targetAt).getTime();
    if (Number.isNaN(targetMs)) {
      this.logger.warn(`cron: skipping one-shot job ${job.id} with invalid targetAt "${job.targetAt}"`);
      return;
    }
    const delay = Math.max(0, targetMs - Date.now());
    const timer = setTimeout(() => {
      if (delay > MAX_TIMEOUT_DELAY_MS) {
        this.scheduleJob(job);
        return;
      }
      void this.runJob(job.id);
    }, Math.min(delay, MAX_TIMEOUT_DELAY_MS));
    timer.unref?.();
    this.running.set(job.id, { stop: () => clearTimeout(timer) });
  }

  private executeWithTracking(
    job: CronJobRecord,
    controller: AbortController,
  ): { reported: Promise<void>; finished: Promise<void> } {
    const timeoutMs = job.timeoutMins > 0 ? job.timeoutMins * this.timeoutMsPerMinute : 0;
    const execution = Promise.resolve().then(() => this.executor(job, controller.signal));
    if (timeoutMs <= 0) {
      return { reported: execution, finished: execution };
    }
    let timedOut = false;
    const reported = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`cron job timed out after ${job.timeoutMins} minute(s)`));
      }, timeoutMs);
      execution.then(
        (value) => {
          if (timedOut) {
            return;
          }
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (timedOut) {
            return;
          }
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    return { reported, finished: execution };
  }
}
