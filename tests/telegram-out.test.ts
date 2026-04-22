import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyTelegramOutLimits,
  createTelegramOutDir,
  describeTelegramOutFiles,
  listTelegramOutFiles,
} from "../src/runtime/telegram-out.js";

describe("telegram-out", () => {
  it("creates a request-scoped telegram-out directory under workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));

    try {
      const result = await createTelegramOutDir(root, "req-123");

      expect(result.requestId).toBe("req-123");
      expect(result.dirPath).toBe(path.join(root, "workspace", ".telegram-out", "req-123"));
      await expect(stat(result.dirPath)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists only regular files in deterministic order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const request = await createTelegramOutDir(root, "req-123");

    try {
      await writeFile(path.join(request.dirPath, "b.txt"), "b", "utf8");
      await writeFile(path.join(request.dirPath, "a.txt"), "a", "utf8");

      await expect(listTelegramOutFiles(request.dirPath)).resolves.toEqual([
        path.join(request.dirPath, "a.txt"),
        path.join(request.dirPath, "b.txt"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes produced file sizes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const request = await createTelegramOutDir(root, "req-123");

    try {
      await writeFile(path.join(request.dirPath, "hello.txt"), "hello", "utf8");

      await expect(describeTelegramOutFiles(request.dirPath)).resolves.toEqual([
        {
          path: path.join(request.dirPath, "hello.txt"),
          name: "hello.txt",
          size: 5,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters files beyond count and size limits", () => {
    const files = [
      { path: "a.txt", name: "a.txt", size: 10 },
      { path: "b.txt", name: "b.txt", size: 10 },
      { path: "c.txt", name: "c.txt", size: 50 },
    ];

    const result = applyTelegramOutLimits(files, {
      maxFiles: 2,
      maxFileBytes: 20,
      maxTotalBytes: 25,
    });

    expect(result.accepted).toEqual([
      { path: "a.txt", name: "a.txt", size: 10 },
      { path: "b.txt", name: "b.txt", size: 10 },
    ]);
    expect(result.skipped).toEqual([
      { path: "c.txt", name: "c.txt", size: 50 },
    ]);
  });

  it("prunes stale request directories when creating a new telegram-out dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const telegramOutRoot = path.join(root, "workspace", ".telegram-out");
    const staleDir = path.join(telegramOutRoot, "req-stale");
    const freshDir = path.join(telegramOutRoot, "req-fresh");

    try {
      await mkdir(staleDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      const now = new Date();
      const staleAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const freshAt = new Date(now.getTime() - 60 * 60 * 1000);
      await utimes(staleDir, staleAt, staleAt);
      await utimes(freshDir, freshAt, freshAt);

      const created = await createTelegramOutDir(root, "req-new");

      expect(created.dirPath).toBe(path.join(telegramOutRoot, "req-new"));
      await expect(readdir(telegramOutRoot)).resolves.toEqual(["req-fresh", "req-new"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
