import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

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
    sendVoice: ReturnType<typeof vi.fn>;
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
    sendVoice: vi.fn().mockResolvedValue({ message_id: 3 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 4 }),
  };
  await scheduler.start();
  try {
    await mkdir(workspaceDir, { recursive: true });
    return await fn({ stateDir, store, scheduler, workspaceDir, inboxDir, api });
  } finally {
    await scheduler.stop();
    await removeTempRoot(root);
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

  it("rejects explicit send.file tool tags for absolute paths outside the workspace by default", async () => {
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

      expect(text).toContain("outside-workspace");
      expect(api.sendDocument).not.toHaveBeenCalled();
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

  it("does not preserve misleading delivery claims when a tool tag contains malformed JSON", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: '9 张图 + 800 字正文都已发出。\n[tool:{"name":"send.batch","payload":{"message":"Done" "images":["/tmp/a.png"]}}]',
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "zh",
        },
      });

      expect(text).not.toContain("已发出");
      expect(text).toContain("工具调用失败");
      expect(text).toContain("JSON");
    });
  });

  it("does not preserve misleading delivery claims when a send tool is rejected", async () => {
    await withContext(async ({ stateDir, store, scheduler, inboxDir, api }) => {
      const text = await processTelegramToolTags({
        text: 'Done, file sent.\n[tool:{"name":"send.file","payload":{"path":"/tmp/cctb-missing-report.txt"}}]',
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

      expect(text).not.toContain("Done, file sent.");
      expect(text).toContain("File delivery failed");
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

  it("renders invalid cron.add absolute times as friendly guidance", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: '已设置\n[tool:{"name":"cron.add","payload":{"at":"午后","prompt":"看盘"}}]',
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "zh",
        },
      });

      expect(text).toContain("提醒时间格式无效");
      expect(text).toContain("at 必须使用 ISO 日期时间");
      expect(text).toContain("如果只是相对时间，请改用 in");
      expect(text).not.toContain("Invalid tool payload");
      expect(text).not.toContain("at must be a valid date-time");
      expect(text).not.toContain("已设置");
      expect(await store.list()).toHaveLength(0);
    });
  });

  it("does not expose raw validator text for invalid cron.add absolute times in English chats", async () => {
    await withContext(async ({ stateDir, store, scheduler }) => {
      const text = await processTelegramToolTags({
        text: 'Scheduled\n[tool:{"name":"cron.add","payload":{"at":"afternoon","prompt":"check market"}}]',
        context: {
          cronRuntime: { store, scheduler },
          stateDir,
          chatId: 123,
          userId: 456,
          locale: "en",
        },
      });

      expect(text).toContain("Invalid reminder time");
      expect(text).toContain("at must be an ISO date-time");
      expect(text).not.toContain("Invalid tool payload");
      expect(text).not.toContain("at must be a valid date-time");
      expect(text).not.toContain("Scheduled");
      expect(await store.list()).toHaveLength(0);
    });
  });
});

describe("empty fenced block off-by-one (v0.1.205)", () => {
  it("does not mask everything after an empty code block", async () => {
    const { extractDeliveryTagMatches } = await import("../src/telegram/delivery-tags.js");
    // The closer line immediately follows the opener: the closer regex used to
    // start AFTER the opener's newline, so (^|\n) could never match and the
    // "unclosed" block swallowed the rest of the message — a legit tag below
    // an empty block silently did not deliver.
    const text = "```\n```\n[send-file:/tmp/report.txt]";
    const matches = extractDeliveryTagMatches(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.path).toBe("/tmp/report.txt");
    // And a tag INSIDE a fence stays masked.
    expect(extractDeliveryTagMatches("```\n[send-file:/tmp/a.txt]\n```")).toHaveLength(0);
    // Tilde variant of the same shape.
    expect(extractDeliveryTagMatches("~~~\n~~~\n[send-file:/tmp/b.txt]")).toHaveLength(1);
  });
});

describe("legacy delivery tag paths", () => {
  it("preserves bracketed media IDs inside file names", async () => {
    const { extractDeliveryTagMatches, stripDeliveryTags } = await import("../src/telegram/delivery-tags.js");
    const filePath = "/tmp/佛法所說的「分別心」有何意義 [HO4ZZd9VQsQ].mp4";
    const text = `已下载并校验。\n[send-file:${filePath}]`;

    expect(extractDeliveryTagMatches(text)).toEqual([expect.objectContaining({
      tag: `[send-file:${filePath}]`,
      path: filePath,
      preferPhoto: false,
    })]);
    expect(stripDeliveryTags(text)).toBe("已下载并校验。");
  });
});
