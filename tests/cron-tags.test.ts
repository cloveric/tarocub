import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import { extractCronAddTagMatches, processCronAddTags } from "../src/telegram/cron-tags.js";

async function withCronRuntime<T>(fn: (ctx: { stateDir: string; store: CronStore; scheduler: CronScheduler }) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-tags-"));
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

describe("cron-add fallback tags", () => {
  it("ignores tags inside markdown code", () => {
    const text = [
      "Example:",
      "```",
      '[cron-add:{"in":"10m","prompt":"inside"}]',
      "```",
      '[cron-add:{"in":"10m","prompt":"outside"}]',
    ].join("\n");

    const matches = extractCronAddTagMatches(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.payload).toContain("outside");
  });

  it("ignores tags inside tilde fenced markdown code", () => {
    const text = [
      "Example:",
      "~~~",
      '[cron-add:{"in":"10m","prompt":"inside"}]',
      "~~~",
      '[cron-add:{"in":"10m","prompt":"outside"}]',
    ].join("\n");

    const matches = extractCronAddTagMatches(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.payload).toContain("outside");
  });

  it("does not let payload chat ids override the current Telegram context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withCronRuntime(async ({ stateDir, store, scheduler }) => {
        await processCronAddTags({
          text: '[cron-add:{"in":"10m","prompt":"check","chatId":999,"userId":999}]',
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          chatType: "private",
          locale: "en",
        });

        const jobs = await store.list();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toEqual(expect.objectContaining({
          chatId: 123,
          userId: 456,
          prompt: "check",
          targetAt: "2026-04-29T05:10:00.000Z",
        }));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects payloads that specify more than one schedule mode", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const text = await processCronAddTags({
        text: '[cron-add:{"in":"10m","cron":"0 9 * * *","prompt":"check"}]',
        cronRuntime: { store, scheduler },
        stateDir,
        chatId: 123,
        userId: 456,
        locale: "en",
      });

      expect(await store.list()).toHaveLength(0);
      expect(text).toContain("Failed to add scheduled task");
      expect(text).not.toContain("[cron-add:");
    });
  });

  it("processes multiple tags in one response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withCronRuntime(async ({ stateDir, store, scheduler }) => {
        const text = await processCronAddTags({
          text: [
            "Scheduled:",
            '[cron-add:{"in":"10m","prompt":"first"}]',
            '[cron-add:{"cron":"0 9 * * 1","prompt":"weekly","description":"Weekly summary"}]',
          ].join("\n"),
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        });

        const jobs = await store.list();
        expect(jobs).toHaveLength(2);
        expect(jobs.map((job) => job.prompt).sort()).toEqual(["first", "weekly"]);
        expect(text).not.toContain("[cron-add:");
        expect(text.match(/Scheduled task added/g)).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects missing prompts without creating a job", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const text = await processCronAddTags({
        text: '[cron-add:{"in":"10m"}]',
        cronRuntime: { store, scheduler },
        stateDir,
        chatId: 123,
        userId: 456,
        locale: "en",
      });

      expect(await store.list()).toHaveLength(0);
      expect(text).toContain("Invalid tool payload");
      expect(text).toContain("missing required field: prompt");
      expect(text).not.toContain("[cron-add:");
    });
  });

  it("leaves text unchanged when there are no cron-add tags", async () => {
    await withCronRuntime(async ({ stateDir, store, scheduler }) => {
      const text = "nothing to schedule";
      await expect(processCronAddTags({
        text,
        cronRuntime: { store, scheduler },
        stateDir,
        chatId: 123,
        userId: 456,
        locale: "en",
      })).resolves.toBe(text);
    });
  });

  it("preserves backticks inside JSON payload strings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withCronRuntime(async ({ stateDir, store, scheduler }) => {
        const text = await processCronAddTags({
          text: '[cron-add:{"in":"10m","prompt":"check `x`"}]',
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        });

        const jobs = await store.list();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.prompt).toBe("check `x`");
        expect(text).not.toContain("[cron-add:");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves closing brackets inside JSON payload strings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withCronRuntime(async ({ stateDir, store, scheduler }) => {
        const text = await processCronAddTags({
          text: '[cron-add:{"in":"10m","prompt":"check ] bracket"}]',
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        });

        const jobs = await store.list();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.prompt).toBe("check ] bracket");
        expect(text).not.toContain("[cron-add:");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
