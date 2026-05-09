import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import {
  FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
  clearTask,
  clearTaskWithRecovery,
  listTasks,
} from "../src/commands/task.js";

describe("task commands", () => {
  it("reports unreadable workflow state on list", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const workflowPath = path.join(homeDir, ".cctb", "alpha", "file-workflow.json");

    try {
      await mkdir(path.dirname(workflowPath), { recursive: true });
      await writeFile(workflowPath, "{not valid json", "utf8");

      await expect(listTasks({ USERPROFILE: homeDir }, "alpha")).resolves.toEqual({
        tasks: [],
        warning: FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
      });
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("clears the workflow record without deleting paths outside the telegram-files root", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const hostileUploadId = ["..", "outside-root"].join(path.sep);
    const outsideDir = path.join(stateDir, "workspace", "outside-root");
    const sentinelPath = path.join(outsideDir, "sentinel.txt");

    try {
      await mkdir(outsideDir, { recursive: true });
      await writeFile(sentinelPath, "keep me", "utf8");
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: hostileUploadId,
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(clearTask({ USERPROFILE: homeDir }, "alpha", hostileUploadId)).resolves.toBe(true);
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep me");
      await expect(access(sentinelPath)).resolves.toBeUndefined();
      await expect(readFile(path.join(stateDir, "file-workflow.json"), "utf8")).resolves.toContain('"records": []');
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("clears a hostile in-root traversal record without deleting a sibling workspace", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const hostileUploadId = ["foo", "..", "victim"].join(path.sep);
    const victimDir = path.join(stateDir, "workspace", ".telegram-files", "victim");
    const sentinelPath = path.join(victimDir, "sentinel.txt");

    try {
      await mkdir(victimDir, { recursive: true });
      await writeFile(sentinelPath, "keep me", "utf8");
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: hostileUploadId,
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(clearTask({ USERPROFILE: homeDir }, "alpha", hostileUploadId)).resolves.toBe(true);
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep me");
      await expect(readFile(path.join(stateDir, "file-workflow.json"), "utf8")).resolves.toContain('"records": []');
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("skips workspace deletion for win32 alias-style upload ids", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const victimDir = path.join(stateDir, "workspace", ".telegram-files", "victim");
    const victimSentinelPath = path.join(victimDir, "sentinel.txt");

    try {
      await mkdir(victimDir, { recursive: true });
      await writeFile(victimSentinelPath, "keep me", "utf8");
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: "victim.",
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "failed",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(clearTask({ USERPROFILE: homeDir }, "alpha", "victim.")).resolves.toBe(true);
      await expect(readFile(victimSentinelPath, "utf8")).resolves.toBe("keep me");
      await expect(readFile(path.join(stateDir, "file-workflow.json"), "utf8")).resolves.toContain('"records": []');
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("does not delete workspace files before record removal succeeds", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const workflowPath = path.join(stateDir, "file-workflow.json");
    const uploadWorkspaceDir = path.join(stateDir, "workspace", ".telegram-files", "upload-123");
    const artifactPath = path.join(uploadWorkspaceDir, "artifact.txt");

    try {
      await mkdir(uploadWorkspaceDir, { recursive: true });
      await writeFile(artifactPath, "payload", "utf8");
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "pending",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const removeWorkspaceDir = vi.fn(async () => {
        throw new Error("workspace cleanup should not run after a failed metadata write");
      });

      await expect(
        clearTaskWithRecovery({ USERPROFILE: homeDir }, "alpha", "upload-123", {
          removeRecord: async () => {
            throw new Error("persist failed");
          },
          removeWorkspaceDir,
        }),
      ).rejects.toThrow("persist failed");

      await expect(readFile(artifactPath, "utf8")).resolves.toBe("payload");
      await expect(readFile(workflowPath, "utf8")).resolves.toContain('"uploadId":"upload-123"');
      expect(removeWorkspaceDir).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("treats cleanup failure as a warning after record removal succeeds", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const workflowPath = path.join(stateDir, "file-workflow.json");
    const uploadWorkspaceDir = path.join(stateDir, "workspace", ".telegram-files", "upload-123");

    try {
      await mkdir(uploadWorkspaceDir, { recursive: true });
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "failed",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "Extraction failed",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      await expect(
        clearTaskWithRecovery({ USERPROFILE: homeDir }, "alpha", "upload-123", {
          removeWorkspaceDir: async () => {
            throw new Error("cleanup failed");
          },
        }),
      ).resolves.toEqual({
        cleared: true,
        repaired: false,
        cleanupWarning: "cleanup failed",
      });

      expect(JSON.parse(await readFile(workflowPath, "utf8"))).toEqual(expect.objectContaining({ records: [] }));
    } finally {
      await removeTempRoot(homeDir);
    }
  });

  it("repairs unreadable workflow state when record removal hits a repairable error", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".cctb", "alpha");
    const workflowPath = path.join(stateDir, "file-workflow.json");
    const removeWorkspaceDir = vi.fn();

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "pending",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      await expect(
        clearTaskWithRecovery({ USERPROFILE: homeDir }, "alpha", "upload-123", {
          removeRecord: async () => {
            throw new SyntaxError("corrupt workflow state");
          },
          removeWorkspaceDir,
        }),
      ).resolves.toEqual({
        cleared: false,
        repaired: true,
      });

      expect(JSON.parse(await readFile(workflowPath, "utf8"))).toEqual(expect.objectContaining({ records: [] }));
      await expect(access(workflowPath)).resolves.toBeUndefined();
      expect(removeWorkspaceDir).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(homeDir);
    }
  });
});
