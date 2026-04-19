import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
