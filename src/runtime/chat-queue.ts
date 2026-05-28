export interface ChatQueueWaitEvent {
  chatId: string | number;
  waitedMs: number;
  reason: "conversation_queue";
}

export class ChatQueue {
  private readonly queues = new Map<string | number, Promise<unknown>>();
  private readonly generations = new Map<string | number, number>();
  private readonly pendingCounts = new Map<string | number, number>();

  enqueue<T>(
    chatId: string | number,
    job: () => Promise<T>,
    options: {
      onSkipped?: () => T | Promise<T>;
      waitNotifyAfterMs?: number;
      onWait?: (event: ChatQueueWaitEvent) => void | Promise<void>;
    } = {},
  ): Promise<T> {
    const queuedAt = Date.now();
    const existing = this.queues.get(chatId);
    const previous = existing ?? Promise.resolve();
    const generation = this.generations.get(chatId) ?? 0;
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

      if ((this.generations.get(chatId) ?? 0) !== generation) {
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

  isBusy(chatId: string | number): boolean {
    return this.queues.has(chatId);
  }
}
