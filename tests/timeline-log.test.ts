import { describe, expect, it, vi } from "vitest";

import { parseTimelineEvents } from "../src/state/timeline-log.js";

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
});
