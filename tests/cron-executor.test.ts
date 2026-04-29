import { describe, expect, it, vi } from "vitest";

import { buildCronExecutor, sendCronFailureNotification } from "../src/runtime/cron-executor.js";
import type { CronJobRecord } from "../src/state/cron-store-schema.js";

function makeJob(overrides: Partial<CronJobRecord> = {}): CronJobRecord {
  const now = new Date().toISOString();
  return {
    id: "abcd1234",
    chatId: 100,
    userId: 200,
    chatType: "private",
    cronExpr: "0 9 * * *",
    prompt: "morning summary",
    enabled: true,
    runOnce: false,
    sessionMode: "reuse",
    mute: false,
    silent: false,
    timeoutMins: 30,
    maxFailures: 3,
    createdAt: now,
    updatedAt: now,
    failureCount: 0,
    runHistory: [],
    ...overrides,
  };
}

describe("buildCronExecutor", () => {
  it("invokes the handler with a synthetic NormalizedTelegramMessage", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const api = { sendMessage: vi.fn() } as never;
    const bridge = {} as never;
    const executor = buildCronExecutor({ api, bridge, inboxDir: "/tmp/inbox", handler });

    await executor(makeJob({ prompt: "do thing" }));

    expect(handler).toHaveBeenCalledTimes(1);
    const [normalized, context] = handler.mock.calls[0]!;
    expect(normalized).toMatchObject({
      chatId: 100,
      userId: 200,
      chatType: "private",
      text: "do thing",
      attachments: [],
    });
    expect(context).toMatchObject({
      api,
      bridge,
      inboxDir: "/tmp/inbox",
      updateId: undefined,
    });
  });

  it("replays the persisted chatType instead of hardcoding private", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const executor = buildCronExecutor({ api: {} as never, bridge: {} as never, inboxDir: "/tmp", handler });

    await executor(makeJob({ chatType: "supergroup" }));

    const [normalized] = handler.mock.calls[0]!;
    expect(normalized.chatType).toBe("supergroup");
  });

  it("does not pass an updateId (cron must not pollute Telegram watermark)", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const executor = buildCronExecutor({ api: {} as never, bridge: {} as never, inboxDir: "/tmp", handler });
    await executor(makeJob());
    const [, context] = handler.mock.calls[0]!;
    expect(context.updateId).toBeUndefined();
  });

  it("marks synthetic turns as cron-sourced so slash-like prompts run through the engine", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const executor = buildCronExecutor({ api: {} as never, bridge: {} as never, inboxDir: "/tmp", handler });

    await executor(makeJob({ prompt: "/cron list" }));

    const [normalized, context] = handler.mock.calls[0]!;
    expect(normalized.text).toBe("/cron list");
    expect(context.source).toBe("cron");
  });

  it("wraps api with mute proxy when job.mute is true", async () => {
    const realApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendChatAction: vi.fn(),
    };
    const handler = vi.fn(async (_normalized: unknown, ctx: { api: typeof realApi }) => {
      const reply = await ctx.api.sendMessage(123, "hello");
      expect(reply).toEqual({ message_id: 0 });
      const doc = await ctx.api.sendDocument(123, "x.txt", "data");
      expect(doc).toEqual({ message_id: 0 });
      const photo = await ctx.api.sendPhoto(123, "x.png", new Uint8Array());
      expect(photo).toEqual({ message_id: 0 });
      const action = await ctx.api.sendChatAction(123);
      expect(action).toBeUndefined();
    });
    const executor = buildCronExecutor({
      api: realApi as never,
      bridge: {} as never,
      inboxDir: "/tmp",
      handler: handler as never,
    });
    await executor(makeJob({ mute: true }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(realApi.sendMessage).not.toHaveBeenCalled();
    expect(realApi.sendDocument).not.toHaveBeenCalled();
    expect(realApi.sendPhoto).not.toHaveBeenCalled();
    expect(realApi.sendChatAction).not.toHaveBeenCalled();
  });

  it("wraps api with silent notification options when job.silent is true", async () => {
    const realApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 99 }),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    const handler = vi.fn(async (_normalized: unknown, ctx: { api: typeof realApi }) => {
      await ctx.api.sendMessage(123, "hello");
      await ctx.api.sendDocument(123, "x.txt", "data");
      await ctx.api.sendPhoto(123, "x.png", new Uint8Array());
      await ctx.api.sendMediaGroup(123, [{ filename: "x.png", contents: new Uint8Array() }]);
    });
    const executor = buildCronExecutor({
      api: realApi as never,
      bridge: {} as never,
      inboxDir: "/tmp",
      handler: handler as never,
    });
    await executor(makeJob({ silent: true }));

    expect(realApi.sendMessage).toHaveBeenCalledWith(123, "hello", { disableNotification: true });
    expect(realApi.sendDocument).toHaveBeenCalledWith(123, "x.txt", "data", { disableNotification: true });
    expect(realApi.sendPhoto).toHaveBeenCalledWith(123, "x.png", expect.any(Uint8Array), undefined, { disableNotification: true });
    expect(realApi.sendMediaGroup).toHaveBeenCalledWith(
      123,
      [{ filename: "x.png", contents: expect.any(Uint8Array) }],
      { disableNotification: true },
    );
  });

  it("uses the real api when job.mute is false", async () => {
    const realApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
    const handler = vi.fn(async (_normalized: unknown, ctx: { api: typeof realApi }) => {
      await ctx.api.sendMessage(123, "live");
    });
    const executor = buildCronExecutor({
      api: realApi as never,
      bridge: {} as never,
      inboxDir: "/tmp",
      handler: handler as never,
    });
    await executor(makeJob({ mute: false }));
    expect(realApi.sendMessage).toHaveBeenCalledWith(123, "live");
  });

  it("propagates handler errors so scheduler.recordRun can mark them", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("engine failed"));
    const executor = buildCronExecutor({ api: {} as never, bridge: {} as never, inboxDir: "/tmp", handler });
    await expect(executor(makeJob())).rejects.toThrow("engine failed");
  });

  it("passes abortSignal and an ephemeral session override for new_per_run jobs", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    const executor = buildCronExecutor({ api: {} as never, bridge: {} as never, inboxDir: "/tmp", handler });

    await executor(makeJob({ sessionMode: "new_per_run" }), signal);

    const [, context] = handler.mock.calls[0]!;
    expect(context.abortSignal).toBe(signal);
    expect(context.sessionIdOverride).toMatch(/^telegram-cron-abcd1234-/);
  });
});

describe("sendCronFailureNotification", () => {
  it("sends a localized failure message to the job chat", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    await sendCronFailureNotification(api, makeJob({ locale: "zh" }), "boom");

    expect(api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("定时任务执行失败"),
      undefined,
    );
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("boom");
  });

  it("uses disableNotification for silent jobs", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    await sendCronFailureNotification(api, makeJob({ silent: true }), "boom");

    expect(api.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Scheduled task failed"),
      { disableNotification: true },
    );
  });

  it("does not notify muted jobs", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    await sendCronFailureNotification(api, makeJob({ mute: true }), "boom");

    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
