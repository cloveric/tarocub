import { describe, expect, it, vi } from "vitest";

import { withBridgeTurnLock } from "../src/runtime/turn-lock.js";

describe("withBridgeTurnLock", () => {
  it("serializes turns that share a session id", async () => {
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
});
