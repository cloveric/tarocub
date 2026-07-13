import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildLarkCronExecutor } from "../src/lark/cron.js";
import { createLarkServiceRuntime } from "../src/lark/runtime.js";
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
          runtime: createLarkServiceRuntime(),
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

  it("registers an AI cron as the active run and forwards normal-mode approvals", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-active-"));
    const store = new CronStore(stateDir);
    const runtime = createLarkServiceRuntime();
    const channel = { send: vi.fn().mockResolvedValue({ messageId: "om_cron" }) };
    const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow" as const, scope: "once" as const });
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(async (input: {
        abortSignal?: AbortSignal;
        onApprovalRequest?: (request: { engine: "codex"; toolName: string; toolInput: unknown }) => Promise<unknown>;
      }) => {
        await input.onApprovalRequest?.({ engine: "codex", toolName: "Bash", toolInput: { command: "date" } });
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(new Error("cron stopped")), { once: true });
        });
        return { text: "unreachable" };
      }),
    };

    try {
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "run tools",
        larkChatId: "oc_cron",
        conversationKey: "lark:oc_cron",
        locale: "en",
      });
      const executor = buildLarkCronExecutor({
        channel: channel as never,
        bridge: bridge as never,
        runtime,
        stateDir,
        requestApproval: requestApproval as never,
      });
      const running = executor(job);

      await vi.waitFor(() => {
        expect(runtime.activeRuns.has("lark:oc_cron")).toBe(true);
        expect(requestApproval).toHaveBeenCalledTimes(1);
      });
      runtime.activeRuns.get("lark:oc_cron")!.abortController.abort();
      await expect(running).rejects.toThrow("cron stopped");
      expect(runtime.activeRuns.has("lark:oc_cron")).toBe(false);
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
