import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CronStore, resolveCronStorePath } from "../src/state/cron-store.js";

async function withStateDir<T>(fn: (stateDir: string, store: CronStore) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-store-"));
  try {
    const store = new CronStore(tempDir);
    return await fn(tempDir, store);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("CronStore", () => {
  it("starts with an empty list when the file is missing", async () => {
    await withStateDir(async (_dir, store) => {
      await expect(store.list()).resolves.toEqual([]);
    });
  });

  it("adds a job and returns a normalized record with defaults", async () => {
    await withStateDir(async (stateDir, store) => {
      const record = await store.add({
        chatId: 100,
        userId: 200,
        cronExpr: "0 9 * * *",
        prompt: "morning summary",
      });
      expect(record.id).toMatch(/^[a-f0-9]{8}$/);
      expect(record.enabled).toBe(true);
      expect(record.timezone).toBeDefined();
      expect(record.sessionMode).toBe("reuse");
      expect(record.mute).toBe(false);
      expect(record.silent).toBe(false);
      expect(record.timeoutMins).toBe(30);
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBe(record.createdAt);
      expect(record.lastRunAt).toBeUndefined();
      expect(record.lastSuccessAt).toBeUndefined();
      expect(record.lastError).toBeUndefined();

      const filePath = resolveCronStorePath(stateDir);
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as { jobs: unknown[]; schemaVersion: number };
      expect(persisted.jobs).toHaveLength(1);
      expect(persisted.schemaVersion).toBeGreaterThan(0);
    });
  });

  it("filters jobs by chat", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      await store.add({ chatId: 2, userId: 20, cronExpr: "* * * * *", prompt: "b" });
      const out = await store.listByChat(1);
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe(a.id);
    });
  });

  it("removes a job by id (idempotent)", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      await expect(store.remove(a.id)).resolves.toBe(true);
      await expect(store.remove(a.id)).resolves.toBe(false);
      await expect(store.list()).resolves.toEqual([]);
    });
  });

  it("updates fields and bumps updatedAt", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      await new Promise((r) => setTimeout(r, 10));
      const updated = await store.update(a.id, { cronExpr: "*/5 * * * *", prompt: "b", description: "every 5 min" });
      expect(updated).not.toBeNull();
      expect(updated!.cronExpr).toBe("*/5 * * * *");
      expect(updated!.prompt).toBe("b");
      expect(updated!.description).toBe("every 5 min");
      expect(updated!.updatedAt).not.toBe(a.updatedAt);
      expect(updated!.createdAt).toBe(a.createdAt);
    });
  });

  it("clears description when patched with null", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a", description: "x" });
      const updated = await store.update(a.id, { description: null });
      expect(updated!.description).toBeUndefined();
    });
  });

  it("toggleEnabled flips the flag and persists", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      const off = await store.toggleEnabled(a.id);
      expect(off!.enabled).toBe(false);
      const on = await store.toggleEnabled(a.id);
      expect(on!.enabled).toBe(true);
    });
  });

  it("recordRun success clears lastError and sets lastSuccessAt", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      const ran = await store.recordRun(a.id, { success: true, ranAt: "2026-04-28T10:00:00.000Z" });
      expect(ran!.lastRunAt).toBe("2026-04-28T10:00:00.000Z");
      expect(ran!.lastSuccessAt).toBe("2026-04-28T10:00:00.000Z");
      expect(ran!.lastError).toBeUndefined();
    });
  });

  it("recordRun failure sets lastError but preserves lastSuccessAt", async () => {
    await withStateDir(async (_dir, store) => {
      const a = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });
      await store.recordRun(a.id, { success: true, ranAt: "2026-04-28T10:00:00.000Z" });
      const failed = await store.recordRun(a.id, { success: false, error: "boom", ranAt: "2026-04-28T11:00:00.000Z" });
      expect(failed!.lastRunAt).toBe("2026-04-28T11:00:00.000Z");
      expect(failed!.lastSuccessAt).toBe("2026-04-28T10:00:00.000Z");
      expect(failed!.lastError).toBe("boom");
    });
  });

  it("tracks consecutive failures and capped run history", async () => {
    await withStateDir(async (_dir, store) => {
      const job = await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "a" });

      for (let index = 0; index < 12; index++) {
        await store.recordRun(job.id, {
          success: false,
          error: `boom-${index}`,
          ranAt: `2026-04-28T11:${String(index).padStart(2, "0")}:00.000Z`,
        });
      }

      const failed = await store.get(job.id);
      expect(failed?.failureCount).toBe(12);
      expect(failed?.runHistory).toHaveLength(10);
      expect(failed?.runHistory?.[0]).toEqual({
        ranAt: "2026-04-28T11:02:00.000Z",
        success: false,
        error: "boom-2",
      });

      const succeeded = await store.recordRun(job.id, { success: true, ranAt: "2026-04-28T12:00:00.000Z" });
      expect(succeeded?.failureCount).toBe(0);
      expect(succeeded?.runHistory?.at(-1)).toEqual({
        ranAt: "2026-04-28T12:00:00.000Z",
        success: true,
      });
    });
  });

  it("rejects an invalid cron expression length", async () => {
    await withStateDir(async (_dir, store) => {
      const tooLong = "x".repeat(200);
      await expect(store.add({ chatId: 1, userId: 10, cronExpr: tooLong, prompt: "a" })).rejects.toThrow();
    });
  });

  it("rejects empty prompt and oversize prompt", async () => {
    await withStateDir(async (_dir, store) => {
      await expect(store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "" })).rejects.toThrow();
      await expect(
        store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "x".repeat(4001) }),
      ).rejects.toThrow();
    });
  });

  it("caps enabled jobs per chat while allowing other chats and disabled jobs", async () => {
    await withStateDir(async (_dir, store) => {
      for (let index = 0; index < 50; index++) {
        await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: `p${index}` });
      }

      await expect(store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "overflow" })).rejects.toThrow(
        "maximum enabled cron jobs per chat",
      );
      await expect(store.add({ chatId: 2, userId: 10, cronExpr: "* * * * *", prompt: "other chat" })).resolves.toMatchObject({
        chatId: 2,
      });
      await expect(
        store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: "disabled", enabled: false }),
      ).resolves.toMatchObject({ enabled: false });
    });
  });

  it("enforces the per-chat cap when enabling a disabled job", async () => {
    await withStateDir(async (_dir, store) => {
      const disabled = await store.add({
        chatId: 1,
        userId: 10,
        cronExpr: "* * * * *",
        prompt: "disabled",
        enabled: false,
      });
      for (let index = 0; index < 50; index++) {
        await store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: `p${index}` });
      }

      await expect(store.update(disabled.id, { enabled: true })).rejects.toThrow("maximum enabled cron jobs per chat");
    });
  });

  it("serializes concurrent writes (no lost updates)", async () => {
    await withStateDir(async (_dir, store) => {
      const adds = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: `p${i}` }),
        ),
      );
      const ids = new Set(adds.map((j) => j.id));
      expect(ids.size).toBe(10);
      await expect(store.list()).resolves.toHaveLength(10);
    });
  });

  it("serializes writes across store instances that share the same file", async () => {
    await withStateDir(async (stateDir, store) => {
      const adds = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const isolatedStore = new CronStore(stateDir);
          return isolatedStore.add({ chatId: 1, userId: 10, cronExpr: "* * * * *", prompt: `shared-${i}` });
        }),
      );
      const ids = new Set(adds.map((job) => job.id));
      expect(ids.size).toBe(20);
      await expect(store.list()).resolves.toHaveLength(20);
    });
  });

  it("persists the configured default timezone for new jobs", async () => {
    await withStateDir(async (stateDir) => {
      const store = new CronStore(stateDir, { defaultTimezone: "Asia/Shanghai" });

      const record = await store.add({ chatId: 1, userId: 10, cronExpr: "0 9 * * *", prompt: "morning" });

      expect(record.timezone).toBe("Asia/Shanghai");
      await expect(store.get(record.id)).resolves.toMatchObject({ timezone: "Asia/Shanghai" });
    });
  });

  it("applies the configured default timezone to legacy jobs without a timezone", async () => {
    await withStateDir(async (stateDir) => {
      const filePath = resolveCronStorePath(stateDir);
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          jobs: [{
            id: "abcd1234",
            chatId: 1,
            userId: 10,
            chatType: "private",
            cronExpr: "0 9 * * *",
            prompt: "legacy",
            enabled: true,
            runOnce: false,
            sessionMode: "reuse",
            mute: false,
            silent: false,
            timeoutMins: 30,
            maxFailures: 3,
            createdAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:00:00.000Z",
            failureCount: 0,
            runHistory: [],
          }],
        }),
        "utf8",
      );
      const store = new CronStore(stateDir, { defaultTimezone: "Asia/Shanghai" });

      await expect(store.get("abcd1234")).resolves.toMatchObject({ timezone: "Asia/Shanghai" });
    });
  });
});
