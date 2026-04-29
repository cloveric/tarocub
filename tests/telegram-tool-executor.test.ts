import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import { DEFAULT_INSTANCE_AGENT_INSTRUCTIONS } from "../src/commands/access.js";
import { executeTelegramTool } from "../src/tools/telegram-tool-executor.js";
import { defaultTelegramToolRegistry, TelegramToolRegistry } from "../src/tools/telegram-tool-registry.js";
import { extractTelegramToolTagMatches } from "../src/telegram/tool-tags.js";

async function withCronRuntime<T>(fn: (ctx: { stateDir: string; store: CronStore; scheduler: CronScheduler }) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-telegram-tools-"));
  const store = new CronStore(stateDir);
  const scheduler = new CronScheduler({
    store,
    executor: vi.fn(),
    stateDir,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  await scheduler.start();
  try {
    return await fn({ stateDir, store, scheduler });
  } finally {
    await scheduler.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("executeTelegramTool", () => {
  it("exposes registered tool definitions through the default registry", () => {
    const tools = defaultTelegramToolRegistry.list();
    expect(tools.map((tool) => tool.name)).toEqual([
      "send.file",
      "send.image",
      "send.batch",
      "cron.add",
      "cron.list",
      "cron.remove",
      "cron.toggle",
      "cron.run",
    ]);
    expect(tools.find((tool) => tool.name === "cron.add")?.inputSchema).toMatchObject({
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(tools.find((tool) => tool.name === "send.file")?.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("keeps generated agent examples backed by registered tool examples", () => {
    const tools = new Map(defaultTelegramToolRegistry.list().map((tool) => [tool.name, tool]));
    const encodedExamples = extractTelegramToolTagMatches(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS)
      .map((match) => JSON.parse(match.payload) as { name: string; payload: unknown });

    expect(encodedExamples.length).toBeGreaterThan(0);
    for (const example of encodedExamples) {
      const tool = tools.get(example.name) as { examples?: unknown[] } | undefined;
      expect(tool?.examples).toContainEqual(example.payload);
    }
  });

  it("executes cron.add through the shared tool layer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withCronRuntime(async ({ stateDir, store, scheduler }) => {
        const result = await executeTelegramTool({
          name: "cron.add",
          payload: { in: "10m", prompt: "check email", chatId: 999 },
          context: {
            cronRuntime: { store, scheduler },
            stateDir,
            chatId: 123,
            userId: 456,
            chatType: "private",
            locale: "en",
          },
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("Scheduled task added");
        const jobs = await store.list();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toEqual(expect.objectContaining({
          chatId: 123,
          userId: 456,
          locale: "en",
          prompt: "check email",
          targetAt: "2026-04-29T05:10:00.000Z",
        }));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a structured error for unknown tools", async () => {
    const result = await executeTelegramTool({
      name: "missing.tool",
      payload: {},
      context: {
        cronRuntime: null,
        stateDir: os.tmpdir(),
        chatId: 123,
        userId: 456,
        locale: "en",
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      message: "✗ Tool failed: unknown tool missing.tool",
      error: "unknown tool missing.tool",
    });
  });

  it("lists only current-chat cron jobs", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine" });
      await store.add({ chatId: 999, userId: 456, cronExpr: "0 10 * * *", prompt: "theirs" });

      const result = await executeTelegramTool({
        name: "cron.list",
        payload: {},
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("mine");
      expect(result.message).not.toContain("theirs");
    });
  });

  it("shows cron failure lifecycle state in cron.list", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const mine = await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine", maxFailures: 3 });
      await store.recordRun(mine.id, { success: false, error: "boom", ranAt: "2026-04-29T05:00:00.000Z" });

      const result = await executeTelegramTool({
        name: "cron.list",
        payload: {},
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("failures: 1/3");
      expect(result.message).toContain("recent: 2026-04-29T05:00:00.000Z failed: boom");
    });
  });

  it("removes current-chat cron jobs and refreshes the scheduler", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const refresh = vi.spyOn(scheduler, "refresh");
      const mine = await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine" });

      const result = await executeTelegramTool({
        name: "cron.remove",
        payload: { id: mine.id },
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(true);
      expect(await store.get(mine.id)).toBeNull();
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("refuses to remove another chat's cron job", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const theirs = await store.add({ chatId: 999, userId: 456, cronExpr: "0 9 * * *", prompt: "theirs" });

      const result = await executeTelegramTool({
        name: "cron.remove",
        payload: { id: theirs.id },
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Task not found");
      expect(await store.get(theirs.id)).not.toBeNull();
    });
  });

  it("toggles current-chat cron jobs", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const mine = await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine" });

      const result = await executeTelegramTool({
        name: "cron.toggle",
        payload: { id: mine.id },
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("disabled");
      expect((await store.get(mine.id))?.enabled).toBe(false);
    });
  });

  it("runs current-chat cron jobs on demand", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const runJobNow = vi.spyOn(scheduler, "runJobNow").mockResolvedValueOnce(undefined);
      const mine = await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine" });

      const result = await executeTelegramTool({
        name: "cron.run",
        payload: { id: mine.id },
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("triggered");
      expect(runJobNow).toHaveBeenCalledWith(mine.id);
    });
  });

  it("returns from cron.run before a queued execution completes", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const runJobNow = vi.spyOn(scheduler, "runJobNow").mockImplementationOnce(() => new Promise(() => {}));
      const mine = await store.add({ chatId: 123, userId: 456, cronExpr: "0 9 * * *", prompt: "mine" });

      const result = await Promise.race([
        executeTelegramTool({
          name: "cron.run",
          payload: { id: mine.id },
          context: {
            cronRuntime: { store, scheduler },
            stateDir,
            chatId: 123,
            userId: 456,
            locale: "en",
          },
        }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
      ]);

      expect(result).not.toBe("timeout");
      expect(runJobNow).toHaveBeenCalledWith(mine.id);
    });
  });

  it("can execute a custom tool through an explicit registry", async () => {
    const registry = new TelegramToolRegistry();
    registry.register({
      name: "test.echo",
      description: "Echoes a test payload.",
      execute: async (payload) => ({
        ok: true,
        message: `echo:${String(payload)}`,
      }),
    });

    await expect(executeTelegramTool({
      name: "test.echo",
      payload: "hello",
      context: {
        cronRuntime: null,
        stateDir: os.tmpdir(),
        chatId: 123,
        userId: 456,
        locale: "en",
      },
    }, registry)).resolves.toEqual({
      ok: true,
      message: "echo:hello",
    });
  });

  it("enforces string schema constraints before executing a tool", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: "ok" });
    const registry = new TelegramToolRegistry();
    registry.register({
      name: "test.schema",
      description: "Validates a strict schema.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", pattern: "^[A-Z]{3}$" },
          when: { type: "string", format: "date-time" },
          label: { type: "string", maxLength: 4 },
        },
        required: ["code", "when"],
        additionalProperties: false,
      },
      execute,
    });

    const result = await executeTelegramTool({
      name: "test.schema",
      payload: { code: "abc", when: "not-a-date", label: "toolong" },
      context: {
        cronRuntime: null,
        stateDir: os.tmpdir(),
        chatId: 123,
        userId: 456,
        locale: "en",
      },
    }, registry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("code");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate tool registrations", () => {
    const registry = new TelegramToolRegistry();
    registry.register({
      name: "test.echo",
      description: "Echoes a test payload.",
      execute: async () => ({ ok: true, message: "ok" }),
    });

    expect(() => registry.register({
      name: "test.echo",
      description: "Duplicate.",
      execute: async () => ({ ok: true, message: "duplicate" }),
    })).toThrow("tool already registered: test.echo");
  });
});
