import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sqlite3 from "sqlite3";
import { describe, expect, it } from "vitest";

import {
  BoardStore,
  resolveBoardStorePath,
} from "../src/state/board-store.js";
import {
  KANBAN_SCHEMA_VERSION,
  resolveKanbanAssetDirectory,
  resolveKanbanDatabasePath,
} from "../src/state/sqlite-kanban-repository.js";
import { JsonStore } from "../src/state/json-store.js";
import { CURRENT_SCHEMA_VERSION } from "../src/state/schema-version.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function databaseRun(databasePath: string, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      database.run(sql, params, (runError) => {
        database.close(() => {
          if (runError) {
            reject(runError);
          } else {
            resolve();
          }
        });
      });
    });
  });
}

function databaseExec(databasePath: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      database.exec(sql, (execError) => {
        database.close(() => {
          if (execError) {
            reject(execError);
          } else {
            resolve();
          }
        });
      });
    });
  });
}

function legacyBoardFixture(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nextTaskId: 8,
    nextRunId: 5,
    limits: { global: 4, perAssignee: 2, perConversation: 3 },
    tasks: [
      {
        id: "B4",
        title: "Migrated design",
        status: "done",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:10:00.000Z",
        completedAt: "2026-09-01T00:10:00.000Z",
        description: "Preserve every current field",
        acceptanceCriteria: ["Migration verified"],
        priority: "high",
        labels: ["migration", "kanban"],
        checklist: [
          {
            id: "C1",
            text: "Back up source",
            done: true,
            createdAt: "2026-09-01T00:00:00.000Z",
            completedAt: "2026-09-01T00:05:00.000Z",
          },
        ],
        artifacts: [
          { kind: "summary", value: "migration complete", createdAt: "2026-09-01T00:10:00.000Z" },
        ],
        review: { required: true, reviewer: "reviewer" },
        summary: "done",
        assignee: "builder",
        dependencies: [],
        runs: [
          {
            id: "R3",
            status: "done",
            startedAt: "2026-09-01T00:00:00.000Z",
            completedAt: "2026-09-01T00:10:00.000Z",
            summary: "done",
          },
        ],
        workspace: { mode: "worktree", path: "/tmp/kanban/B4", branch: "board/B4" },
        createdBy: {
          chatId: -100123,
          userId: 42,
          messageThreadId: 7,
          conversationKey: "chat:-100123:topic:7",
        },
      },
      {
        id: "B7",
        title: "Dependent task",
        status: "todo",
        createdAt: "2026-09-01T00:01:00.000Z",
        updatedAt: "2026-09-01T00:01:00.000Z",
        createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
        dependencies: ["B4"],
        runs: [],
      },
    ],
  };
}

