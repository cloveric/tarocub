import { lstat, mkdtemp, mkdir, readlink, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyTelegramOutLimits,
  createTelegramOutDir,
  pruneStaleTelegramRuntimeDirs,
  pruneStaleCctbSendDirs,
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

  it("creates a stable current alias for the active request directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));

    try {
      const result = await createTelegramOutDir(root, "req-123");
      const aliasPath = path.join(root, "workspace", ".telegram-out", "current");

      await expect(lstat(aliasPath)).resolves.toEqual(expect.objectContaining({
        isSymbolicLink: expect.any(Function),
      }));
      expect((await lstat(aliasPath)).isSymbolicLink()).toBe(true);
      await expect(readlink(aliasPath)).resolves.toBe(result.dirPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues when the current alias cannot be created", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const warnings: Array<{ aliasPath: string; targetDirPath: string; error: unknown }> = [];

    try {
      const result = await createTelegramOutDir(root, "req-123", undefined, {
        linkCurrentAlias: async () => {
          throw new Error("symlink unavailable");
        },
        onAliasWarning: (warning) => {
          warnings.push(warning);
        },
      });

      expect(result.dirPath).toBe(path.join(root, "workspace", ".telegram-out", "req-123"));
      await expect(stat(result.dirPath)).resolves.toBeTruthy();
      expect(warnings).toEqual([
        expect.objectContaining({
          aliasPath: path.join(root, "workspace", ".telegram-out", "current"),
          targetDirPath: result.dirPath,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a current alias in the resumed workspace when provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const resumeWorkspace = path.join(root, "resume-project");

    try {
      const result = await createTelegramOutDir(root, "req-123", resumeWorkspace);
      const aliasPath = path.join(resumeWorkspace, ".telegram-out", "current");

      expect((await lstat(aliasPath)).isSymbolicLink()).toBe(true);
      await expect(readlink(aliasPath)).resolves.toBe(result.dirPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists only visible regular files in deterministic order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const request = await createTelegramOutDir(root, "req-123");

    try {
      await writeFile(path.join(request.dirPath, "b.txt"), "b", "utf8");
      await writeFile(path.join(request.dirPath, "a.txt"), "a", "utf8");
      await writeFile(path.join(request.dirPath, ".scratch.json"), "{}", "utf8");

      await expect(listTelegramOutFiles(request.dirPath)).resolves.toEqual([
        path.join(request.dirPath, "a.txt"),
        path.join(request.dirPath, "b.txt"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow a request directory symlink when collecting auto-delivery files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const request = await createTelegramOutDir(root, "req-123");
    const outsideDir = path.join(root, "outside");

    try {
      await mkdir(outsideDir, { recursive: true });
      await writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
      await rm(request.dirPath, { recursive: true, force: true });
      await symlink(outsideDir, request.dirPath, process.platform === "win32" ? "junction" : "dir");

      await expect(listTelegramOutFiles(request.dirPath)).resolves.toEqual([]);
      await expect(describeTelegramOutFiles(request.dirPath)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow symlinked files inside the request directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const request = await createTelegramOutDir(root, "req-123");
    const outsideFile = path.join(root, "secret.txt");

    try {
      await writeFile(path.join(request.dirPath, "safe.txt"), "safe", "utf8");
      await writeFile(outsideFile, "secret", "utf8");
      await symlink(outsideFile, path.join(request.dirPath, "secret.txt"));

      await expect(listTelegramOutFiles(request.dirPath)).resolves.toEqual([
        path.join(request.dirPath, "safe.txt"),
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
      await expect(readdir(telegramOutRoot)).resolves.toEqual(["current", "req-fresh", "req-new"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes request directories older than 24 hours", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const telegramOutRoot = path.join(root, "workspace", ".telegram-out");
    const staleDir = path.join(telegramOutRoot, "req-25h");
    const freshDir = path.join(telegramOutRoot, "req-23h");

    try {
      await mkdir(staleDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      const now = new Date();
      const staleAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);
      const freshAt = new Date(now.getTime() - 23 * 60 * 60 * 1000);
      await utimes(staleDir, staleAt, staleAt);
      await utimes(freshDir, freshAt, freshAt);

      await pruneStaleTelegramRuntimeDirs(root);

      await expect(readdir(telegramOutRoot)).resolves.toEqual(["req-23h"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale cctb-send helper directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const helperRoot = path.join(root, "workspace", ".cctb-send");
    const staleDir = path.join(helperRoot, "req-stale");
    const freshDir = path.join(helperRoot, "req-fresh");

    try {
      await mkdir(staleDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      const now = new Date();
      const staleAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const freshAt = new Date(now.getTime() - 60 * 60 * 1000);
      await utimes(staleDir, staleAt, staleAt);
      await utimes(freshDir, freshAt, freshAt);

      await pruneStaleCctbSendDirs(root, "req-new");

      await expect(readdir(helperRoot)).resolves.toEqual(["req-fresh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale cctb-send helper directories in a resume workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const resumeWorkspace = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-resume-"));
    const helperRoot = path.join(resumeWorkspace, ".cctb-send");
    const staleDir = path.join(helperRoot, "req-stale");
    const freshDir = path.join(helperRoot, "req-fresh");

    try {
      await mkdir(staleDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      const now = new Date();
      const staleAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const freshAt = new Date(now.getTime() - 60 * 60 * 1000);
      await utimes(staleDir, staleAt, staleAt);
      await utimes(freshDir, freshAt, freshAt);

      await pruneStaleCctbSendDirs(root, "req-new", resumeWorkspace);

      await expect(readdir(helperRoot)).resolves.toEqual(["req-fresh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(resumeWorkspace, { recursive: true, force: true });
    }
  });

  it("prunes stale telegram-out and cctb-send request dirs on startup maintenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const resumeWorkspace = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-resume-"));
    const staleTelegramOut = path.join(root, "workspace", ".telegram-out", "req-stale");
    const freshTelegramOut = path.join(root, "workspace", ".telegram-out", "req-fresh");
    const staleSend = path.join(root, "workspace", ".cctb-send", "req-stale");
    const freshSend = path.join(root, "workspace", ".cctb-send", "req-fresh");
    const staleResumeSend = path.join(resumeWorkspace, ".cctb-send", "req-stale");
    const freshResumeSend = path.join(resumeWorkspace, ".cctb-send", "req-fresh");

    try {
      await Promise.all([
        mkdir(staleTelegramOut, { recursive: true }),
        mkdir(freshTelegramOut, { recursive: true }),
        mkdir(staleSend, { recursive: true }),
        mkdir(freshSend, { recursive: true }),
        mkdir(staleResumeSend, { recursive: true }),
        mkdir(freshResumeSend, { recursive: true }),
      ]);
      const now = new Date();
      const staleAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const freshAt = new Date(now.getTime() - 60 * 60 * 1000);
      for (const dir of [staleTelegramOut, staleSend, staleResumeSend]) {
        await utimes(dir, staleAt, staleAt);
      }
      for (const dir of [freshTelegramOut, freshSend, freshResumeSend]) {
        await utimes(dir, freshAt, freshAt);
      }

      await pruneStaleTelegramRuntimeDirs(root, resumeWorkspace);

      await expect(readdir(path.dirname(staleTelegramOut))).resolves.toEqual(["req-fresh"]);
      await expect(readdir(path.dirname(staleSend))).resolves.toEqual(["req-fresh"]);
      await expect(readdir(path.dirname(staleResumeSend))).resolves.toEqual(["req-fresh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(resumeWorkspace, { recursive: true, force: true });
    }
  });

  it("does not fail startup pruning when runtime roots are malformed files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));

    try {
      await mkdir(path.join(root, "workspace"), { recursive: true });
      await writeFile(path.join(root, "workspace", ".telegram-out"), "not a directory", "utf8");

      await expect(pruneStaleTelegramRuntimeDirs(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
