import { describe, expect, it, vi } from "vitest";

import { parseTimelineEvents, summarizeTimelineEvents } from "../src/state/timeline-log.js";

describe("timeline log", () => {
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
