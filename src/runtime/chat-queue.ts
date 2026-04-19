export class ChatQueue {
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly generations = new Map<number, number>();
  private readonly pendingCounts = new Map<number, number>();

  enqueue<T>(chatId: number, job: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const generation = this.generations.get(chatId) ?? 0;
    this.pendingCounts.set(chatId, (this.pendingCounts.get(chatId) ?? 0) + 1);
    const run = previous.catch(() => undefined).then(async () => {
      const remainingPending = Math.max(0, (this.pendingCounts.get(chatId) ?? 1) - 1);
      if (remainingPending > 0) {
        this.pendingCounts.set(chatId, remainingPending);
      } else {
        this.pendingCounts.delete(chatId);
      }

      if ((this.generations.get(chatId) ?? 0) !== generation) {
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

  clearPending(chatId: number): boolean {
    const hadPending = (this.pendingCounts.get(chatId) ?? 0) > 0;
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    return hadPending;
  }
}
