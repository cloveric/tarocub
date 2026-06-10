export interface ChatQueueWaitEvent {
  chatId: string | number;
  waitedMs: number;
  reason: "conversation_queue";
}

export class ChatQueue {
  private readonly queues = new Map<string | number, Promise<unknown>>();
  private readonly generations = new Map<string | number, number>();
  private readonly pendingCounts = new Map<string | number, number>();
  // Per-conversation set of currently-queued task ids (for targeted cancel).
  private readonly pendingTaskIds = new Map<string | number, Set<string>>();
  private readonly cancelledTaskIds = new Map<string | number, Set<string>>();

  enqueue<T>(
    chatId: string | number,
    job: () => Promise<T>,
    options: {
      taskId?: string;
      onSkipped?: () => T | Promise<T>;
      waitNotifyAfterMs?: number;
      onWait?: (event: ChatQueueWaitEvent) => void | Promise<void>;
    } = {},
  ): Promise<T> {
    const queuedAt = Date.now();
    const existing = this.queues.get(chatId);
    const previous = existing ?? Promise.resolve();
    const generation = this.generations.get(chatId) ?? 0;
    const taskId = options.taskId;
    if (taskId) {
      const set = this.pendingTaskIds.get(chatId) ?? new Set<string>();
      set.add(taskId);
      this.pendingTaskIds.set(chatId, set);
    }
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    if (existing && options.onWait && options.waitNotifyAfterMs !== undefined && options.waitNotifyAfterMs >= 0) {
      waitTimer = setTimeout(() => {
        void Promise.resolve(options.onWait?.({
          chatId,
          waitedMs: Math.max(0, Date.now() - queuedAt),
          reason: "conversation_queue",
        })).catch(() => undefined);
      }, options.waitNotifyAfterMs);
    }
    this.pendingCounts.set(chatId, (this.pendingCounts.get(chatId) ?? 0) + 1);
    const run = previous.catch(() => undefined).then(async () => {
      if (waitTimer) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
      const remainingPending = Math.max(0, (this.pendingCounts.get(chatId) ?? 1) - 1);
      if (remainingPending > 0) {
        this.pendingCounts.set(chatId, remainingPending);
      } else {
        this.pendingCounts.delete(chatId);
      }
      // This task is starting (or about to be skipped): it is no longer pending,
      // so it can no longer be the target of a cancel().
      const wasCancelled = taskId ? this.consumePending(chatId, taskId) : false;

      if (wasCancelled || (this.generations.get(chatId) ?? 0) !== generation) {
        if (options.onSkipped) {
          return await options.onSkipped();
        }
        return undefined as T;
      }

      return await job();
    });

    this.queues.set(chatId, run);
    void run
      .finally(() => {
        if (this.queues.get(chatId) === run) {
          this.queues.delete(chatId);
        }
      })
      .catch(() => undefined);

    return run;
  }

  clearPending(chatId: string | number): boolean {
    const hadPending = (this.pendingCounts.get(chatId) ?? 0) > 0;
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    return hadPending;
  }

  /** Tasks queued behind the currently running one (the running task excluded). */
  pendingCount(chatId: string | number): number {
    return this.pendingCounts.get(chatId) ?? 0;
  }

  /**
   * Cancel a single still-queued task by id. Returns true only when the task is
   * currently pending (queued but not yet started); the task is then skipped
   * (its onSkipped runs) when its turn comes. Returns false if the task already
   * started, already finished, or was never enqueued with this id — in that
   * case the caller should fall back to aborting the active run.
   */
  cancel(chatId: string | number, taskId: string): boolean {
    if (!this.pendingTaskIds.get(chatId)?.has(taskId)) {
      return false;
    }
    const cancelled = this.cancelledTaskIds.get(chatId) ?? new Set<string>();
    cancelled.add(taskId);
    this.cancelledTaskIds.set(chatId, cancelled);
    return true;
  }

  /**
   * Remove a task id from the pending set as it starts, reporting whether it had
   * been cancelled in the meantime. Clears empty per-conversation sets so the
   * maps don't leak entries.
   */
  private consumePending(chatId: string | number, taskId: string): boolean {
    const pending = this.pendingTaskIds.get(chatId);
    if (pending) {
      pending.delete(taskId);
      if (pending.size === 0) {
        this.pendingTaskIds.delete(chatId);
      }
    }
    const cancelled = this.cancelledTaskIds.get(chatId);
    if (!cancelled?.has(taskId)) {
      return false;
    }
    cancelled.delete(taskId);
    if (cancelled.size === 0) {
      this.cancelledTaskIds.delete(chatId);
    }
    return true;
  }

  isBusy(chatId: string | number): boolean {
    return this.queues.has(chatId);
  }
}