describe("SQLite Kanban persistence", () => {
  it("diagnoses an unused state directory without creating Board files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-diagnostics-"));
    try {
      const diagnostics = await new BoardStore(root).diagnostics();
      expect(diagnostics).toMatchObject({
        ok: true,
        initialized: false,
        pendingLegacyMigration: false,
        schemaVersion: 0,
        taskCount: 0,
        issues: [],
      });
      await expect(access(resolveKanbanDatabasePath(root))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("creates a private SQLite board without writing new legacy JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-sqlite-"));
    try {
      const store = new BoardStore(root);
      await store.createTask({
        title: "SQLite task",
        createdBy: { chatId: 1, userId: 2, conversationKey: "chat:1" },
      });

      const databasePath = resolveKanbanDatabasePath(root);
      await expect(access(databasePath)).resolves.toBeUndefined();
      await expect(access(resolveBoardStorePath(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);

      const diagnostics = await store.diagnostics();
      expect(diagnostics).toMatchObject({
        ok: true,
        schemaVersion: KANBAN_SCHEMA_VERSION,
        integrityCheck: "ok",
        taskCount: 1,
        runCount: 0,
        foreignKeyViolations: 0,
        activeRunConflicts: 0,
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("migrates version 1 events without losing task or run history after deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-events-v2-"));
    try {
      const store = new BoardStore(root);
      const task = await store.createTask({
        title: "Persistent audit history",
        createdBy: { chatId: 1, userId: 2, conversationKey: "chat:1" },
      });
      const running = await store.startTask(task.id);
      const runId = running.runs.at(-1)!.id;
      await store.failTask(task.id, "expected test failure");
      const eventsBeforeMigration = await store.listEvents({ taskId: task.id });
      const databasePath = resolveKanbanDatabasePath(root);

      await databaseExec(databasePath, `
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE events RENAME TO events_v2_source;
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          event_type TEXT NOT NULL,
          actor_json TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO events (
          sequence, board_id, task_id, run_id, event_type,
          actor_json, payload_json, idempotency_key, created_at
        )
        SELECT
          sequence, board_id, task_id, run_id, event_type,
          actor_json, payload_json, idempotency_key, created_at
        FROM events_v2_source;
        DROP TABLE events_v2_source;
        CREATE UNIQUE INDEX unique_event_idempotency_key
        ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
        PRAGMA user_version = 1;
        COMMIT;
      `);

      const migrated = new BoardStore(root);
      await expect(migrated.listEvents({ taskId: task.id })).resolves.toEqual(eventsBeforeMigration);
      await expect(migrated.diagnostics()).resolves.toMatchObject({
        ok: true,
        schemaVersion: KANBAN_SCHEMA_VERSION,
      });

      await migrated.deleteTask(task.id, { confirmTaskId: task.id });
      const retainedEvents = await migrated.listEvents({ taskId: task.id });
      expect(retainedEvents.slice(0, -1)).toEqual(eventsBeforeMigration);
      expect(retainedEvents.at(-1)).toMatchObject({
        taskId: task.id,
        eventType: "task.deleted",
      });
      expect(retainedEvents.filter((event) => event.runId).map((event) => event.runId)).toEqual([
        runId,
        runId,
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("migrates legacy JSON exactly once with an exact private backup and fail-closed sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-migrate-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      const source = `${JSON.stringify(legacyBoardFixture(), null, 2)}\n`;
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });

      const store = new BoardStore(root);
      const tasks = await store.listTasks();
      expect(tasks).toEqual([
        expect.objectContaining({
          id: "B4",
          title: "Migrated design",
          status: "done",
          acceptanceCriteria: ["Migration verified"],
          priority: "high",
          labels: ["migration", "kanban"],
          checklist: [expect.objectContaining({ id: "C1", done: true })],
          artifacts: [expect.objectContaining({ kind: "summary", value: "migration complete" })],
          review: { required: true, reviewer: "reviewer" },
          assignee: "builder",
          runs: [expect.objectContaining({ id: "R3", status: "done", summary: "done" })],
          workspace: { mode: "worktree", path: "/tmp/kanban/B4", branch: "board/B4" },
          createdBy: expect.objectContaining({ messageThreadId: 7 }),
        }),
        expect.objectContaining({ id: "B7", dependencies: ["B4"] }),
      ]);

      const next = await store.createTask({
        title: "Next task",
        createdBy: { chatId: 1, userId: 2, conversationKey: "chat:1" },
      });
      expect(next.id).toBe("B8");

      const sentinel = JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>;
      expect(sentinel).toMatchObject({
        kind: "tarocub-kanban-migrated",
        authoritativeStore: "kanban.sqlite",
      });
      expect(sentinel.schemaVersion).toEqual(expect.any(Number));
      expect(sentinel.schemaVersion as number).toBeGreaterThan(CURRENT_SCHEMA_VERSION);

      const backups = (await readdir(root)).filter((entry) => entry.startsWith("board.json.migration-") && entry.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const backupPath = path.join(root, backups[0]!);
      expect(await readFile(backupPath, "utf8")).toBe(source);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);

      const diagnostics = await store.diagnostics();
      expect(diagnostics).toMatchObject({
        ok: true,
        taskCount: 3,
        runCount: 1,
        lastMigration: expect.objectContaining({
          sourceTaskCount: 2,
          sourceRunCount: 1,
          backupPath,
        }),
      });

      const oldReader = new JsonStore<Record<string, unknown>>(legacyPath);
      await expect(oldReader.read({})).rejects.toThrow("schema version");

      await new BoardStore(root).listTasks();
      expect((await readdir(root)).filter((entry) => entry.startsWith("board.json.migration-"))).toHaveLength(1);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not create or replace anything when legacy JSON is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-invalid-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      const source = '{"tasks":[{"id":"B1"}]}\n';
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });

      await expect(new BoardStore(root).listTasks()).rejects.toThrow("invalid board store state");
      await expect(access(resolveKanbanDatabasePath(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(legacyPath, "utf8")).toBe(source);
      expect((await readdir(root)).filter((entry) => entry.includes("migration-") || entry.includes("kanban.sqlite."))).toEqual([]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects an existing empty database instead of silently replacing it with an empty board", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-empty-db-"));
    try {
      const databasePath = resolveKanbanDatabasePath(root);
      await writeFile(databasePath, "", { mode: 0o600 });

      await expect(new BoardStore(root).diagnostics()).resolves.toMatchObject({
        ok: false,
        initialized: false,
        schemaVersion: 0,
        issues: [expect.stringContaining("expected schema")],
      });
      expect((await stat(databasePath)).size).toBe(0);
      await expect(new BoardStore(root).listTasks()).rejects.toThrow(/empty or uninitialized/i);
      expect((await stat(databasePath)).size).toBe(0);
    } finally {
      await removeTempRoot(root);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link database without changing its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-db-symlink-"));
    const stateDir = path.join(root, "state");
    const targetPath = path.join(root, "outside.sqlite");
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(targetPath, "outside data", { mode: 0o644 });
      await chmod(targetPath, 0o644);
      await symlink(targetPath, resolveKanbanDatabasePath(stateDir));

      await expect(new BoardStore(stateDir).listTasks()).rejects.toThrow(/cannot be a symbolic link/i);
      expect(await readFile(targetPath, "utf8")).toBe("outside data");
      expect((await stat(targetPath)).mode & 0o777).toBe(0o644);
    } finally {
      await removeTempRoot(root);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link state directory without changing its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-state-symlink-"));
    const outsideState = path.join(root, "outside-state");
    const linkedState = path.join(root, "linked-state");
    try {
      await mkdir(outsideState, { mode: 0o755 });
      await chmod(outsideState, 0o755);
      await symlink(outsideState, linkedState);

      await expect(new BoardStore(linkedState).listTasks()).rejects.toThrow(/state directory.*symbolic link/i);
      expect((await stat(outsideState)).mode & 0o777).toBe(0o755);
      await expect(access(resolveKanbanDatabasePath(outsideState))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link asset root without chmodding its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-assets-symlink-"));
    const stateDir = path.join(root, "state");
    const outsideAssets = path.join(root, "outside-assets");
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await mkdir(outsideAssets, { mode: 0o755 });
      await chmod(outsideAssets, 0o755);
      await symlink(outsideAssets, resolveKanbanAssetDirectory(stateDir));

      await expect(new BoardStore(stateDir).listTasks()).rejects.toThrow(/asset root.*symbolic link/i);
      expect((await stat(outsideAssets)).mode & 0o777).toBe(0o755);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("finishes the sentinel step after an interrupted migration publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-sentinel-recovery-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      const source = `${JSON.stringify(legacyBoardFixture(), null, 2)}\n`;
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });
      await new BoardStore(root).listTasks();

      // Simulate a crash after kanban.sqlite was published but before board.json
      // was replaced by the fail-closed marker.
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });
      await new BoardStore(root).listTasks();

      const sentinel = JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>;
      expect(sentinel).toMatchObject({
        kind: "tarocub-kanban-migrated",
        authoritativeStore: "kanban.sqlite",
      });
      expect((await readdir(root)).filter((entry) => entry.startsWith("board.json.migration-"))).toHaveLength(1);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps an authoritative migrated Board usable after its optional backup is removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-backup-cleanup-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      await writeFile(legacyPath, `${JSON.stringify(legacyBoardFixture(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await new BoardStore(root).listTasks();

      const sentinel = JSON.parse(await readFile(legacyPath, "utf8")) as { backupFile: string };
      await unlink(path.join(root, sentinel.backupFile));

      await expect(new BoardStore(root).listTasks()).resolves.toHaveLength(2);
      await expect(new BoardStore(root).diagnostics()).resolves.toMatchObject({ ok: true });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("fails closed when legacy JSON beside an existing database does not match its migration receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-store-conflict-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      await writeFile(legacyPath, `${JSON.stringify(legacyBoardFixture(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await new BoardStore(root).listTasks();
      await writeFile(legacyPath, `${JSON.stringify({ ...legacyBoardFixture(), nextTaskId: 99 }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      await expect(new BoardStore(root).diagnostics()).resolves.toMatchObject({
        ok: false,
        issues: [expect.stringContaining("conflicts with the authoritative SQLite database")],
      });
      await expect(new BoardStore(root).listTasks()).rejects.toThrow(/conflicting legacy board/i);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("refuses interrupted sentinel recovery when the retained backup no longer matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-backup-corrupt-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      const source = `${JSON.stringify(legacyBoardFixture(), null, 2)}\n`;
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });
      await new BoardStore(root).listTasks();
      const sentinel = JSON.parse(await readFile(legacyPath, "utf8")) as { backupFile: string };
      await writeFile(path.join(root, sentinel.backupFile), "corrupt backup\n", { encoding: "utf8", mode: 0o600 });
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });

      await expect(new BoardStore(root).listTasks()).rejects.toThrow(/backup hash does not match/i);
      expect(await readFile(legacyPath, "utf8")).toBe(source);
      await expect(new BoardStore(root).diagnostics()).resolves.toMatchObject({
        ok: false,
        issues: [expect.stringContaining("backup hash does not match")],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps valid legacy JSON authoritative when relational import checks fail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-import-fail-"));
    try {
      const legacyPath = resolveBoardStorePath(root);
      const fixture = legacyBoardFixture();
      const tasks = fixture.tasks as Array<Record<string, unknown>>;
      tasks[1]!.dependencies = ["B999"];
      const source = `${JSON.stringify(fixture, null, 2)}\n`;
      await writeFile(legacyPath, source, { encoding: "utf8", mode: 0o600 });

      await expect(new BoardStore(root).listTasks()).rejects.toThrow();
      await expect(access(resolveKanbanDatabasePath(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(legacyPath, "utf8")).toBe(source);
      expect((await readdir(root)).filter((entry) => entry.startsWith("board.json.migration-")).length).toBe(1);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("enforces one active run per task at the database boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-kanban-run-constraint-"));
    try {
      const store = new BoardStore(root);
      await store.createTask({
        title: "Single active run",
        createdBy: { chatId: 1, userId: 2, conversationKey: "chat:1" },
      });
      await store.startTask("B1");

      await expect(databaseRun(
        resolveKanbanDatabasePath(root),
        "INSERT INTO runs (id, task_id, status, started_at, position, extensions_json) VALUES (?, ?, ?, ?, ?, ?)",
        ["R999", "B1", "running", new Date().toISOString(), 99, "{}"],
      )).rejects.toThrow(/UNIQUE constraint failed/i);
    } finally {
      await removeTempRoot(root);
    }
  });
});
