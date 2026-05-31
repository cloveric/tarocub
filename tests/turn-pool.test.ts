import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileTurnPool } from "../src/runtime/turn-pool.js";

describe("turn pool telemetry", () => {
  it("records active and waiting pool metrics without changing queue semantics", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-"));
    const telemetry = {
      recordMetric: vi.fn(async () => undefined),
    };
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 5,
      telemetry,
      telemetryTags: { channel: "lark", instanceName: "ccfcc1" },
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      }, { metadata: { conversationKey: "lark:one" } });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      const second = pool.run(async () => "second", {
        waitNotifyAfterMs: 0,
        metadata: { conversationKey: "lark:two" },
      });
      await vi.waitFor(() => {
        expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 1, expect.objectContaining({
          channel: "lark",
          instanceName: "ccfcc1",
          conversationKey: "lark:two",
        }));
      });

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_active", 1, expect.objectContaining({
        conversationKey: "lark:one",
      }));
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_active", 0, expect.objectContaining({
        conversationKey: "lark:two",
      }));
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("clears the pool_waiting gauge when a queued turn is aborted", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-abort-"));
    const telemetry = { recordMetric: vi.fn(async () => undefined) };
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 5,
      telemetry,
      telemetryTags: { channel: "lark", instanceName: "ccfcc1" },
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = false;
    const ac = new AbortController();

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      }, { metadata: { conversationKey: "lark:one" } });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      // Second queues behind the held first (pool_waiting=1), then is aborted.
      const second = pool.run(async () => "second", {
        signal: ac.signal,
        waitNotifyAfterMs: 0,
        metadata: { conversationKey: "lark:two" },
      });
      await vi.waitFor(() => {
        expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 1, expect.objectContaining({
          conversationKey: "lark:two",
        }));
      });

      ac.abort();
      await expect(second).rejects.toThrow();
      // The gauge must be cleared back to 0 — not left stuck at 1.
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 0, expect.objectContaining({
        conversationKey: "lark:two",
      }));

      releaseFirst();
      await expect(first).resolves.toBe("first");
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a long-running lease alive via heartbeat so the concurrency cap holds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-hb-"));
    // staleLeaseMs is short; without a heartbeat the still-running first lease
    // would be judged stale after 120ms and the cap would be breached.
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 10,
      staleLeaseMs: 120,
      heartbeatIntervalMs: 25,
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let secondStarted = false;

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      // Hold well past staleLeaseMs — the heartbeat must keep the lease fresh.
      await new Promise((resolve) => setTimeout(resolve, 350));

      const second = pool.run(async () => {
        secondStarted = true;
        return "second";
      });
      // Window in which a wrongly-evicted lease would let the second turn start.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(secondStarted).toBe(false);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(secondStarted).toBe(true);
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
