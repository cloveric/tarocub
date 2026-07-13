import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { acquireInstanceLock, resolveInstanceLockPath } from "../src/state/instance-lock.js";

describe("instance lock", () => {
  it("acquires a fresh lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const lock = await acquireInstanceLock(root);

      const onDisk = JSON.parse(await readFile(resolveInstanceLockPath(root), "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);

      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces a stale lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: 99999999,
            token: "stale-token",
            acquiredAt: "2026-04-08T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const lock = await acquireInstanceLock(root);

      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);

      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("allows only one winner when many starters race to replace the same stale lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(lockPath, JSON.stringify({
        pid: 99_999_999,
        token: "stale-token",
        acquiredAt: "2026-04-08T00:00:00.000Z",
      }), "utf8");

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => acquireInstanceLock(root)),
      );
      const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireInstanceLock>>> =>
        result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);

      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await winners[0]!.value.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects a live lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "2026-04-08T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(acquireInstanceLock(root)).rejects.toThrow(`Instance lock already held by pid ${process.pid}`);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces an invalid lock record shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "not-a-timestamp",
          },
          null,
          2,
        ),
        "utf8",
      );

      const lock = await acquireInstanceLock(root);
      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("treats parseable non-canonical timestamps as valid lock records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "2026-04-08T00:00:00Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(acquireInstanceLock(root)).rejects.toThrow(`Instance lock already held by pid ${process.pid}`);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces a malformed lock file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(lockPath, "{bad json\n", "utf8");

      const lock = await acquireInstanceLock(root);
      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("logs sync-release failures before swallowing them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const lock = await acquireInstanceLock(root);
      await writeFile(lockPath, "{bad json\n", "utf8");

      expect(() => lock.releaseSync()).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });
});
