import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import {
  startCronHelperServer,
  type CronHelperServer,
} from "../src/runtime/cron-helper-server.js";
import { CronStore } from "../src/state/cron-store.js";

interface Harness {
  stateDir: string;
  store: CronStore;
  scheduler: CronScheduler;
  server: CronHelperServer;
  refreshSpy: ReturnType<typeof vi.spyOn>;
  cleanup: () => Promise<void>;
}

const CHAT_ID = 4242;
const USER_ID = 8888;

async function buildHarness(): Promise<Harness> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-helper-"));
  const store = new CronStore(stateDir);
  const scheduler = new CronScheduler({
    store,
    executor: async () => undefined,
    stateDir,
    logger: { error: () => undefined, warn: () => undefined },
  });
  const refreshSpy = vi.spyOn(scheduler, "refresh");
  const server = await startCronHelperServer({
    store,
    scheduler,
    chatId: CHAT_ID,
    userId: USER_ID,
    logger: { error: () => undefined, warn: () => undefined },
  });
  const harness: Harness = {
    stateDir,
    store,
    scheduler,
    server,
    refreshSpy,
    cleanup: async () => {
      refreshSpy.mockRestore();
      try {
        await harness.server.close();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ERR_SERVER_NOT_RUNNING") {
          throw error;
        }
      }
      await scheduler.stop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  return harness;
}

async function buildRestrictedHarness(): Promise<Harness> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-helper-"));
  const store = new CronStore(stateDir);
  const scheduler = new CronScheduler({
    store,
    executor: async () => undefined,
    stateDir,
    logger: { error: () => undefined, warn: () => undefined },
  });
  const refreshSpy = vi.spyOn(scheduler, "refresh");
  const server = await startCronHelperServer({
    store,
    scheduler,
    chatId: CHAT_ID,
    userId: USER_ID,
    chatType: "supergroup",
    allowedActions: ["add", "list"],
    logger: { error: () => undefined, warn: () => undefined },
  });
  const harness: Harness = {
    stateDir,
    store,
    scheduler,
    server,
    refreshSpy,
    cleanup: async () => {
      refreshSpy.mockRestore();
      await harness.server.close().catch(() => undefined);
      await scheduler.stop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
  return harness;
}

async function postJson(
  baseUrl: string,
  action: string,
  init: { token?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== null && init.token !== undefined) {
    headers.authorization = `Bearer ${init.token}`;
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/${action}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? {}),
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

describe("cron helper server", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = null;
    }
  });

  it("rejects requests without a Bearer token", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "list", { token: null });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, error: "not found" });
  });

  it("rejects requests with the wrong token", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "list", { token: "totally-wrong" });
    expect(response.status).toBe(404);
  });

  it("adds a valid job, persists it, and calls scheduler.refresh()", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "add", {
      token: harness.server.token,
      body: { cronExpr: "0 9 * * *", prompt: "morning summary", description: "daily" },
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.job.cronExpr).toBe("0 9 * * *");
    expect(response.body.job.prompt).toBe("morning summary");
    expect(response.body.job.chatId).toBe(CHAT_ID);
    expect(response.body.job.userId).toBe(USER_ID);
    expect(response.body.job.chatType).toBe("private");

    const stored = await harness.store.list();
    expect(stored).toHaveLength(1);
    expect(harness.refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("adds a one-shot job from runAt and calls scheduler.refresh()", async () => {
    harness = await buildHarness();
    const runAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const response = await postJson(harness.server.url, "add", {
      token: harness.server.token,
      body: { runAt, prompt: "drink water", description: "one-shot reminder" },
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.job.prompt).toBe("drink water");
    expect(response.body.job.runOnce).toBe(true);
    expect(response.body.job.targetAt).toBe(runAt);
    expect(response.body.job.cronExpr).toMatch(/^\d+ \d+ \d+ \d+ \*$/);

    const stored = await harness.store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.runOnce).toBe(true);
    expect(stored[0]!.targetAt).toBe(runAt);
    expect(harness.refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("persists the helper chatType on added jobs", async () => {
    harness = await buildRestrictedHarness();
    const response = await postJson(harness.server.url, "add", {
      token: harness.server.token,
      body: { cronExpr: "0 9 * * *", prompt: "morning summary" },
    });
    expect(response.status).toBe(200);
    expect(response.body.job.chatType).toBe("supergroup");
  });

  it("rejects an invalid cron expression with HTTP 400", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "add", {
      token: harness.server.token,
      body: { cronExpr: "not a cron", prompt: "x" },
    });
    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(String(response.body.error)).toMatch(/invalid cron expression/i);

    const stored = await harness.store.list();
    expect(stored).toHaveLength(0);
    expect(harness.refreshSpy).not.toHaveBeenCalled();
  });

  it("rejects bodies larger than the limit", async () => {
    harness = await buildHarness();
    const oversize = "x".repeat(70 * 1024);
    const response = await fetch(`${harness.server.url}/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${harness.server.token}`,
      },
      body: JSON.stringify({ cronExpr: "* * * * *", prompt: oversize }),
    });
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(text).toContain("too large");
  });

  it("list returns only jobs for the configured chat", async () => {
    harness = await buildHarness();
    await harness.store.add({
      chatId: CHAT_ID,
      userId: USER_ID,
      cronExpr: "* * * * *",
      prompt: "mine",
    });
    await harness.store.add({
      chatId: CHAT_ID + 1,
      userId: USER_ID,
      cronExpr: "* * * * *",
      prompt: "someone else",
    });

    const response = await postJson(harness.server.url, "list", {
      token: harness.server.token,
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].prompt).toBe("mine");
  });

  it("does not expose destructive helper actions by default", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "delete", {
      token: harness.server.token,
      body: { id: "deadbeef" },
    });
    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    expect(harness.refreshSpy).not.toHaveBeenCalled();
  });

  it("keeps destructive helper actions unavailable for agent-facing turn helpers", async () => {
    harness = await buildRestrictedHarness();
    const job = await harness.store.add({
      chatId: CHAT_ID,
      userId: USER_ID,
      cronExpr: "* * * * *",
      prompt: "keep me",
    });

    const response = await postJson(harness.server.url, "delete", {
      token: harness.server.token,
      body: { id: job.id },
    });
    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    await expect(harness.store.get(job.id)).resolves.not.toBeNull();
  });

  it("close drains sockets gracefully without throwing", async () => {
    harness = await buildHarness();
    await expect(harness.server.close()).resolves.toBeUndefined();
    // Replace the server handle so afterEach cleanup does not double-close.
    harness.server = {
      url: harness.server.url,
      token: harness.server.token,
      close: async () => undefined,
    };
  });

  it("rejects unknown actions", async () => {
    harness = await buildHarness();
    const response = await postJson(harness.server.url, "wat", {
      token: harness.server.token,
    });
    expect(response.status).toBe(404);
  });

  it("rejects GET requests", async () => {
    harness = await buildHarness();
    const response = await fetch(`${harness.server.url}/list`, {
      method: "GET",
      headers: { authorization: `Bearer ${harness.server.token}` },
    });
    expect(response.status).toBe(404);
  });
});
