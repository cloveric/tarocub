import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import { extractTelegramToolTagMatches, processTelegramToolTags } from "../src/telegram/tool-tags.js";

async function withContext<T>(fn: (ctx: {
  stateDir: string;
  store: CronStore;
  scheduler: CronScheduler;
  workspaceDir: string;
  inboxDir: string;
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
  };
}) => Promise<T>): Promise<T> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "cctb-tool-tags-"));
  const root = await realpath(rawRoot);
  const stateDir = path.join(root, "instance");
  const inboxDir = path.join(stateDir, "inbox");
  const workspaceDir = path.join(stateDir, "workspace");
  const store = new CronStore(stateDir);
  const scheduler = new CronScheduler({
    store,
    executor: vi.fn(),
    stateDir,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
  };
  await scheduler.start();
  try {
    await mkdir(workspaceDir, { recursive: true });
    return await fn({ stateDir, store, scheduler, workspaceDir, inboxDir, api });
  } finally {
    await scheduler.stop();
    await rm(root, { recursive: true, force: true });
  }
}

describe("telegram tool tags", () => {
  it("ignores tool tag examples inside markdown code", () => {
    const text = [
      "`[tool:{\"name\":\"cron.list\"}]`",
      "",
      '[tool:{"name":"cron.list","payload":{}}]',
    ].join("\n");

    expect(extractTelegramToolTagMatches(text)).toHaveLength(1);
  });

  it("executes cron.add through the generic tool tag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withContext(async ({ stateDir, store, scheduler }) => {
        const text = await processTelegramToolTags({
          text: 'ok\n[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]',
          context: {
            cronRuntime: { store, scheduler },
            stateDir,
            chatId: 123,
            userId: 456,
            locale: "en",
          },
        });

        expect(text).not.toContain("[tool:");
        expect(text).toContain("Scheduled task added");
        expect((await store.list())[0]).toEqual(expect.objectContaining({
          chatId: 123,
          userId: 456,
          prompt: "check email",
        }));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes explicit fenced tool-call blocks through the same generic tool layer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withContext(async ({ stateDir, store, scheduler }) => {
        const text = await processTelegramToolTags({
          text: [
            "schedule this",
            "```tool-call",
            JSON.stringify({ name: "cron.add", payload: { in: "10m", prompt: "check [mail] inbox" } }),
            "```",
          ].join("\n"),
          context: {
            cronRuntime: { store, scheduler },
            stateDir,
            chatId: 123,
            userId: 456,
            locale: "en",
          },
        });

        expect(text).not.toContain("```tool-call");
        expect(text).toContain("Scheduled task added");
        expect((await store.list())[0]?.prompt).toBe("check [mail] inbox");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats plain fenced tool blocks as documentation, not executable calls", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: [
          "example:",
          "```tool",
          JSON.stringify({ name: "cron.add", payload: { in: "10m", prompt: "should not run" } }),
          "```",
        ].join("\n"),
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(text).toContain("```tool");
      expect(text).not.toContain("Scheduled task added");
      expect(await store.list()).toHaveLength(0);
    });
  });

  it("does not execute tool block examples nested inside another fenced block", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: [
          "example:",
          "````markdown",
          "```tool",
          JSON.stringify({ name: "cron.add", payload: { in: "10m", prompt: "should not run" } }),
          "```",
          "````",
        ].join("\n"),
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(text).toContain("```tool");
      expect(text).not.toContain("Scheduled task added");
      expect(await store.list()).toHaveLength(0);
    });
  });

  it("parses tool payloads that contain closing brackets inside JSON strings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:00:00.000Z"));
    try {
      await withContext(async ({ stateDir, store, scheduler }) => {
        const text = await processTelegramToolTags({
          text: 'ok\n[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check ] bracket"}}]',
          context: {
            cronRuntime: { store, scheduler },
            stateDir,
            chatId: 123,
            userId: 456,
            locale: "en",
          },
        });

        expect(text).toContain("Scheduled task added");
        expect((await store.list())[0]?.prompt).toBe("check ] bracket");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes send.file through the generic tool tag", async () => {
    await withContext(async ({ stateDir, store, scheduler, workspaceDir, inboxDir, api }) => {
      const filePath = path.join(workspaceDir, "report.txt");
      await writeFile(filePath, "hello", "utf8");

      const text = await processTelegramToolTags({
        text: `done\n[tool:{"name":"send.file","payload":{"path":"${filePath}"}}]`,
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      expect(text).not.toContain("[tool:");
      expect(text).toContain("File delivered");
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", expect.any(Uint8Array));
    });
  });

  it("allows explicit send.file tool tags to deliver readable absolute paths outside the workspace", async () => {
    await withContext(async ({ stateDir, store, scheduler, inboxDir, api }) => {
      const outsidePath = path.join(path.dirname(stateDir), "desktop-report.txt");
      await writeFile(outsidePath, "hello", "utf8");

      const text = await processTelegramToolTags({
        text: `done\n[tool:{"name":"send.file","payload":{"path":"${outsidePath}"}}]`,
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      expect(text).toContain("File delivered");
      expect(api.sendDocument).toHaveBeenCalledWith(123, "desktop-report.txt", expect.any(Uint8Array));
    });
  });

  it("deduplicates repeated send.file tool tags in one response", async () => {
    await withContext(async ({ stateDir, store, scheduler, workspaceDir, inboxDir, api }) => {
      const filePath = path.join(workspaceDir, "report.txt");
      await writeFile(filePath, "hello", "utf8");

      const text = await processTelegramToolTags({
        text: [
          "done",
          `[tool:{"name":"send.file","payload":{"path":"${filePath}"}}]`,
          `[tool:{"name":"send.file","payload":{"path":"${filePath}"}}]`,
        ].join("\n"),
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      expect(text).not.toContain("[tool:");
      expect(api.sendDocument).toHaveBeenCalledTimes(1);
    });
  });

  it("escapes embedded legacy delivery tags in send.batch messages", async () => {
    await withContext(async ({ stateDir, store, scheduler, inboxDir, api }) => {
      const deliverTelegramResponse = vi.fn().mockResolvedValue(0);
      const tag = JSON.stringify({
        name: "send.batch",
        payload: {
          message: "literal [send-file:/tmp/leak.txt] and [send-image:/tmp/leak.png]",
        },
      });

      await processTelegramToolTags({
        text: `done\n[tool:${tag}]`,
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
            deliverTelegramResponse,
          },
        },
      });

      const deliveredText = deliverTelegramResponse.mock.calls[0]?.[2] as string;
      expect(deliveredText).toContain("［send-file:/tmp/leak.txt］");
      expect(deliveredText).toContain("［send-image:/tmp/leak.png］");
      expect(deliveredText).not.toContain("[send-file:");
      expect(deliveredText).not.toContain("[send-image:");
    });
  });

  it("records a structured tool receipt event for send.file tags", async () => {
    await withContext(async ({ stateDir, store, scheduler, workspaceDir, inboxDir, api }) => {
      const filePath = path.join(workspaceDir, "report.txt");
      await writeFile(filePath, "hello", "utf8");

      await processTelegramToolTags({
        text: `done\n[tool:{"name":"send.file","payload":{"path":"${filePath}"}}]`,
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "tool.executed",
        channel: "telegram",
        chatId: 123,
        outcome: "accepted",
        metadata: expect.objectContaining({
          toolName: "send.file",
          status: "accepted",
        }),
      }));
    });
  });

  it("surfaces schema validation errors", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: '[tool:{"name":"cron.add","payload":{"in":"10m"}}]',
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(text).toContain("Invalid tool payload");
      expect(await store.list()).toHaveLength(0);
    });
  });
});
