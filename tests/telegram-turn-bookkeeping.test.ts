import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendCommandSuccessAuditEventBestEffort,
  appendUpdateReplyAuditEventBestEffort,
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
} from "../src/telegram/turn-bookkeeping.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text: "hello",
    attachments: [{ fileId: "doc-1", fileName: "notes.txt", kind: "document" }],
  };
}

function createAuditContext() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    },
    instanceName: "default",
    updateId: 77,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("telegram turn bookkeeping", () => {
  it("records command success audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-bookkeeping-"));
    const context = createAuditContext();
    const normalized = createNormalizedMessage();

    try {
      await appendCommandSuccessAuditEventBestEffort(root, context, normalized, {
        startedAt: Date.now() - 25,
        command: "help",
        responseText: "hello world",
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "update.handle",
        instanceName: "default",
        chatId: 123,
        userId: 456,
        updateId: 77,
        outcome: "success",
        metadata: expect.objectContaining({
          command: "help",
          attachments: 1,
          responseChars: 11,
          chunkCount: 1,
          durationMs: expect.any(Number),
        }),
      }));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        channel: "telegram",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "help",
          responseChars: 11,
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backfills failureCategory for error audits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-bookkeeping-"));
    const context = createAuditContext();
    const normalized = createNormalizedMessage();

    try {
      await appendUpdateHandleAuditEventBestEffort(root, context, normalized, {
        outcome: "error",
        detail: "unauthorized",
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "error",
        detail: "unauthorized",
        metadata: expect.objectContaining({
          failureCategory: "auth",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records update.reply audits with chat metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-bookkeeping-"));
    const context = createAuditContext();
    const normalized = createNormalizedMessage();

    try {
      await appendUpdateReplyAuditEventBestEffort(root, context, normalized, {
        detail: "Pair this private chat with code ABC123",
        metadata: {
          attachments: 1,
        },
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "update.reply",
        instanceName: "default",
        chatId: 123,
        userId: 456,
        updateId: 77,
        outcome: "reply",
        detail: "Pair this private chat with code ABC123",
        metadata: expect.objectContaining({
          attachments: 1,
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replies and audits when the budget is already exhausted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-bookkeeping-"));
    await mkdir(root, { recursive: true });
    const context = createAuditContext();
    const normalized = createNormalizedMessage();

    try {
      await writeFile(
        path.join(root, "usage.json"),
        JSON.stringify({
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCachedTokens: 0,
          totalCostUsd: 0.75,
          requestCount: 2,
          lastUpdatedAt: "2026-04-17T00:00:00.000Z",
        }),
        "utf8",
      );

      const blocked = await maybeReplyWithBudgetExhausted(root, 0.5, "en", context, normalized);

      expect(blocked).toBe(true);
      expect(context.api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringMatching(/Budget exhausted/),
      );
      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "update.reply",
        outcome: "reply",
        detail: "budget exhausted",
      }));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "budget.blocked",
        channel: "telegram",
        detail: "budget exhausted",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records threshold-reached audit events after usage is written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-bookkeeping-"));
    const context = createAuditContext();
    const normalized = createNormalizedMessage();

    try {
      await recordTurnUsageAndBudgetAudit(root, 0.5, context, normalized, {
        inputTokens: 11,
        outputTokens: 7,
        cachedTokens: 2,
        costUsd: 0.75,
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "update.reply",
        outcome: "reply",
        detail: "budget threshold reached: $0.7500 / $0.50",
      }));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "budget.threshold_reached",
        channel: "telegram",
        detail: "budget threshold reached: $0.7500 / $0.50",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
