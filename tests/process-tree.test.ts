import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "../src/codex/process-tree.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("killProcessTree", () => {
  it("sends SIGTERM first and SIGKILL after the grace period on unix", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const identities = new Map<number, string>([
      [100, "p100"],
      [200, "p200"],
      [201, "p201"],
    ]);
    const execFileFn = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      const pid = Number(args[1]);
      if (command === "pgrep" && pid === 100) {
        callback(null, "200\n201\n");
        return undefined as never;
      }
      callback(null, "");
      return undefined as never;
    });
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
    });
    const readIdentityFn = vi.fn((pid: number, callback: (identity: string | null) => void) => {
      callback(identities.get(pid) ?? null);
    });

    killProcessTree(100, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "linux",
      graceMs: 2_000,
      readIdentityFn,
    });

    expect(kills).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 201, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(kills).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 201, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
      { pid: 200, signal: 0 },
      { pid: 200, signal: "SIGKILL" },
      { pid: 201, signal: 0 },
      { pid: 201, signal: "SIGKILL" },
      { pid: 100, signal: 0 },
      { pid: 100, signal: "SIGKILL" },
    ]);
  });

  it("uses taskkill on windows", () => {
    const execFileFn = vi.fn();
    const killFn = vi.fn();

    killProcessTree(123, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "win32",
    });

    expect(execFileFn).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "123"], expect.any(Function));
    expect(killFn).not.toHaveBeenCalled();
  });

  it("skips SIGKILL when the pid identity changed during the grace period", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const execFileFn = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      callback(null, "");
      return undefined as never;
    });
    let identity = "original";
    const readIdentityFn = vi.fn((_pid: number, callback: (identity: string | null) => void) => {
      callback(identity);
    });
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
    });

    killProcessTree(123, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "linux",
      graceMs: 2_000,
      readIdentityFn,
    });

    expect(kills).toEqual([{ pid: 123, signal: "SIGTERM" }]);

    identity = "reused";
    await vi.advanceTimersByTimeAsync(2_000);

    expect(kills).toEqual([{ pid: 123, signal: "SIGTERM" }]);
  });
});
