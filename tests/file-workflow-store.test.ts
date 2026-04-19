import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FILE_WORKFLOW_STATE_UNREADABLE_WARNING, FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { JsonStore } from "../src/state/json-store.js";

describe("FileWorkflowStore", () => {
  it("lists records newest-first and clears a single upload", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "document",
        status: "failed",
        sourceFiles: ["b.pdf"],
        derivedFiles: [],
        summary: "second",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two", "one"]);
      await store.remove("one");
      expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns false when removing a missing upload", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await expect(store.remove("missing")).resolves.toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("finds uploads by id and filters list results", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 200,
        userId: 200,
        kind: "document",
        status: "failed",
        sourceFiles: ["b.pdf"],
        derivedFiles: [],
        summary: "second",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.find("two")).resolves.toEqual(
        expect.objectContaining({ uploadId: "two", chatId: 200, status: "failed" }),
      );
      expect((await store.list({ status: "failed" })).map((record) => record.uploadId)).toEqual(["two"]);
      expect((await store.list({ chatId: 100, status: "awaiting_continue" })).map((record) => record.uploadId)).toEqual(["one"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves awaiting archives by summary message id", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        summaryMessageId: 41,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["b.zip"],
        derivedFiles: [],
        summary: "second",
        summaryMessageId: 42,
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.getAwaitingArchiveBySummaryMessageId(100, 41)).resolves.toEqual(
        expect.objectContaining({ uploadId: "one", summaryMessageId: 41 }),
      );
      await expect(store.getAwaitingArchiveBySummaryMessageId(100, 99)).resolves.toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("claims awaiting archives for continuation and marks them processing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        summaryMessageId: 41,
        extractedPath: "workspace/.telegram-files/one/extracted",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["b.zip"],
        derivedFiles: [],
        summary: "second",
        summaryMessageId: 42,
        extractedPath: "workspace/.telegram-files/two/extracted",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.beginArchiveContinuation({ chatId: 100, summaryMessageId: 41 })).resolves.toEqual(
        expect.objectContaining({ uploadId: "one", status: "processing", summaryMessageId: 41 }),
      );
      await expect(store.find("one")).resolves.toEqual(expect.objectContaining({ status: "processing" }));
      await expect(store.find("two")).resolves.toEqual(expect.objectContaining({ status: "awaiting_continue" }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to the latest archive when a reply-targeted summary message id is stale", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        summaryMessageId: 41,
        extractedPath: "workspace/.telegram-files/one/extracted",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["b.zip"],
        derivedFiles: [],
        summary: "second",
        summaryMessageId: 42,
        extractedPath: "workspace/.telegram-files/two/extracted",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.beginArchiveContinuation({ chatId: 100, summaryMessageId: 99 })).resolves.toBeNull();
      await expect(store.find("one")).resolves.toEqual(expect.objectContaining({ status: "awaiting_continue" }));
      await expect(store.find("two")).resolves.toEqual(expect.objectContaining({ status: "awaiting_continue" }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows explicitly targeted continuation to retry a failed archive without broadening generic lookup", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "failed",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        summaryMessageId: 41,
        extractedPath: "workspace/.telegram-files/one/extracted",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["b.zip"],
        derivedFiles: [],
        summary: "second",
        summaryMessageId: 42,
        extractedPath: "workspace/.telegram-files/two/extracted",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.beginArchiveContinuation({ chatId: 100, uploadId: "one" })).resolves.toEqual(
        expect.objectContaining({ uploadId: "one", status: "processing" }),
      );
      await expect(store.find("one")).resolves.toEqual(expect.objectContaining({ status: "processing" }));
      await expect(store.getLatestAwaitingArchive(100)).resolves.toEqual(
        expect.objectContaining({ uploadId: "two", status: "awaiting_continue" }),
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical workflow timestamps", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      const filePath = path.join(stateDir, "file-workflow.json");
      await writeFile(
        filePath,
        JSON.stringify({
          records: [
            {
              uploadId: "one",
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["a.zip"],
              derivedFiles: [],
              summary: "first",
              createdAt: "2026-04-10 00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid file workflow state");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer workflow identifiers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      const filePath = path.join(stateDir, "file-workflow.json");
      await writeFile(
        filePath,
        JSON.stringify({
          records: [
            {
              uploadId: "one",
              chatId: 100.5,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["a.zip"],
              derivedFiles: [],
              summary: "first",
              summaryMessageId: 41.2,
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid file workflow state");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("strips unexpected extra fields from persisted workflow records", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      const filePath = path.join(stateDir, "file-workflow.json");
      await writeFile(
        filePath,
        JSON.stringify({
          records: [
            {
              uploadId: "one",
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["a.zip"],
              derivedFiles: [],
              summary: "first",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
              rogue: true,
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).resolves.toEqual({
        records: [
          {
            uploadId: "one",
            chatId: 100,
            userId: 100,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["a.zip"],
            derivedFiles: [],
            summary: "first",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent workflow mutations from losing updates", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.append({
            uploadId: `upload-${index}`,
            chatId: 100,
            userId: 100,
            kind: "document",
            status: "processing",
            sourceFiles: [`${index}.txt`],
            derivedFiles: [],
            summary: `record-${index}`,
            createdAt: `2026-04-10T00:${String(index).padStart(2, "0")}:00.000Z`,
            updatedAt: `2026-04-10T00:${String(index).padStart(2, "0")}:00.000Z`,
          }),
        ),
      );

      const uploadIds = (await store.list({ chatId: 100 })).map((record) => record.uploadId);
      const sortUploadIds = (values: string[]) => [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

      expect(sortUploadIds(uploadIds)).toEqual(sortUploadIds(Array.from({ length: 12 }, (_, index) => `upload-${index}`)));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes update and remove mutations without losing records", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await Promise.all([
        store.append({
          uploadId: "one",
          chatId: 100,
          userId: 100,
          kind: "document",
          status: "processing",
          sourceFiles: ["a.txt"],
          derivedFiles: [],
          summary: "first",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        }),
        store.append({
          uploadId: "two",
          chatId: 100,
          userId: 100,
          kind: "document",
          status: "processing",
          sourceFiles: ["b.txt"],
          derivedFiles: [],
          summary: "second",
          createdAt: "2026-04-10T00:01:00.000Z",
          updatedAt: "2026-04-10T00:01:00.000Z",
        }),
      ]);

      await Promise.all([
        store.update("one", (record) => {
          record.status = "completed";
          record.summary = "first updated";
        }),
        store.remove("two"),
      ]);

      await expect(store.find("one")).resolves.toEqual(
        expect.objectContaining({ uploadId: "one", status: "completed", summary: "first updated" }),
      );
      await expect(store.find("two")).resolves.toBeNull();
      expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["one"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("enforces the active-workflow cap inside the store write queue", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      const results = await Promise.all([
        store.appendIfChatBelowActiveLimit({
          uploadId: "one",
          chatId: 100,
          userId: 100,
          kind: "document",
          status: "processing",
          sourceFiles: ["a.txt"],
          derivedFiles: [],
          summary: "first",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        }, 1),
        store.appendIfChatBelowActiveLimit({
          uploadId: "two",
          chatId: 100,
          userId: 100,
          kind: "document",
          status: "processing",
          sourceFiles: ["b.txt"],
          derivedFiles: [],
          summary: "second",
          createdAt: "2026-04-10T00:01:00.000Z",
          updatedAt: "2026-04-10T00:01:00.000Z",
        }, 1),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.list({ chatId: 100 })).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("treats permission-denied reads as unreadable workflow state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const readSpy = vi.spyOn((store as unknown as { store: JsonStore<unknown> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      await expect(store.inspect()).resolves.toEqual({
        state: { records: [] },
        warning: FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
      });
    } finally {
      readSpy.mockRestore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("quarantines unreadable workflow state before resetting during targeted recovery", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);
    const filePath = path.join(stateDir, "file-workflow.json");
    const unreadableContents = "{not valid json";

    try {
      await writeFile(filePath, unreadableContents, "utf8");

      await expect(store.removeRecovering("upload-123")).resolves.toEqual({
        removed: false,
        repaired: true,
      });

      const after = JSON.parse(await readFile(filePath, "utf8")) as { records: unknown[] };
      expect(after.records).toEqual([]);
      const backups = (await readdir(stateDir)).filter((entry) => entry.startsWith("file-workflow.json.") && !entry.endsWith(".tmp"));
      expect(backups).toHaveLength(1);
      await expect(readFile(path.join(stateDir, backups[0]!), "utf8")).resolves.toBe(unreadableContents);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not treat permission-denied targeted recovery as self-healing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const readSpy = vi.spyOn((store as unknown as { store: JsonStore<unknown> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      await expect(store.removeRecovering("upload-123")).rejects.toMatchObject({
        code: "EPERM",
      });
    } finally {
      readSpy.mockRestore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
