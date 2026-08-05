import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearRestartLoopState,
  isRestartLoopTripped,
  recordUncleanBootAndCheck,
  resolveRestartLoopStatePath,
} from "../src/runtime/restart-loop-guard.js";
import { acquireInstanceLock, resolveInstanceLockPath } from "../src/state/instance-lock.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const DEAD_PID = 999_999_99;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cctb-loop-"));
}

describe("restart-loop guard", () => {
  it("does not trip below the threshold", async () => {
    const stateDir = await tempDir();
    try {
      const first = await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      const second = await recordUncleanBootAndCheck(stateDir, { now: 1_010_000 });
      expect(first.tripped).toBe(false);
      expect(second.tripped).toBe(false);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("trips on the third unclean boot inside the window", async () => {
    const stateDir = await tempDir();
    try {
      await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      await recordUncleanBootAndCheck(stateDir, { now: 1_060_000 });
      const third = await recordUncleanBootAndCheck(stateDir, { now: 1_120_000 });
      expect(third.tripped).toBe(true);
      expect(third.recentBoots).toHaveLength(3);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("prunes boots that fell out of the window (slow crashes never accumulate)", async () => {
    const stateDir = await tempDir();
    try {
      await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      await recordUncleanBootAndCheck(stateDir, { now: 2_000_000 });
      // 20+ minutes later — both prior boots are outside the 10-minute window.
      const third = await recordUncleanBootAndCheck(stateDir, { now: 4_000_000 });
      expect(third.tripped).toBe(false);
      expect(third.recentBoots).toHaveLength(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("clear() resets the window (clean shutdown forgives past crashes)", async () => {
    const stateDir = await tempDir();
    try {
      await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      await recordUncleanBootAndCheck(stateDir, { now: 1_010_000 });
      await clearRestartLoopState(stateDir);
      const next = await recordUncleanBootAndCheck(stateDir, { now: 1_020_000 });
      expect(next.tripped).toBe(false);
      expect(next.recentBoots).toHaveLength(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("read-only check trips on a window filled by exit-time records without adding one", async () => {
    const stateDir = await tempDir();
    try {
      // Three fatal-error exits recorded at exit time (clean lock release).
      await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      await recordUncleanBootAndCheck(stateDir, { now: 1_060_000 });
      await recordUncleanBootAndCheck(stateDir, { now: 1_120_000 });
      const check = await isRestartLoopTripped(stateDir, { now: 1_150_000 });
      expect(check.tripped).toBe(true);
      expect(check.recentBoots).toHaveLength(3);
      // Read-only: the window did not grow.
      const again = await isRestartLoopTripped(stateDir, { now: 1_150_000 });
      expect(again.recentBoots).toHaveLength(3);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("read-only check does not trip an empty or aged-out window", async () => {
    const stateDir = await tempDir();
    try {
      expect((await isRestartLoopTripped(stateDir)).tripped).toBe(false);
      await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      expect((await isRestartLoopTripped(stateDir, { now: 5_000_000 })).tripped).toBe(false);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("fails open on a corrupt state file", async () => {
    const stateDir = await tempDir();
    try {
      await writeFile(resolveRestartLoopStatePath(stateDir), "{corrupt", "utf8");
      const check = await recordUncleanBootAndCheck(stateDir, { now: 1_000_000 });
      expect(check.tripped).toBe(false);
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});

describe("instance lock recoveredStale signal", () => {
  it("is false on a fresh acquire (clean previous shutdown)", async () => {
    const stateDir = await tempDir();
    try {
      const lock = await acquireInstanceLock(stateDir);
      expect(lock.recoveredStale).toBe(false);
      await lock.release();
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("is true when a dead process's lock had to be removed (crash signal)", async () => {
    const stateDir = await tempDir();
    try {
      await writeFile(
        resolveInstanceLockPath(stateDir),
        JSON.stringify({ pid: DEAD_PID, token: "00000000-0000-0000-0000-000000000000", acquiredAt: new Date().toISOString() }),
        "utf8",
      );
      const lock = await acquireInstanceLock(stateDir);
      expect(lock.recoveredStale).toBe(true);
      await lock.release();
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("is true when a corrupt lock had to be repaired", async () => {
    const stateDir = await tempDir();
    try {
      await writeFile(resolveInstanceLockPath(stateDir), "{not a lock", "utf8");
      const lock = await acquireInstanceLock(stateDir);
      expect(lock.recoveredStale).toBe(true);
      await lock.release();
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
