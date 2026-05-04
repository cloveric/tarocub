import { describe, expect, it, vi } from "vitest";

import { createAsrWatchdog } from "../src/telegram/asr-watchdog.js";

describe("createAsrWatchdog", () => {
  it("does not spawn anything when no explicit ASR service command is configured", async () => {
    const spawnService = vi.fn();
    const watchdog = createAsrWatchdog({
      restartAfterFailures: 1,
      spawnService,
    });

    await watchdog.recordFailure(new Error("http failed"));

    expect(spawnService).not.toHaveBeenCalled();
  });

  it("spawns the configured repair command after repeated failures and rate-limits restarts", async () => {
    let now = 1_000;
    const spawnService = vi.fn();
    const watchdog = createAsrWatchdog({
      serviceCommand: "cd ~/projects/qwen3-asr && ./server.py",
      restartAfterFailures: 2,
      restartCooldownMs: 60_000,
      now: () => now,
      spawnService,
    });

    await watchdog.recordFailure(new Error("first failure"));
    expect(spawnService).not.toHaveBeenCalled();

    await watchdog.recordFailure(new Error("second failure"));
    expect(spawnService).toHaveBeenCalledTimes(1);
    expect(spawnService).toHaveBeenCalledWith("cd ~/projects/qwen3-asr && ./server.py");

    await watchdog.recordFailure(new Error("third failure"));
    await watchdog.recordFailure(new Error("fourth failure"));
    expect(spawnService).toHaveBeenCalledTimes(1);

    now += 61_000;
    await watchdog.recordFailure(new Error("fifth failure"));
    await watchdog.recordFailure(new Error("sixth failure"));
    expect(spawnService).toHaveBeenCalledTimes(2);
  });
});
