import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildLarkCronExecutor } from "../src/lark/cron.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("Lark cron executor", () => {
  it("treats budget exhaustion as a clean block instead of a scheduler failure", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-budget-"));
    const store = new CronStore(stateDir);
    const channel = {
      send: vi.fn().mockResolvedValue({ messageId: "om_budget" }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "should not run" }),
    };
    const onJobFailure = vi.fn().mockResolvedValue(undefined);

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ budgetUsd: 0.5 }), "utf8");
      await writeFile(path.join(stateDir, "usage.json"), JSON.stringify({
        totalInputTokens: 1,
        totalOutputTokens: 1,
        totalCachedTokens: 0,
        totalCostUsd: 0.5,
        requestCount: 1,
        lastUpdatedAt: "2026-06-12T00:00:00.000Z",
      }), "utf8");
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "daily brief",
        larkChatId: "oc_lark",
        conversationKey: "lark:oc_lark",
        locale: "en",
        maxFailures: 1,
      });
      const scheduler = new CronScheduler({
        store,
        executor: buildLarkCronExecutor({
          channel: channel as never,
          bridge: bridge as never,
          runtime: {} as never,
          stateDir,
        }),
        stateDir,
        onJobFailure,
      });

      try {
        await scheduler.runJobNow(job.id);
      } finally {
        await scheduler.stop();
      }

      const reloaded = await store.get(job.id);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_lark",
        expect.objectContaining({ markdown: expect.stringContaining("Budget exhausted") }),
        {},
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(onJobFailure).not.toHaveBeenCalled();
      expect(reloaded?.enabled).toBe(true);
      expect(reloaded?.failureCount).toBe(0);
      expect(reloaded?.lastError).toBeUndefined();
      expect(reloaded?.lastSuccessAt).toBeDefined();
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
