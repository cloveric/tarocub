import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyFailure } from "../src/runtime/error-classification.js";
import { appendAuditEvent, getLatestFailure, parseAuditEvents, resolveAuditLogPath } from "../src/state/audit-log.js";

describe("audit log", () => {
  it("appends jsonl events to the instance audit log", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await appendAuditEvent(tempDir, {
        type: "access.allow",
        instanceName: "default",
        chatId: 123,
        outcome: "success",
      });
      await appendAuditEvent(tempDir, {
        type: "update.handle",
        instanceName: "default",
        updateId: 45,
        outcome: "error",
        detail: "boom",
      });

      const raw = await readFile(resolveAuditLogPath(tempDir), "utf8");
      const lines = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        type: "access.allow",
        instanceName: "default",
        chatId: 123,
        outcome: "success",
      });
      expect(lines[1]).toMatchObject({
        type: "update.handle",
        instanceName: "default",
        updateId: 45,
        outcome: "error",
        detail: "boom",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid audit event shapes on append", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await expect(
        appendAuditEvent(tempDir, {
          type: "update.handle",
          chatId: Number.NaN,
          outcome: "success",
        }),
      ).rejects.toThrow(/invalid audit event/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores parsed audit lines with invalid typed fields", () => {
    const events = parseAuditEvents([
      JSON.stringify({
        timestamp: "2026-04-10T00:00:00.000Z",
        type: "update.handle",
        chatId: "123",
        outcome: "success",
      }),
      JSON.stringify({
        timestamp: "2026-04-10T00:01:00.000Z",
        type: "update.handle",
        chatId: 123,
        outcome: "success",
      }),
    ].join("\n"));

    expect(events).toEqual([
      expect.objectContaining({
        timestamp: "2026-04-10T00:01:00.000Z",
        type: "update.handle",
        chatId: 123,
        outcome: "success",
      }),
    ]);
  });

  it("returns the latest categorized failure from audit history", () => {
    const events = parseAuditEvents([
      JSON.stringify({
        timestamp: "2026-04-10T00:00:00.000Z",
        type: "update.handle",
        outcome: "error",
        detail: "Error: Not logged in",
        metadata: { failureCategory: "auth" },
      }),
      JSON.stringify({
        timestamp: "2026-04-10T00:01:00.000Z",
        type: "update.handle",
        outcome: "error",
        detail: "Error: write access denied",
        metadata: { failureCategory: "write-permission" },
      }),
    ].join("\n"));

    expect(getLatestFailure(events)).toEqual({
      timestamp: "2026-04-10T00:01:00.000Z",
      category: "write-permission",
      detail: "Error: write access denied",
    });
  });

  it("classifies explicit session-state failures but not generic session runtime errors", () => {
    expect(classifyFailure(new Error("Session store corruption detected"))).toBe("session-state");
    expect(classifyFailure(new Error("Codex runtime session failed while starting"))).toBe("engine-cli");
  });

  it("classifies direct Error objects into stable categories", () => {
    expect(classifyFailure(new Error("boom"))).toBe("unknown");
    expect(classifyFailure(new Error("Telegram API sendDocument failed: bad request"))).toBe("telegram-delivery");
    expect(classifyFailure(new Error("Archive extraction failed for uploaded zip"))).toBe("file-workflow");
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).toBe("engine-cli");
    expect(classifyFailure(new Error("Session binding store is unavailable"))).toBe("session-state");
  });

  it("falls back safely when failure metadata is invalid and preserves missing timestamps", () => {
    const events = parseAuditEvents([
      JSON.stringify({
        type: "update.handle",
        outcome: "error",
        detail: "Error: session store unavailable",
        metadata: { failureCategory: "not-a-category" },
      }),
      JSON.stringify({
        timestamp: "2026-04-09T23:59:00.000Z",
        type: "update.handle",
        outcome: "error",
        detail: "Error: permission denied",
      }),
    ].join("\n"));

    expect(getLatestFailure(events)).toEqual({
      timestamp: "2026-04-09T23:59:00.000Z",
      category: "write-permission",
      detail: "Error: permission denied",
    });
    expect(
      getLatestFailure(
        parseAuditEvents(
          JSON.stringify({
            type: "update.handle",
            outcome: "error",
            detail: "Error: session store unavailable",
            metadata: { failureCategory: "not-a-category" },
          }),
        ),
      ),
    ).toEqual({
      category: "session-state",
      detail: "Error: session store unavailable",
    });
    expect(
      getLatestFailure(
        parseAuditEvents(
          JSON.stringify({
            timestamp: "2026-04-09T23:58:00.000Z",
            type: "update.handle",
            outcome: "error",
            detail: "Error: session store unavailable",
          }),
        ),
      ),
    ).toEqual({
      timestamp: "2026-04-09T23:58:00.000Z",
      category: "session-state",
      detail: "Error: session store unavailable",
    });
  });

  it("preserves explicit workflow-state metadata in latest failure summaries", () => {
    const events = parseAuditEvents(
      JSON.stringify({
        timestamp: "2026-04-10T00:02:00.000Z",
        type: "update.handle",
        outcome: "error",
        detail: "Error: write access denied",
        metadata: { failureCategory: "workflow-state" },
      }),
    );

    expect(getLatestFailure(events)).toEqual({
      timestamp: "2026-04-10T00:02:00.000Z",
      category: "workflow-state",
      detail: "Error: write access denied",
    });
  });
});
