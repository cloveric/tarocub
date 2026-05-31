import { afterEach, describe, expect, it, vi } from "vitest";

import { isBridgeTurnLockDisabled, withBridgeTurnLock } from "../src/runtime/turn-lock.js";

const ENV_KEY = "CCTB_DISABLE_TURN_LOCK";

describe("turn lock disable switch", () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  it("is disabled only when the env var is set to a truthy value", () => {
    delete process.env[ENV_KEY];
    expect(isBridgeTurnLockDisabled()).toBe(false);

    for (const value of ["1", "true", "yes", "on", "TRUE", " On "]) {
      process.env[ENV_KEY] = value;
      expect(isBridgeTurnLockDisabled()).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", "", "  "]) {
      process.env[ENV_KEY] = value;
      expect(isBridgeTurnLockDisabled()).toBe(false);
    }
  });

  it("serializes same-session turns by default (lock ON)", async () => {
    delete process.env[ENV_KEY];
    const sessionId = "turn-lock-serialize-session";
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = false;
    let secondStarted = false;

    const makeTask = (hold: Promise<void> | null, onStart: () => void) => async () => {
      onStart();
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (hold) await hold;
      } finally {
        active -= 1;
      }
      return "ok";
    };

    try {
      const first = withBridgeTurnLock(sessionId, makeTask(firstHeld, () => { firstStarted = true; }));
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      const second = withBridgeTurnLock(sessionId, makeTask(null, () => { secondStarted = true; }));
      // While the first turn holds the lock, the second must NOT have started.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondStarted).toBe(false);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
      expect(secondStarted).toBe(true);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst?.();
    }
  });

  it("runs same-session turns concurrently when the lock is disabled", async () => {
    process.env[ENV_KEY] = "1";
    const sessionId = "turn-lock-concurrent-session";
    let active = 0;
    let maxActive = 0;
    // Each task signals entry, then waits until BOTH have entered. With the lock
    // ON this would deadlock (the second never starts); with it disabled both run.
    let signalEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      let count = 0;
      signalEntered = () => { count += 1; if (count >= 2) resolve(); };
    });

    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      signalEntered();
      await bothEntered;
      active -= 1;
      return "ok";
    };

    const results = await Promise.all([
      withBridgeTurnLock(sessionId, task),
      withBridgeTurnLock(sessionId, task),
    ]);
    expect(results).toEqual(["ok", "ok"]);
    expect(maxActive).toBe(2);
  });
});
