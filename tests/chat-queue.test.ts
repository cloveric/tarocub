import { describe, expect, it, vi } from "vitest";

import { ChatQueue } from "../src/runtime/chat-queue.js";

describe("ChatQueue", () => {
  it("serializes jobs per chat", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue(1, async () => {
        events.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push("end-1");
      }),
      queue.enqueue(1, async () => {
        events.push("start-2");
        events.push("end-2");
      }),
    ]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("cleans up settled entries and keeps running after rejection", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    await queue
      .enqueue(1, async () => {
        events.push("reject-start");
        throw new Error("boom");
      })
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("boom");
        },
      );

    expect((queue as unknown as { queues: Map<number, unknown> }).queues.size).toBe(0);

    await queue.enqueue(1, async () => {
      events.push("recover-start");
    });

    expect(events).toEqual(["reject-start", "recover-start"]);
  });

  it("runs an already queued job after the active job rejects", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];
    let rejectFirst!: (error: Error) => void;
    const first = queue.enqueue("chat:1", async () => {
      events.push("first-start");
      await new Promise<never>((_resolve, reject) => {
        rejectFirst = reject;
      });
    });
    const second = queue.enqueue("chat:1", async () => {
      events.push("second-start");
      return "second-done";
    });

    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    rejectFirst(new Error("first failed"));

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second-done");
    expect(events).toEqual(["first-start", "second-start"]);
  });

  it("can reject skipped pending jobs after clearPending", async () => {
    const queue = new ChatQueue();
    let release!: () => void;
    const first = queue.enqueue(1, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = queue.enqueue(
      1,
      async () => "ran",
      { onSkipped: () => { throw new Error("skipped by stop"); } },
    );

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(queue.clearPending(1)).toBe(true);
    release();
    await first;
    await expect(second).rejects.toThrow("skipped by stop");
  });

  it("cancels a single queued task by id without skipping the others", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.enqueue("chat:1", async () => {
      events.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }, { taskId: "t1" });
    const second = queue.enqueue("chat:1", async () => {
      events.push("second");
    }, { taskId: "t2", onSkipped: () => { events.push("second-skipped"); } });
    const third = queue.enqueue("chat:1", async () => {
      events.push("third");
    }, { taskId: "t3" });

    await vi.waitFor(() => expect(release).toBeTypeOf("function")); // t1 is running
    expect(queue.cancel("chat:1", "t1")).toBe(false); // already started → not cancellable
    expect(queue.cancel("chat:1", "t2")).toBe(true); // still queued → cancellable
    expect(queue.cancel("chat:1", "nope")).toBe(false); // unknown id

    release();
    await Promise.all([first, second, third]);
    // t2 was skipped (its job never ran), t1 and t3 ran normally.
    expect(events).toEqual(["first", "second-skipped", "third"]);
    expect(queue.cancel("chat:1", "t2")).toBe(false); // already consumed
  });

  it("reports a key as busy while a job is running or queued", async () => {
    const queue = new ChatQueue();
    let release!: () => void;
    const first = queue.enqueue("chat:1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = queue.enqueue("chat:1", async () => "done");

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(queue.isBusy("chat:1")).toBe(true);
    release();
    await first;
    expect(queue.isBusy("chat:1")).toBe(true);
    await second;
    await vi.waitFor(() => expect(queue.isBusy("chat:1")).toBe(false));
  });

  it("notifies once when a job waits behind an active job", async () => {
    const queue = new ChatQueue();
    let release!: () => void;
    const onWait = vi.fn();
    const first = queue.enqueue("chat:1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = queue.enqueue("chat:1", async () => "done", {
      waitNotifyAfterMs: 1,
      onWait,
    });

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await vi.waitFor(() => expect(onWait).toHaveBeenCalledTimes(1));
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "chat:1",
      reason: "conversation_queue",
      waitedMs: expect.any(Number),
    }));

    release();
    await first;
    await expect(second).resolves.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
