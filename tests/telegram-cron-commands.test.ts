import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCronCommand,
  isCronCommand,
  type CronCommandContext,
} from "../src/telegram/cron-commands.js";
import { CronStore } from "../src/state/cron-store.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";

const CHAT_ID = 1001;
const USER_ID = 9001;

interface Harness {
  stateDir: string;
  store: CronStore;
  scheduler: CronScheduler;
  api: { sendMessage: ReturnType<typeof vi.fn> };
  executor: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-cmd-"));
  const store = new CronStore(stateDir);
  const executor = vi.fn().mockResolvedValue(undefined);
  const scheduler = new CronScheduler({
    store,
    executor,
    stateDir,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  };

  return {
    stateDir,
    store,
    scheduler,
    api,
    executor,
    cleanup: async () => {
      await scheduler.stop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

function makeContext(h: Harness, locale: "zh" | "en" = "en"): CronCommandContext {
  return {
    api: h.api,
    store: h.store,
    scheduler: h.scheduler,
    chatId: CHAT_ID,
    userId: USER_ID,
    locale,
  };
}

describe("isCronCommand", () => {
  it("matches /cron variants", () => {
    expect(isCronCommand("/cron")).toBe(true);
    expect(isCronCommand("/cron list")).toBe(true);
    expect(isCronCommand("/cron@mybot add 0 9 * * * test")).toBe(true);
    expect(isCronCommand("  /cron  ")).toBe(true);
  });

  it("does not match unrelated", () => {
    expect(isCronCommand("/cronjob")).toBe(false);
    expect(isCronCommand("hello /cron")).toBe(false);
    expect(isCronCommand("/help")).toBe(false);
  });
});

describe("handleCronCommand", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  describe("list", () => {
    it("prints empty hint when no jobs (en)", async () => {
      const result = await handleCronCommand("/cron", makeContext(h, "en"));
      expect(result.handled).toBe(true);
      expect(result.subcommand).toBe("list");
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("No scheduled tasks"),
      );
    });

    it("prints empty hint when no jobs (zh)", async () => {
      await handleCronCommand("/cron list", makeContext(h, "zh"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("暂无定时任务"),
      );
    });

    it("renders multiple jobs", async () => {
      const a = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "0 9 * * *",
        prompt: "morning summary",
      });
      const b = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "*/5 * * * *",
        prompt: "every five",
      });

      await handleCronCommand("/cron", makeContext(h, "en"));
      const msg = h.api.sendMessage.mock.calls[0]![1] as string;
      expect(msg).toContain("2 scheduled tasks");
      expect(msg).toContain(a.id);
      expect(msg).toContain(b.id);
      expect(msg).toContain("morning summary");
      expect(msg).toContain("every five");
      expect(msg).toContain("daily 09:00");
    });

    it("renders one-shot jobs with the target time instead of cron internals", async () => {
      const targetAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "0 9 * * *",
        prompt: "drink water",
        runOnce: true,
        targetAt,
      });

      await handleCronCommand("/cron", makeContext(h, "en"));
      const msg = h.api.sendMessage.mock.calls[0]![1] as string;
      expect(msg).toContain("once");
      expect(msg).toContain(targetAt);
      expect(msg).not.toContain("daily 09:00");
    });

