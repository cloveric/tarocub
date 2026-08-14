import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startLarkHealthMonitor } from "../src/lark/health.js";
import { parseTimelineEvents, type TimelineEvent } from "../src/state/timeline-log.js";

async function readTimeline(stateDir: string): Promise<TimelineEvent[]> {
  try {
    return parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

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
    const telemetry = {
      recordMetric: vi.fn(async () => undefined),
    };

    try {
      const monitor = startLarkHealthMonitor({
        stateDir,
        instanceName: "lark-alpha",
        channel,
        intervalMs: 1_000,
        failureThreshold: 2,
        probe,
        telemetry,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(probe).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(async () => {
        expect(await readTimeline(stateDir)).toContainEqual(expect.objectContaining({
          type: "service.health",
          outcome: "down",
          metadata: expect.objectContaining({ consecutiveFailures: 1 }),
        }));
      });
      expect(channel.connect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(channel.disconnect).toHaveBeenCalledTimes(1);
        expect(channel.connect).toHaveBeenCalledTimes(1);
      });

      monitor.stop();
      const timeline = await readTimeline(stateDir);
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
      expect(telemetry.recordMetric).toHaveBeenCalledWith("ws_reconnect", 1, {
        channel: "lark",
        instanceName: "lark-alpha",
        outcome: "success",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reconnects the callback channel when the network recovers after a failed reconnect", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-health-recovery-"));
    const channel = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("network offline"))
        .mockResolvedValue(undefined),
      disconnect: vi.fn(async () => undefined),
    };
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    try {
      const monitor = startLarkHealthMonitor({
        stateDir,
        instanceName: "lark-recovery",
        channel,
        intervalMs: 1_000,
        failureThreshold: 2,
        probe,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(probe).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(channel.connect).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(channel.disconnect).toHaveBeenCalledTimes(2);
        expect(channel.connect).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(async () => {
        expect(await readTimeline(stateDir)).toContainEqual(expect.objectContaining({
          type: "service.health",
          outcome: "recovered",
        }));
      });

      monitor.stop();
      const timeline = await readTimeline(stateDir);
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.health",
        outcome: "reconnect_failed",
      }));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.health",
        outcome: "reconnected",
      }));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.health",
        outcome: "recovered",
        metadata: expect.objectContaining({
          consecutiveFailures: 2,
          channelReconnected: true,
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not reconnect after stop while an asynchronous health probe is still in flight", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-health-stop-race-"));
    const channel = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    let resolveProbe!: (value: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    }));

    try {
      const monitor = startLarkHealthMonitor({
        stateDir,
        instanceName: "lark-stopped",
        channel,
        intervalMs: 1_000,
        failureThreshold: 1,
        probe,
      });

      await vi.waitFor(() => {
        expect(probe).toHaveBeenCalledTimes(1);
      }, { timeout: 1_500 });
      expect(probe).toHaveBeenCalledTimes(1);
      monitor.stop();
      resolveProbe(false);
      // Let the probe continuation and its asynchronous timeline write settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(channel.disconnect).not.toHaveBeenCalled();
      expect(channel.connect).not.toHaveBeenCalled();
      await expect(readTimeline(stateDir)).resolves.toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("disconnects a channel whose reconnect finishes after the monitor is stopped", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-health-connect-stop-race-"));
    let resolveConnect!: () => void;
    const channel = {
      connect: vi.fn(() => new Promise<void>((resolve) => {
        resolveConnect = resolve;
      })),
      disconnect: vi.fn(async () => undefined),
    };
    const probe = vi.fn(async () => false);

    try {
      const monitor = startLarkHealthMonitor({
        stateDir,
        instanceName: "lark-connect-stopped",
        channel,
        intervalMs: 1_000,
        failureThreshold: 1,
        probe,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(channel.connect).toHaveBeenCalledTimes(1);
      });
      expect(channel.disconnect).toHaveBeenCalledTimes(1);

      monitor.stop();
      resolveConnect();
      await vi.advanceTimersByTimeAsync(0);

      expect(channel.disconnect).toHaveBeenCalledTimes(2);
      expect(await readTimeline(stateDir)).not.toContainEqual(expect.objectContaining({
        outcome: "reconnected",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
