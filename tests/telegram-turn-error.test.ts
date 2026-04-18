import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseAuditEvents } from "../src/state/audit-log.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import { finalizeTelegramTurnError, maybeRetryTelegramTurnError } from "../src/telegram/turn-error.js";
import { SessionStateError } from "../src/runtime/session-manager.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

describe("maybeRetryTelegramTurnError", () => {
  it("retries once after auth refresh succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-error-"));
    const normalized = createNormalizedMessage("hello");
    const onAuthRetry = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    const stopTyping = vi.fn();

    try {
      const handled = await maybeRetryTelegramTurnError({
        stateDir: root,
        normalized,
        classifiedError: new Error("auth expired"),
        failureCategory: "auth",
        context: {
          onAuthRetry,
          instanceName: "default",
          updateId: 10,
        },
        sessionStore: {
          removeByChatId: vi.fn(),
        } as never,
        stopTyping,
        restart,
      });

      expect(handled).toBe(true);
      expect(onAuthRetry).toHaveBeenCalledTimes(1);
      expect(stopTyping).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledTimes(1);
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.retried",
        channel: "telegram",
        outcome: "retry",
        detail: "auth refresh",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears stale session and retries once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-error-"));
    const normalized = createNormalizedMessage("hello");
    const removeByChatId = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    const stopTyping = vi.fn();

    try {
      const handled = await maybeRetryTelegramTurnError({
        stateDir: root,
        normalized,
        classifiedError: new Error("no such session"),
        failureCategory: "session-state",
        context: {
          instanceName: "default",
          updateId: 11,
        },
        sessionStore: {
          removeByChatId,
        } as never,
        stopTyping,
        restart,
      });

      expect(handled).toBe(true);
      expect(removeByChatId).toHaveBeenCalledWith(123);
      expect(stopTyping).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledTimes(1);
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.retried",
        channel: "telegram",
        outcome: "retry",
        detail: "stale session",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("finalizeTelegramTurnError", () => {
  it("marks unfinished workflow failed, replies with failure hint, and appends error audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-error-"));
    const normalized = createNormalizedMessage("hello");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const update = vi.fn().mockResolvedValue(undefined);

    try {
      await finalizeTelegramTurnError({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized,
        context: {
          api: { sendMessage },
          instanceName: "default",
          updateId: 99,
        },
        workflowStore: {
          update,
        } as never,
        classifiedError: new Error("engine failed"),
        failureCategory: "engine-cli",
        turnState: {
          workflowRecordId: "wf-1",
          archiveSummaryDelivered: false,
          failureHint: "Try a smaller archive.",
          telegramOutDirPath: undefined,
        },
      });

      expect(update).toHaveBeenCalledWith("wf-1", expect.any(Function));
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Try a smaller archive."));

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "error",
        detail: "engine failed",
        metadata: expect.objectContaining({
          failureCategory: "engine-cli",
        }),
      }));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "workflow.failed",
        channel: "telegram",
        detail: "workflow marked failed",
        metadata: expect.objectContaining({
          workflowRecordId: "wf-1",
          failureCategory: "engine-cli",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not send a second error reply after an archive summary was already delivered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-turn-error-"));
    const normalized = createNormalizedMessage("/reset");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

    try {
      await finalizeTelegramTurnError({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized,
        context: {
          api: { sendMessage },
          instanceName: "default",
          updateId: 100,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        classifiedError: new SessionStateError("broken state", false),
        failureCategory: "session-state",
        turnState: {
          workflowRecordId: "wf-2",
          archiveSummaryDelivered: true,
          failureHint: undefined,
          telegramOutDirPath: undefined,
        },
      });

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
