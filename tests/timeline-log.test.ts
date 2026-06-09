import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempRoot } from "./helpers/temp-files.js";

import { appendTimelineEvent, parseTimelineEvents, resolveTimelineLogPath, summarizeTimelineEvents } from "../src/state/timeline-log.js";

describe("timeline log", () => {
  it("rotates an over-cap timeline log from the append path during runtime", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const filePath = resolveTimelineLogPath(tempDir);
      await writeFile(filePath, "x".repeat(10 * 1024 * 1024 + 1), "utf8");

      await appendTimelineEvent(tempDir, {
        type: "turn.completed",
        channel: "telegram",
        chatId: 7,
        outcome: "success",
      });

      const rotated = await readFile(`${filePath}.1`, "utf8");
      expect(rotated).toHaveLength(10 * 1024 * 1024 + 1);
      const current = await readFile(filePath, "utf8");
      const lines = current.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: "turn.completed", chatId: 7 });
    } finally {
      await removeTempRoot(tempDir);
    }
  });
  it("redacts secrets recursively from metadata before writing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await appendTimelineEvent(tempDir, {
        type: "service.error",
        channel: "lark",
        outcome: "error",
        metadata: {
          tenant_access_token: "tenant-secret",
          nested: {
            Authorization: "Bearer nested-token",
            stack: "request failed: api_key=stack-secret",
          },
          list: ["app_secret=list-secret"],
        },
      });

      const raw = await readFile(resolveTimelineLogPath(tempDir), "utf8");
      expect(raw).not.toContain("tenant-secret");
      expect(raw).not.toContain("nested-token");
      expect(raw).not.toContain("stack-secret");
      expect(raw).not.toContain("list-secret");

      const line = JSON.parse(raw.trim());
      expect(line.metadata).toEqual({
        tenant_access_token: "[redacted]",
        nested: {
          Authorization: "[redacted]",
          stack: "request failed: api_key=[redacted]",
        },
        list: ["app_secret=[redacted]"],
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("warns when invalid timeline log lines are dropped during parsing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const events = parseTimelineEvents([
        "{bad json",
        JSON.stringify({
          timestamp: "2026-04-10T00:01:00.000Z",
          type: "turn.completed",
          outcome: "success",
        }),
      ].join("\n"));

      expect(events).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith("Dropped 1 invalid timeline log line while parsing timeline history.");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("summarizes service health and shared worker pool waits", () => {
    const summary = summarizeTimelineEvents([
      {
        timestamp: "2026-05-29T00:00:00.000Z",
        type: "service.health",
        channel: "lark",
        outcome: "down",
      },
      {
        timestamp: "2026-05-29T00:00:01.000Z",
        type: "engine.lock.waiting",
        channel: "telegram",
        metadata: {
          reason: "turn_pool",
        },
      },
    ]);

    expect(summary.serviceHealthCount).toBe(1);
    expect(summary.lastServiceHealthAt).toBe("2026-05-29T00:00:00.000Z");
    expect(summary.lastServiceHealthOutcome).toBe("down");
    expect(summary.turnPoolWaitCount).toBe(1);
    expect(summary.lastTurnPoolWaitAt).toBe("2026-05-29T00:00:01.000Z");
  });
});
