import { describe, expect, it, vi } from "vitest";

import { buildAsrServiceShellInvocation, createAsrWatchdog } from "../src/telegram/asr-watchdog.js";

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

  it("resets the failure counter after a successful HTTP transcription", async () => {
    const spawnService = vi.fn();
    const watchdog = createAsrWatchdog({
      serviceCommand: "restart-asr",
      restartAfterFailures: 2,
      spawnService,
    });

    await watchdog.recordFailure(new Error("first failure"));
    watchdog.recordSuccess();
    await watchdog.recordFailure(new Error("second failure"));

    expect(spawnService).not.toHaveBeenCalled();
  });

  it("does not spawn the repair command more than once for concurrent failures", async () => {
    let resolveSpawn: (() => void) | undefined;
    const spawnService = vi.fn(() => new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    }));
    const watchdog = createAsrWatchdog({
      serviceCommand: "restart-asr",
      restartAfterFailures: 1,
      spawnService,
    });

    const first = watchdog.recordFailure(new Error("first failure"));
    const second = watchdog.recordFailure(new Error("second failure"));

    expect(spawnService).toHaveBeenCalledTimes(1);
    resolveSpawn?.();
    await Promise.all([first, second]);
  });

  it("keeps recordFailure best-effort when the repair command cannot be spawned", async () => {
    const spawnService = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const logger = { warn: vi.fn() };
    const watchdog = createAsrWatchdog({
      serviceCommand: "restart-asr",
      restartAfterFailures: 1,
      spawnService,
      logger,
    });

    await expect(watchdog.recordFailure(new Error("http failed"))).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("repair command failed to start"));
  });
});

describe("buildAsrServiceShellInvocation", () => {
  it("uses cmd.exe on Windows", () => {
    expect(buildAsrServiceShellInvocation("restart-asr", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "restart-asr"],
    });
  });

  it("uses /bin/sh on POSIX platforms", () => {
    expect(buildAsrServiceShellInvocation("restart-asr", "darwin", {})).toEqual({
      command: "/bin/sh",
      args: ["-lc", "restart-asr"],
    });
  });
});
