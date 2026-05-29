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
});
