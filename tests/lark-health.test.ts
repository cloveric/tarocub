import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startLarkHealthMonitor } from "../src/lark/health.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("Lark health monitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records health failures and reconnects the channel after the threshold", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-health-"));
    const channel = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    const probe = vi.fn(async () => false);

    try {
      const monitor = startLarkHealthMonitor({
        stateDir,
        instanceName: "lark-alpha",
        channel,
        intervalMs: 1_000,
        failureThreshold: 2,
        probe,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(probe).toHaveBeenCalledTimes(1);
      });
      expect(channel.connect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(channel.disconnect).toHaveBeenCalledTimes(1);
        expect(channel.connect).toHaveBeenCalledTimes(1);
      });

      monitor.stop();
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.health",
        instanceName: "lark-alpha",
        channel: "lark",
        outcome: "down",
        detail: "Lark health probe failed",
        metadata: expect.objectContaining({
          consecutiveFailures: 1,
          failureThreshold: 2,
        }),
      }));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.health",
        instanceName: "lark-alpha",
        channel: "lark",
        outcome: "reconnected",
        detail: "Lark channel reconnected after health failures",
        metadata: expect.objectContaining({
          consecutiveFailures: 2,
          failureThreshold: 2,
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