    it("filters by chat id (does not show jobs from other chats)", async () => {
      await h.store.add({
        chatId: 9999,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "other chat",
      });
      await handleCronCommand("/cron", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("No scheduled tasks"),
      );
    });
  });

  describe("add", () => {
    it("adds a valid job", async () => {
      await handleCronCommand("/cron add 0 9 * * * morning summary", makeContext(h, "en"));
      const jobs = await h.store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.cronExpr).toBe("0 9 * * *");
      expect(jobs[0]!.prompt).toBe("morning summary");
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringMatching(/Added task/),
      );
    });

    it("rejects invalid cron expression and does not write", async () => {
      await handleCronCommand("/cron add not a real cron expr prompt", makeContext(h, "en"));
      const jobs = await h.store.list();
      expect(jobs).toHaveLength(0);
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Invalid cron expression"),
      );
    });

    it("requires both expression and prompt", async () => {
      await handleCronCommand("/cron add", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Usage:"),
      );
      expect(await h.store.list()).toHaveLength(0);
    });

    it("zh locale uses chinese error message", async () => {
      await handleCronCommand("/cron add bad bad bad bad bad prompt-text", makeContext(h, "zh"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("无效的 cron 表达式"),
      );
    });
  });

  describe("rm", () => {
    it("removes an existing job", async () => {
      const job = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "p",
      });
      await handleCronCommand(`/cron rm ${job.id}`, makeContext(h, "en"));
      expect(await h.store.list()).toHaveLength(0);
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Removed task"),
      );
    });

    it("supports delete and del aliases", async () => {
      const a = await h.store.add({ chatId: CHAT_ID, userId: USER_ID, cronExpr: "* * * * *", prompt: "a" });
      const b = await h.store.add({ chatId: CHAT_ID, userId: USER_ID, cronExpr: "* * * * *", prompt: "b" });
      await handleCronCommand(`/cron delete ${a.id}`, makeContext(h, "en"));
      await handleCronCommand(`/cron del ${b.id}`, makeContext(h, "en"));
      expect(await h.store.list()).toHaveLength(0);
    });

    it("returns not-found for unknown id", async () => {
      await handleCronCommand("/cron rm deadbeef", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Task not found"),
      );
    });

    it("rejects malformed id", async () => {
      await handleCronCommand("/cron rm xyz", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Invalid ID"),
      );
    });

    it("does not remove a job that belongs to a different chat", async () => {
      const other = await h.store.add({
        chatId: 9999,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "x",
      });
      await handleCronCommand(`/cron rm ${other.id}`, makeContext(h, "en"));
      expect(await h.store.list()).toHaveLength(1);
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Task not found"),
      );
    });
  });

  describe("toggle", () => {
    it("flips enabled flag", async () => {
      const job = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "p",
      });
      expect(job.enabled).toBe(true);
      await handleCronCommand(`/cron toggle ${job.id}`, makeContext(h, "en"));
      const after = await h.store.get(job.id);
      expect(after!.enabled).toBe(false);
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("disabled"),
      );

      h.api.sendMessage.mockClear();
      await handleCronCommand(`/cron toggle ${job.id}`, makeContext(h, "en"));
      const reEnabled = await h.store.get(job.id);
      expect(reEnabled!.enabled).toBe(true);
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("enabled"),
      );
    });

    it("not-found for unknown id", async () => {
      await handleCronCommand("/cron toggle deadbeef", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Task not found"),
      );
    });
  });

  describe("run", () => {
    it("returns promptly even when the queued run has not completed yet", async () => {
      const job = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "run me",
      });
      vi.spyOn(h.scheduler, "runJobNow").mockImplementationOnce(() => new Promise(() => {}));

      const result = await Promise.race([
        handleCronCommand(`/cron run ${job.id}`, makeContext(h, "en")).then(() => "done"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
      ]);

      expect(result).toBe("done");
      const messages = h.api.sendMessage.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes("Running task"))).toBe(true);
      expect(messages.some((m) => m.includes("triggered"))).toBe(true);
    });

    it("invokes scheduler.runJobNow which calls executor", async () => {
      const job = await h.store.add({
        chatId: CHAT_ID,
        userId: USER_ID,
        cronExpr: "* * * * *",
        prompt: "run me",
      });
      await handleCronCommand(`/cron run ${job.id}`, makeContext(h, "en"));
      await vi.waitFor(() => {
        expect(h.executor).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(async () => {
        await expect(h.store.get(job.id)).resolves.toEqual(expect.objectContaining({
          runHistory: expect.arrayContaining([expect.objectContaining({ success: true })]),
        }));
      });
      const messages = h.api.sendMessage.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes("Running task"))).toBe(true);
      expect(messages.some((m) => m.includes("triggered"))).toBe(true);
    });

    it("not-found for unknown id and does not call executor", async () => {
      await handleCronCommand("/cron run deadbeef", makeContext(h, "en"));
      expect(h.executor).not.toHaveBeenCalled();
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Task not found"),
      );
    });
  });

  describe("help and unknown", () => {
    it("/cron help prints usage (en)", async () => {
      await handleCronCommand("/cron help", makeContext(h, "en"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("/cron command usage"),
      );
    });

    it("/cron help prints usage (zh)", async () => {
      await handleCronCommand("/cron help", makeContext(h, "zh"));
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("/cron 命令用法"),
      );
    });

    it("unknown subcommand falls back to help text", async () => {
      const result = await handleCronCommand("/cron whoknows", makeContext(h, "en"));
      expect(result.handled).toBe(true);
      expect(result.subcommand).toBe("unknown");
      expect(h.api.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("Unknown subcommand"),
      );
    });
  });

  it("returns handled:false for non-cron text", async () => {
    const result = await handleCronCommand("/help", makeContext(h, "en"));
    expect(result.handled).toBe(false);
    expect(h.api.sendMessage).not.toHaveBeenCalled();
  });
});
