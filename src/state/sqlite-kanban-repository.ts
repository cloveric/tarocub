import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import sqlite3 from "sqlite3";

import type {
  BoardArtifact,
  BoardChecklistItem,
  BoardStoreState,
  BoardTaskRecord,
  BoardTaskRun,
} from "./board-store-schema.js";
import { withFileMutex } from "./file-mutex.js";
import { CURRENT_SCHEMA_VERSION } from "./schema-version.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-permissions.js";

export const KANBAN_SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_SENTINEL_SCHEMA_VERSION = Number.MAX_SAFE_INTEGER;

export type SqliteValue = string | number | bigint | Buffer | null;
export type SqliteParams = SqliteValue[] | Record<string, SqliteValue>;

export type BoardMigrationReceipt = {
  sourceSha256: string;
  backupPath: string;
  sourceTaskCount: number;
  sourceRunCount: number;
  schemaVersion: number;
  completedAt: string;
};

export type BoardDiagnostics = {
  ok: boolean;
  initialized: boolean;
  pendingLegacyMigration: boolean;
  databasePath: string;
  schemaVersion: number;
  integrityCheck: string;
  foreignKeyViolations: number;
  taskCount: number;
  runCount: number;
  activeRunConflicts: number;
  dependencyCycle: string[] | null;
  issues: string[];
  lastMigration?: BoardMigrationReceipt;
};

export type SqliteKanbanRepositoryOptions = {
  parseState: (value: unknown) => BoardStoreState;
  createDefaultState: () => BoardStoreState;
};

type MetaRow = { value: string };
type CountRow = { count: number };
type IntegrityRow = { integrity_check: string };
type UserVersionRow = { user_version: number };
type ForeignKeyViolationRow = Record<string, unknown>;

type TaskRow = {
  id: string;
  board_slug: string;
  parent_task_id: string | null;
  title: string;
  status: BoardTaskRecord["status"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  description: string | null;
  acceptance_criteria_json: string;
  priority: BoardTaskRecord["priority"];
  review_required: number;
  reviewer: string | null;
  summary: string | null;
  blocked_reason: string | null;
  assignee: string | null;
  workspace_json: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  engine: string | null;
  model: string | null;
  effort: string | null;
  timeout_ms: number | null;
  max_retries: number | null;
  created_by_json: string;
  revision: number;
  position: number;
  extensions_json: string;
};

type DependencyRow = { task_id: string; depends_on_task_id: string; position: number };
type LabelRow = { task_id: string; label: string; position: number };
type ChecklistRow = {
  task_id: string;
  item_id: string;
  text: string;
  done: number;
  created_at: string;
  completed_at: string | null;
  position: number;
  extensions_json: string;
};
type ArtifactRow = {
  id: number;
  task_id: string;
  kind: string;
  value: string;
  created_at: string | null;
  position: number;
  extensions_json: string;
};
type RunRow = {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  last_heartbeat_at: string | null;
  heartbeat_note: string | null;
  completed_at: string | null;
  summary: string | null;
  error: string | null;
  log_text: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  position: number;
  extensions_json: string;
};
type MigrationRow = {
  source_sha256: string;
  backup_path: string;
  source_task_count: number;
  source_run_count: number;
  schema_version: number;
  completed_at: string;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  dispatcher_policy TEXT NOT NULL DEFAULT 'manual' CHECK (dispatcher_policy IN ('manual', 'automatic')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS board_contexts (
  conversation_key TEXT PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status TEXT NOT NULL CHECK (status IN ('triage', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  description TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  reviewer TEXT,
  summary TEXT,
  blocked_reason TEXT,
  assignee TEXT,
  workspace_json TEXT,
  scheduled_at TEXT,
  timezone TEXT,
  engine TEXT,
  model TEXT,
  effort TEXT,
  timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms >= 0),
  max_retries INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
  created_by_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  position INTEGER NOT NULL,
  extensions_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
) STRICT;

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (task_id, label)
) STRICT;

CREATE TABLE IF NOT EXISTS checklist_items (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  position INTEGER NOT NULL,
  extensions_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (task_id, item_id)
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT,
  position INTEGER NOT NULL,
  extensions_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  media_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  actor_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'review_requested', 'succeeded', 'failed', 'blocked', 'cancelled', 'timed_out')),
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  heartbeat_note TEXT,
  completed_at TEXT,
  summary TEXT,
  error TEXT,
  log_text TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  position INTEGER NOT NULL,
  extensions_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
ON runs(task_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS claims (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  -- Immutable audit correlation survives deletion of the mutable task/run rows.
  task_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  actor_json TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS unique_event_idempotency_key
ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL,
  event_filter_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (board_id, conversation_key)
) STRICT;

CREATE TABLE IF NOT EXISTS migration_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_sha256 TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  source_task_count INTEGER NOT NULL CHECK (source_task_count >= 0),
  source_run_count INTEGER NOT NULL CHECK (source_run_count >= 0),
  schema_version INTEGER NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;
`;

export function resolveKanbanDatabasePath(stateDir: string): string {
  return path.join(stateDir, "kanban.sqlite");
}

export function resolveKanbanAssetDirectory(stateDir: string): string {
  return path.join(stateDir, "kanban-assets");
}

function resolveLegacyBoardPath(stateDir: string): string {
  return path.join(stateDir, "board.json");
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function requireRegularFile(targetPath: string, label: string): Promise<void> {
  const stats = await lstat(targetPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file and cannot be a symbolic link: ${targetPath}`);
  }
}

async function ensurePrivateDirectory(directoryPath: string, label: string): Promise<void> {
  if (await pathExists(directoryPath)) {
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} must be a directory and cannot be a symbolic link: ${directoryPath}`);
    }
  } else {
    await mkdir(directoryPath, { recursive: true, mode: STATE_DIR_MODE });
  }
  await chmod(directoryPath, STATE_DIR_MODE);
}

function openDatabase(filePath: string, mode: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, mode, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(database);
      }
    });
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve());
  });
}

function exec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve());
  });
}

function run(database: sqlite3.Database, sql: string, params: SqliteParams = []): Promise<{ changes: number; lastID: number }> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
      } else {
        resolve({ changes: this.changes, lastID: this.lastID });
      }
    });
  });
}

function get<T>(database: sqlite3.Database, sql: string, params: SqliteParams = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get<T>(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all<T>(database: sqlite3.Database, sql: string, params: SqliteParams = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all<T>(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

async function configureDatabase(database: sqlite3.Database, writable: boolean, useWal = true): Promise<void> {
  database.configure("busyTimeout", DEFAULT_BUSY_TIMEOUT_MS);
  await exec(database, "PRAGMA foreign_keys = ON");
  await exec(database, `PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
  if (writable) {
    await get<Record<string, string>>(database, `PRAGMA journal_mode = ${useWal ? "WAL" : "DELETE"}`);
    await exec(database, "PRAGMA synchronous = FULL");
  }
}

async function createPrivateEmptyFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
  const handle = await open(filePath, "wx", STATE_FILE_MODE);
  await handle.close();
}

async function tightenSqlitePermissions(databasePath: string): Promise<void> {
  await chmod(path.dirname(databasePath), STATE_DIR_MODE).catch(() => undefined);
  for (const suffix of ["", "-wal", "-shm"]) {
    const targetPath = `${databasePath}${suffix}`;
    if (!await pathExists(targetPath)) continue;
    await requireRegularFile(targetPath, "Kanban SQLite state");
    await chmod(targetPath, STATE_FILE_MODE);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function objectWithoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  const output = { ...(value as Record<string, unknown>) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
}

const TASK_KEYS = [
  "id", "boardSlug", "parentTaskId", "title", "status", "createdAt", "updatedAt", "completedAt", "description",
  "acceptanceCriteria", "priority", "labels", "checklist", "artifacts", "review",
  "summary", "blockedReason", "assignee", "dependencies", "runs", "workspace", "scheduledAt", "timezone",
  "execution", "revision", "createdBy",
] as const;
const RUN_KEYS = [
  "id", "status", "startedAt", "lastHeartbeatAt", "heartbeatNote", "completedAt", "summary", "error",
  "logText", "inputTokens", "outputTokens", "costUsd",
] as const;
const CHECKLIST_KEYS = ["id", "text", "done", "createdAt", "completedAt"] as const;
const ARTIFACT_KEYS = ["kind", "value", "createdAt"] as const;

function toSqlRunStatus(status: BoardTaskRun["status"]): string {
  return status === "done" ? "succeeded" : status;
}

function fromSqlRunStatus(status: string): BoardTaskRun["status"] {
  if (status === "succeeded") {
    return "done";
  }
  if (
    status === "running"
    || status === "review_requested"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "timed_out"
  ) {
    return status;
  }
  throw new Error(`unsupported run status in current Board compatibility layer: ${status}`);
}

async function getMetaNumber(database: sqlite3.Database, key: string, fallback: number): Promise<number> {
  const row = await get<MetaRow>(database, "SELECT value FROM meta WHERE key = ?", [key]);
  const parsed = row ? Number.parseInt(row.value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readStateFromDatabase(database: sqlite3.Database): Promise<BoardStoreState> {
  const [taskRows, dependencyRows, labelRows, checklistRows, artifactRows, runRows, boardRow] = await Promise.all([
    all<TaskRow>(database, `
      SELECT tasks.*, boards.slug AS board_slug
      FROM tasks
      JOIN boards ON boards.id = tasks.board_id
      ORDER BY tasks.position, tasks.id
    `),
    all<DependencyRow>(database, "SELECT task_id, depends_on_task_id, position FROM task_dependencies ORDER BY task_id, position"),
    all<LabelRow>(database, "SELECT task_id, label, position FROM task_labels ORDER BY task_id, position"),
    all<ChecklistRow>(database, "SELECT * FROM checklist_items ORDER BY task_id, position"),
    all<ArtifactRow>(database, "SELECT * FROM artifacts ORDER BY task_id, position, id"),
    all<RunRow>(database, "SELECT * FROM runs ORDER BY task_id, position, id"),
    get<{ settings_json: string }>(database, "SELECT settings_json FROM boards WHERE slug = 'main'"),
  ]);

  const dependencies = new Map<string, string[]>();
  for (const row of dependencyRows) {
    const list = dependencies.get(row.task_id) ?? [];
    list.push(row.depends_on_task_id);
    dependencies.set(row.task_id, list);
  }
  const labels = new Map<string, string[]>();
  for (const row of labelRows) {
    const list = labels.get(row.task_id) ?? [];
    list.push(row.label);
    labels.set(row.task_id, list);
  }
  const checklist = new Map<string, BoardChecklistItem[]>();
  for (const row of checklistRows) {
    const extension = parseJson<Record<string, unknown>>(row.extensions_json, `checklist ${row.item_id}`);
    const item = {
      ...extension,
      id: row.item_id,
      text: row.text,
      done: row.done === 1,
      createdAt: row.created_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    } as BoardChecklistItem;
    const list = checklist.get(row.task_id) ?? [];
    list.push(item);
    checklist.set(row.task_id, list);
  }
  const artifacts = new Map<string, BoardArtifact[]>();
  for (const row of artifactRows) {
    const extension = parseJson<Record<string, unknown>>(row.extensions_json, `artifact ${row.id}`);
    const artifact = {
      ...extension,
      kind: row.kind,
      value: row.value,
      ...(row.created_at ? { createdAt: row.created_at } : {}),
    } as BoardArtifact;
    const list = artifacts.get(row.task_id) ?? [];
    list.push(artifact);
    artifacts.set(row.task_id, list);
  }
  const runs = new Map<string, BoardTaskRun[]>();
  for (const row of runRows) {
    const extension = parseJson<Record<string, unknown>>(row.extensions_json, `run ${row.id}`);
    const runRecord = {
      ...extension,
      id: row.id,
      status: fromSqlRunStatus(row.status),
      startedAt: row.started_at,
      ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
      ...(row.heartbeat_note ? { heartbeatNote: row.heartbeat_note } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.log_text ? { logText: row.log_text } : {}),
      ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
      ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
      ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    } as BoardTaskRun;
    const list = runs.get(row.task_id) ?? [];
    list.push(runRecord);
    runs.set(row.task_id, list);
  }

  const tasks = taskRows.map((row) => {
    const extension = parseJson<Record<string, unknown>>(row.extensions_json, `task ${row.id}`);
    return {
      ...extension,
      id: row.id,
      boardSlug: row.board_slug,
      ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.description ? { description: row.description } : {}),
      acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria_json, `task ${row.id} acceptance criteria`),
      priority: row.priority,
      labels: labels.get(row.id) ?? [],
      checklist: checklist.get(row.id) ?? [],
      artifacts: artifacts.get(row.id) ?? [],
      review: {
        required: row.review_required === 1,
        ...(row.reviewer ? { reviewer: row.reviewer } : {}),
      },
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.assignee ? { assignee: row.assignee } : {}),
      dependencies: dependencies.get(row.id) ?? [],
      runs: runs.get(row.id) ?? [],
      ...(row.workspace_json ? { workspace: parseJson(row.workspace_json, `task ${row.id} workspace`) } : {}),
      ...(row.scheduled_at ? { scheduledAt: row.scheduled_at } : {}),
      ...(row.timezone ? { timezone: row.timezone } : {}),
      execution: {
        ...(row.engine ? { engine: row.engine } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
        ...(row.max_retries !== null ? { maxRetries: row.max_retries } : {}),
      },
      revision: row.revision,
      createdBy: parseJson(row.created_by_json, `task ${row.id} actor`),
    } as BoardTaskRecord;
  });

  const settings = boardRow
    ? parseJson<Partial<BoardStoreState["limits"]>>(boardRow.settings_json, "main board settings")
    : {};
  const maxTaskNumber = tasks.reduce((maximum, task) => {
    const match = task.id.match(/^B(\d+)$/i);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  const maxRunNumber = tasks.flatMap((task) => task.runs).reduce((maximum, taskRun) => {
    const match = taskRun.id.match(/^R(\d+)$/i);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);

  return {
    nextTaskId: await getMetaNumber(database, "next_task_id", maxTaskNumber + 1),
    nextRunId: await getMetaNumber(database, "next_run_id", maxRunNumber + 1),
    limits: {
      global: settings.global ?? 3,
      perAssignee: settings.perAssignee ?? 1,
      perConversation: settings.perConversation ?? 1,
    },
    tasks,
  };
}

async function replaceStateInDatabase(database: sqlite3.Database, state: BoardStoreState): Promise<void> {
  const timestamp = new Date().toISOString();
  const existingMain = await get<{ settings_json: string }>(database, "SELECT settings_json FROM boards WHERE slug = 'main'");
  const existingMainSettings = existingMain
    ? parseJson<Record<string, unknown>>(existingMain.settings_json, "main board settings")
    : {};
  await run(database, `
    INSERT INTO boards (id, slug, name, settings_json, dispatcher_policy, created_at, updated_at)
    VALUES (1, 'main', 'Main', ?, 'manual', ?, ?)
    ON CONFLICT(slug) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `, [JSON.stringify({
    ...existingMainSettings,
    ...state.limits,
    limits: {
      ...(typeof existingMainSettings.limits === "object" && existingMainSettings.limits !== null
        ? existingMainSettings.limits as Record<string, unknown>
        : {}),
      ...state.limits,
    },
  }), timestamp, timestamp]);
  await run(database, "INSERT INTO meta (key, value) VALUES ('next_task_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(state.nextTaskId)]);
  await run(database, "INSERT INTO meta (key, value) VALUES ('next_run_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(state.nextRunId)]);

  const boardRows = await all<{ id: number; slug: string }>(database, "SELECT id, slug FROM boards");
  const boardIds = new Map(boardRows.map((row) => [row.slug, row.id]));
  for (let taskPosition = 0; taskPosition < state.tasks.length; taskPosition++) {
    const task = state.tasks[taskPosition]!;
    const boardId = boardIds.get(task.boardSlug || "main");
    if (!boardId) {
      throw new Error(`board not found for task ${task.id}: ${task.boardSlug}`);
    }
    const extension = objectWithoutKeys(task, TASK_KEYS);
    await run(database, `
      INSERT INTO tasks (
        id, board_id, parent_task_id, title, status, created_at, updated_at, completed_at, description,
        acceptance_criteria_json, priority, review_required, reviewer, summary, blocked_reason,
        assignee, workspace_json, scheduled_at, timezone, engine, model, effort, timeout_ms, max_retries,
        created_by_json, revision, position, extensions_json
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        board_id = excluded.board_id,
        title = excluded.title,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        description = excluded.description,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        priority = excluded.priority,
        review_required = excluded.review_required,
        reviewer = excluded.reviewer,
        summary = excluded.summary,
        blocked_reason = excluded.blocked_reason,
        assignee = excluded.assignee,
        workspace_json = excluded.workspace_json,
        scheduled_at = excluded.scheduled_at,
        timezone = excluded.timezone,
        engine = excluded.engine,
        model = excluded.model,
        effort = excluded.effort,
        timeout_ms = excluded.timeout_ms,
        max_retries = excluded.max_retries,
        created_by_json = excluded.created_by_json,
        revision = excluded.revision,
        position = excluded.position,
        extensions_json = excluded.extensions_json
    `, [
      task.id,
      boardId,
      task.title,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
      task.description ?? null,
      JSON.stringify(task.acceptanceCriteria),
      task.priority,
      task.review.required ? 1 : 0,
      task.review.reviewer ?? null,
      task.summary ?? null,
      task.blockedReason ?? null,
      task.assignee ?? null,
      task.workspace ? JSON.stringify(task.workspace) : null,
      task.scheduledAt ?? null,
      task.timezone ?? null,
      task.execution.engine ?? null,
      task.execution.model ?? null,
      task.execution.effort ?? null,
      task.execution.timeoutMs ?? null,
      task.execution.maxRetries ?? null,
      JSON.stringify(task.createdBy),
      task.revision,
      taskPosition,
      JSON.stringify(extension),
    ]);
  }

  const retainedTaskIds = new Set(state.tasks.map((task) => task.id));
  const existingTaskIds = await all<{ id: string }>(database, "SELECT id FROM tasks");
  for (const row of existingTaskIds) {
    if (!retainedTaskIds.has(row.id)) {
      await run(database, "DELETE FROM tasks WHERE id = ?", [row.id]);
    }
  }

  for (const task of state.tasks) {
    if (task.parentTaskId) {
      await run(database, "UPDATE tasks SET parent_task_id = ? WHERE id = ?", [task.parentTaskId, task.id]);
    } else {
      await run(database, "UPDATE tasks SET parent_task_id = NULL WHERE id = ?", [task.id]);
    }
  }

  for (const task of state.tasks) {
    await run(database, "DELETE FROM task_dependencies WHERE task_id = ?", [task.id]);
    await run(database, "DELETE FROM task_labels WHERE task_id = ?", [task.id]);
    await run(database, "DELETE FROM checklist_items WHERE task_id = ?", [task.id]);
    await run(database, "DELETE FROM artifacts WHERE task_id = ?", [task.id]);
    for (let position = 0; position < task.dependencies.length; position++) {
      await run(database, "INSERT INTO task_dependencies (task_id, depends_on_task_id, position) VALUES (?, ?, ?)", [
        task.id,
        task.dependencies[position]!,
        position,
      ]);
    }
    for (let position = 0; position < task.labels.length; position++) {
      await run(database, "INSERT INTO task_labels (task_id, label, position) VALUES (?, ?, ?)", [
        task.id,
        task.labels[position]!,
        position,
      ]);
    }
    for (let position = 0; position < task.checklist.length; position++) {
      const item = task.checklist[position]!;
      await run(database, `
        INSERT INTO checklist_items (
          task_id, item_id, text, done, created_at, completed_at, position, extensions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        task.id,
        item.id,
        item.text,
        item.done ? 1 : 0,
        item.createdAt,
        item.completedAt ?? null,
        position,
        JSON.stringify(objectWithoutKeys(item, CHECKLIST_KEYS)),
      ]);
    }
    for (let position = 0; position < task.artifacts.length; position++) {
      const artifact = task.artifacts[position]!;
      await run(database, `
        INSERT INTO artifacts (task_id, kind, value, created_at, position, extensions_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        task.id,
        artifact.kind,
        artifact.value,
        artifact.createdAt ?? null,
        position,
        JSON.stringify(objectWithoutKeys(artifact, ARTIFACT_KEYS)),
      ]);
    }
    const retainedRunIds = new Set(task.runs.map((taskRun) => taskRun.id));
    for (let position = 0; position < task.runs.length; position++) {
      const taskRun = task.runs[position]!;
      await run(database, `
        INSERT INTO runs (
          id, task_id, status, started_at, last_heartbeat_at, heartbeat_note,
          completed_at, summary, error, log_text, input_tokens, output_tokens, cost_usd,
          position, extensions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          status = excluded.status,
          started_at = excluded.started_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          heartbeat_note = excluded.heartbeat_note,
          completed_at = excluded.completed_at,
          summary = excluded.summary,
          error = excluded.error,
          log_text = excluded.log_text,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cost_usd = excluded.cost_usd,
          position = excluded.position,
          extensions_json = excluded.extensions_json
      `, [
        taskRun.id,
        task.id,
        toSqlRunStatus(taskRun.status),
        taskRun.startedAt,
        taskRun.lastHeartbeatAt ?? null,
        taskRun.heartbeatNote ?? null,
        taskRun.completedAt ?? null,
        taskRun.summary ?? null,
        taskRun.error ?? null,
        taskRun.logText ?? null,
        taskRun.inputTokens ?? null,
        taskRun.outputTokens ?? null,
        taskRun.costUsd ?? null,
        position,
        JSON.stringify(objectWithoutKeys(taskRun, RUN_KEYS)),
      ]);
    }
    const existingRunIds = await all<{ id: string }>(database, "SELECT id FROM runs WHERE task_id = ?", [task.id]);
    for (const row of existingRunIds) {
      if (!retainedRunIds.has(row.id)) {
        await run(database, "DELETE FROM runs WHERE id = ?", [row.id]);
      }
    }
  }
}

async function applySchema(database: sqlite3.Database): Promise<void> {
  const versionRow = await get<UserVersionRow>(database, "PRAGMA user_version");
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > KANBAN_SCHEMA_VERSION) {
    throw new Error(`Kanban database schema ${currentVersion} is newer than supported ${KANBAN_SCHEMA_VERSION}; upgrade TaroCub`);
  }
  if (currentVersion < 1) {
    await exec(database, SCHEMA_SQL);
    await exec(database, `PRAGMA user_version = ${KANBAN_SCHEMA_VERSION}`);
    return;
  }
  if (currentVersion < 2) {
    await exec(database, `
      CREATE TABLE events_v2 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        -- Immutable audit correlation survives deletion of the mutable task/run rows.
        task_id TEXT,
        run_id TEXT,
        event_type TEXT NOT NULL,
        actor_json TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO events_v2 (
        sequence, board_id, task_id, run_id, event_type,
        actor_json, payload_json, idempotency_key, created_at
      )
      SELECT
        sequence, board_id, task_id, run_id, event_type,
        actor_json, payload_json, idempotency_key, created_at
      FROM events
      ORDER BY sequence;

      DROP TABLE events;
      ALTER TABLE events_v2 RENAME TO events;

      CREATE UNIQUE INDEX unique_event_idempotency_key
      ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    await exec(database, `PRAGMA user_version = ${KANBAN_SCHEMA_VERSION}`);
  }
}

async function assertDatabaseHealthy(database: sqlite3.Database): Promise<void> {
  const versionRow = await get<UserVersionRow>(database, "PRAGMA user_version");
  if (versionRow?.user_version !== KANBAN_SCHEMA_VERSION) {
    throw new Error(`Kanban database schema check failed: expected ${KANBAN_SCHEMA_VERSION}, got ${versionRow?.user_version ?? "unknown"}`);
  }
  const integrity = await get<{ quick_check: string }>(database, "PRAGMA quick_check(1)");
  if (integrity?.quick_check !== "ok") {
    throw new Error(`Kanban database quick check failed: ${integrity?.quick_check ?? "no result"}`);
  }
  const foreignKeys = await all<ForeignKeyViolationRow>(database, "PRAGMA foreign_key_check");
  if (foreignKeys.length > 0) {
    throw new Error(`Kanban database foreign-key check failed with ${foreignKeys.length} violation(s)`);
  }
}

function findDependencyCycle(rows: DependencyRow[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    const dependencies = graph.get(row.task_id) ?? [];
    dependencies.push(row.depends_on_task_id);
    graph.set(row.task_id, dependencies);
    if (!graph.has(row.depends_on_task_id)) {
      graph.set(row.depends_on_task_id, []);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const currentPath: string[] = [];
  const visit = (taskId: string): string[] | null => {
    if (visiting.has(taskId)) {
      const start = currentPath.indexOf(taskId);
      return [...currentPath.slice(start), taskId];
    }
    if (visited.has(taskId)) {
      return null;
    }
    visiting.add(taskId);
    currentPath.push(taskId);
    for (const dependencyId of graph.get(taskId) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    currentPath.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };
  for (const taskId of graph.keys()) {
    const cycle = visit(taskId);
    if (cycle) return cycle;
  }
  return null;
}

async function inspectDatabase(database: sqlite3.Database, databasePath: string): Promise<BoardDiagnostics> {
  const [version, integrity, foreignKeys] = await Promise.all([
    get<UserVersionRow>(database, "PRAGMA user_version"),
    get<IntegrityRow>(database, "PRAGMA integrity_check"),
    all<ForeignKeyViolationRow>(database, "PRAGMA foreign_key_check"),
  ]);
  const schemaVersion = version?.user_version ?? 0;
  const issues: string[] = [];
  if (schemaVersion !== KANBAN_SCHEMA_VERSION) {
    issues.push(`expected schema ${KANBAN_SCHEMA_VERSION}, got ${schemaVersion}`);
  }
  if (integrity?.integrity_check !== "ok") {
    issues.push(`integrity check: ${integrity?.integrity_check ?? "no result"}`);
  }
  if (foreignKeys.length > 0) {
    issues.push(`${foreignKeys.length} foreign-key violation(s)`);
  }
  if (schemaVersion !== KANBAN_SCHEMA_VERSION) {
    return {
      ok: false,
      initialized: false,
      pendingLegacyMigration: false,
      databasePath,
      schemaVersion,
      integrityCheck: integrity?.integrity_check ?? "no result",
      foreignKeyViolations: foreignKeys.length,
      taskCount: 0,
      runCount: 0,
      activeRunConflicts: 0,
      dependencyCycle: null,
      issues,
    };
  }

  const [taskCount, runCount, activeConflicts, dependencies, migration] = await Promise.all([
    get<CountRow>(database, "SELECT count(*) AS count FROM tasks"),
    get<CountRow>(database, "SELECT count(*) AS count FROM runs"),
    get<CountRow>(database, "SELECT count(*) AS count FROM (SELECT task_id FROM runs WHERE status = 'running' GROUP BY task_id HAVING count(*) > 1)"),
    all<DependencyRow>(database, "SELECT task_id, depends_on_task_id, position FROM task_dependencies ORDER BY task_id, position"),
    get<MigrationRow>(database, "SELECT source_sha256, backup_path, source_task_count, source_run_count, schema_version, completed_at FROM migration_history ORDER BY id DESC LIMIT 1"),
  ]);
  const dependencyCycle = findDependencyCycle(dependencies);
  if ((activeConflicts?.count ?? 0) > 0) {
    issues.push(`${activeConflicts!.count} task(s) have multiple active runs`);
  }
  if (dependencyCycle) {
    issues.push(`dependency cycle: ${dependencyCycle.join(" -> ")}`);
  }
  const diagnostics: BoardDiagnostics = {
    ok: issues.length === 0,
    initialized: true,
    pendingLegacyMigration: false,
    databasePath,
    schemaVersion,
    integrityCheck: integrity?.integrity_check ?? "no result",
    foreignKeyViolations: foreignKeys.length,
    taskCount: taskCount?.count ?? 0,
    runCount: runCount?.count ?? 0,
    activeRunConflicts: activeConflicts?.count ?? 0,
    dependencyCycle,
    issues,
  };
  if (migration) {
    diagnostics.lastMigration = {
      sourceSha256: migration.source_sha256,
      backupPath: migration.backup_path,
      sourceTaskCount: migration.source_task_count,
      sourceRunCount: migration.source_run_count,
      schemaVersion: migration.schema_version,
      completedAt: migration.completed_at,
    };
  }
  return diagnostics;
}

async function writeMigrationSentinel(input: {
  legacyPath: string;
  sourceSha256: string;
  backupPath: string;
  completedAt: string;
}): Promise<void> {
  const directoryPath = path.dirname(input.legacyPath);
  const temporaryPath = `${input.legacyPath}.${randomUUID()}.tmp`;
  const sentinel = {
    schemaVersion: MIGRATION_SENTINEL_SCHEMA_VERSION,
    kind: "tarocub-kanban-migrated",
    authoritativeStore: "kanban.sqlite",
    sourceSha256: input.sourceSha256,
    backupFile: path.basename(input.backupPath),
    completedAt: input.completedAt,
  };
  let renamed = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(sentinel, null, 2)}\n`, { encoding: "utf8", mode: STATE_FILE_MODE });
    await syncFile(temporaryPath);
    await rename(temporaryPath, input.legacyPath);
    renamed = true;
    await chmod(input.legacyPath, STATE_FILE_MODE);
    await syncDirectory(directoryPath);
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function backupSuffix(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

async function createLegacyBackup(legacyPath: string, now: Date): Promise<string> {
  await requireRegularFile(legacyPath, "Legacy Board state");
  const backupPath = `${legacyPath}.migration-${backupSuffix(now)}-${randomUUID()}.bak`;
  await copyFile(legacyPath, backupPath);
  await chmod(backupPath, STATE_FILE_MODE);
  await syncFile(backupPath);
  return backupPath;
}

async function sha256File(filePath: string, label: string): Promise<string> {
  await requireRegularFile(filePath, label);
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function verifyMigrationBackup(
  migration: MigrationRow,
  legacyPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const expectedPrefix = `${path.basename(legacyPath)}.migration-`;
  if (
    path.dirname(path.resolve(migration.backup_path)) !== path.dirname(path.resolve(legacyPath))
    || !path.basename(migration.backup_path).startsWith(expectedPrefix)
    || !migration.backup_path.endsWith(".bak")
  ) {
    throw new Error(`Kanban migration receipt has an invalid backup path: ${migration.backup_path}`);
  }
  if (options.allowMissing && !await pathExists(migration.backup_path)) {
    return;
  }
  const backupSha256 = await sha256File(migration.backup_path, "Kanban migration backup");
  if (backupSha256 !== migration.source_sha256) {
    throw new Error(`Kanban migration backup hash does not match its receipt: ${migration.backup_path}`);
  }
}

async function removeTemporaryDatabaseFiles(databasePath: string): Promise<void> {
  await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(`${databasePath}${suffix}`, { force: true })));
}

export class SqliteKanbanRepository {
  private readonly databasePath: string;
  private readonly legacyPath: string;
  private readonly transactionContext = new AsyncLocalStorage<sqlite3.Database>();
  private readyPromise: Promise<void> | undefined;

  constructor(
    private readonly stateDir: string,
    private readonly options: SqliteKanbanRepositoryOptions,
  ) {
    this.databasePath = resolveKanbanDatabasePath(stateDir);
    this.legacyPath = resolveLegacyBoardPath(stateDir);
  }

  async readState(): Promise<BoardStoreState> {
    await this.ensureReady();
    const activeDatabase = this.transactionContext.getStore();
    if (activeDatabase) {
      return this.options.parseState(await readStateFromDatabase(activeDatabase));
    }
    const database = await openDatabase(this.databasePath, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX);
    try {
      await configureDatabase(database, false);
      return this.options.parseState(await readStateFromDatabase(database));
    } finally {
      await closeDatabase(database);
    }
  }

  async writeState(state: BoardStoreState): Promise<void> {
    const database = this.transactionContext.getStore();
    if (!database) {
      throw new Error("Kanban state writes require a repository transaction");
    }
    await replaceStateInDatabase(database, this.options.parseState(state));
  }

  async queryOne<T>(sql: string, params: SqliteParams = []): Promise<T | undefined> {
    await this.ensureReady();
    const activeDatabase = this.transactionContext.getStore();
    if (activeDatabase) {
      return await get<T>(activeDatabase, sql, params);
    }
    const database = await openDatabase(this.databasePath, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX);
    try {
      await configureDatabase(database, false);
      return await get<T>(database, sql, params);
    } finally {
      await closeDatabase(database);
    }
  }

  async queryAll<T>(sql: string, params: SqliteParams = []): Promise<T[]> {
    await this.ensureReady();
    const activeDatabase = this.transactionContext.getStore();
    if (activeDatabase) {
      return await all<T>(activeDatabase, sql, params);
    }
    const database = await openDatabase(this.databasePath, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX);
    try {
      await configureDatabase(database, false);
      return await all<T>(database, sql, params);
    } finally {
      await closeDatabase(database);
    }
  }

  async execute(sql: string, params: SqliteParams = []): Promise<{ changes: number; lastID: number }> {
    const database = this.transactionContext.getStore();
    if (!database) {
      throw new Error("Kanban SQL mutations require a repository transaction");
    }
    return await run(database, sql, params);
  }

  async backupTo(targetPath: string): Promise<string> {
    await this.ensureReady();
    const resolvedTarget = path.resolve(targetPath);
    if (await pathExists(resolvedTarget)) {
      throw new Error(`Kanban backup target already exists: ${resolvedTarget}`);
    }
    await mkdir(path.dirname(resolvedTarget), { recursive: true, mode: STATE_DIR_MODE });
    const database = await openDatabase(this.databasePath, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX);
    try {
      await configureDatabase(database, false);
      await run(database, "VACUUM INTO ?", [resolvedTarget]);
      await chmod(resolvedTarget, STATE_FILE_MODE);
      return resolvedTarget;
    } catch (error) {
      await rm(resolvedTarget, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await closeDatabase(database);
    }
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    const database = await openDatabase(
      this.databasePath,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX,
    );
    try {
      await configureDatabase(database, true);
      await exec(database, "BEGIN IMMEDIATE");
      try {
        const result = await this.transactionContext.run(database, operation);
        await exec(database, "COMMIT");
        return result;
      } catch (error) {
        await exec(database, "ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await closeDatabase(database);
      await tightenSqlitePermissions(this.databasePath);
    }
  }

  async diagnostics(): Promise<BoardDiagnostics> {
    if (!await pathExists(this.databasePath)) {
      return await this.inspectUninitializedState();
    }
    let database: sqlite3.Database | undefined;
    try {
      await requireRegularFile(this.databasePath, "Kanban database");
      database = await openDatabase(this.databasePath, sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX);
      await configureDatabase(database, false);
      const diagnostics = await inspectDatabase(database, this.databasePath);
      return await this.inspectLegacyCompatibility(diagnostics);
    } catch (error) {
      return {
        ok: false,
        initialized: true,
        pendingLegacyMigration: false,
        databasePath: this.databasePath,
        schemaVersion: -1,
        integrityCheck: "unavailable",
        foreignKeyViolations: 0,
        taskCount: 0,
        runCount: 0,
        activeRunConflicts: 0,
        dependencyCycle: null,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      if (database) {
        await closeDatabase(database).catch(() => undefined);
      }
    }
  }

  private async inspectUninitializedState(): Promise<BoardDiagnostics> {
    const base: BoardDiagnostics = {
      ok: true,
      initialized: false,
      pendingLegacyMigration: false,
      databasePath: this.databasePath,
      schemaVersion: 0,
      integrityCheck: "not initialized",
      foreignKeyViolations: 0,
      taskCount: 0,
      runCount: 0,
      activeRunConflicts: 0,
      dependencyCycle: null,
      issues: [],
    };
    if (!await pathExists(this.legacyPath)) {
      return base;
    }
    try {
      await requireRegularFile(this.legacyPath, "Legacy Board state");
      const source = await readFile(this.legacyPath, "utf8");
      const raw = JSON.parse(source) as unknown;
      if (
        typeof raw === "object"
        && raw !== null
        && (raw as Record<string, unknown>).kind === "tarocub-kanban-migrated"
      ) {
        return {
          ...base,
          ok: false,
          issues: ["legacy path is a migration sentinel but kanban.sqlite is missing"],
        };
      }
      const state = this.options.parseState(raw);
      return {
        ...base,
        pendingLegacyMigration: true,
        taskCount: state.tasks.length,
        runCount: state.tasks.reduce((count, task) => count + task.runs.length, 0),
      };
    } catch (error) {
      return {
        ...base,
        ok: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private async inspectLegacyCompatibility(diagnostics: BoardDiagnostics): Promise<BoardDiagnostics> {
    if (!await pathExists(this.legacyPath)) {
      return diagnostics;
    }
    const issues = [...diagnostics.issues];
    try {
      await requireRegularFile(this.legacyPath, "Legacy Board state");
      const source = await readFile(this.legacyPath, "utf8");
      const raw = JSON.parse(source) as unknown;
      const migration = diagnostics.lastMigration;
      if (
        typeof raw === "object"
        && raw !== null
        && (raw as Record<string, unknown>).kind === "tarocub-kanban-migrated"
      ) {
        const sentinel = raw as Record<string, unknown>;
        if (
          sentinel.authoritativeStore !== "kanban.sqlite"
          || !migration
          || sentinel.sourceSha256 !== migration.sourceSha256
          || sentinel.backupFile !== path.basename(migration.backupPath)
        ) {
          issues.push("legacy Board migration sentinel conflicts with the SQLite migration receipt");
        } else {
          await verifyMigrationBackup({
            source_sha256: migration.sourceSha256,
            backup_path: migration.backupPath,
            source_task_count: migration.sourceTaskCount,
            source_run_count: migration.sourceRunCount,
            schema_version: migration.schemaVersion,
            completed_at: migration.completedAt,
          }, this.legacyPath, { allowMissing: true });
        }
      } else {
        const sourceSha256 = createHash("sha256").update(source).digest("hex");
        if (!migration || migration.sourceSha256 !== sourceSha256) {
          issues.push("legacy Board state conflicts with the authoritative SQLite database");
        } else {
          await verifyMigrationBackup({
            source_sha256: migration.sourceSha256,
            backup_path: migration.backupPath,
            source_task_count: migration.sourceTaskCount,
            source_run_count: migration.sourceRunCount,
            schema_version: migration.schemaVersion,
            completed_at: migration.completedAt,
          }, this.legacyPath);
          issues.push("legacy Board migration sentinel publication is incomplete");
        }
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    return {
      ...diagnostics,
      ok: issues.length === 0,
      issues,
    };
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch((error) => {
        this.readyPromise = undefined;
        throw error;
      });
    }
    await this.readyPromise;
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.stateDir, "State directory");
    await ensurePrivateDirectory(resolveKanbanAssetDirectory(this.stateDir), "Kanban asset root");

    await withFileMutex(`${this.databasePath}.migration`, async () => {
      if (await pathExists(this.databasePath)) {
        await requireRegularFile(this.databasePath, "Kanban database");
        await this.prepareExistingDatabase();
        return;
      }
      if (await pathExists(this.legacyPath)) {
        await requireRegularFile(this.legacyPath, "Legacy Board state");
        await this.migrateLegacyDatabase();
        return;
      }
      await this.createFreshDatabase();
    });
  }

  private async prepareExistingDatabase(): Promise<void> {
    await requireRegularFile(this.databasePath, "Kanban database");
    const database = await openDatabase(
      this.databasePath,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX,
    );
    let migration: MigrationRow | undefined;
    try {
      await configureDatabase(database, false);
      const existingVersion = await get<UserVersionRow>(database, "PRAGMA user_version");
      if ((existingVersion?.user_version ?? 0) === 0) {
        throw new Error(`Kanban database ${this.databasePath} is empty or uninitialized; restore it or run board diagnostics`);
      }
      if ((existingVersion?.user_version ?? 0) > KANBAN_SCHEMA_VERSION) {
        throw new Error(
          `Kanban database schema ${existingVersion!.user_version} is newer than supported ${KANBAN_SCHEMA_VERSION}; upgrade TaroCub`,
        );
      }
      await configureDatabase(database, true);
      await exec(database, "BEGIN IMMEDIATE");
      try {
        await applySchema(database);
        const mainBoard = await get<{ count: number }>(database, "SELECT count(*) AS count FROM boards WHERE slug = 'main'");
        if ((mainBoard?.count ?? 0) === 0) {
          await replaceStateInDatabase(database, this.options.createDefaultState());
        }
        await assertDatabaseHealthy(database);
        migration = await get<MigrationRow>(database, "SELECT source_sha256, backup_path, source_task_count, source_run_count, schema_version, completed_at FROM migration_history ORDER BY id DESC LIMIT 1");
        await exec(database, "COMMIT");
      } catch (error) {
        await exec(database, "ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await closeDatabase(database);
      await tightenSqlitePermissions(this.databasePath);
    }
    await this.reconcileLegacySentinel(migration);
  }

  private async createFreshDatabase(): Promise<void> {
    const temporaryPath = `${this.databasePath}.${randomUUID()}.tmp`;
    try {
      await createPrivateEmptyFile(temporaryPath);
      const database = await openDatabase(temporaryPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX);
      try {
        await configureDatabase(database, true, false);
        await exec(database, "BEGIN IMMEDIATE");
        try {
          await applySchema(database);
          await replaceStateInDatabase(database, this.options.createDefaultState());
          await assertDatabaseHealthy(database);
          await exec(database, "COMMIT");
        } catch (error) {
          await exec(database, "ROLLBACK").catch(() => undefined);
          throw error;
        }
      } finally {
        await closeDatabase(database);
      }
      await syncFile(temporaryPath);
      await rename(temporaryPath, this.databasePath);
      await syncDirectory(this.stateDir);
      await this.prepareExistingDatabase();
    } catch (error) {
      await removeTemporaryDatabaseFiles(temporaryPath);
      throw error;
    }
  }

  private async migrateLegacyDatabase(): Promise<void> {
    await requireRegularFile(this.legacyPath, "Legacy Board state");
    const source = await readFile(this.legacyPath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`invalid board store state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      typeof raw === "object"
      && raw !== null
      && (raw as Record<string, unknown>).kind === "tarocub-kanban-migrated"
    ) {
      throw new Error(`Kanban database is missing but ${this.legacyPath} is a migration sentinel; restore kanban.sqlite from backup`);
    }
    if (
      typeof raw === "object"
      && raw !== null
      && typeof (raw as Record<string, unknown>).schemaVersion === "number"
      && ((raw as Record<string, unknown>).schemaVersion as number) > CURRENT_SCHEMA_VERSION
    ) {
      throw new Error(
        `State file board.json has schema version ${(raw as Record<string, unknown>).schemaVersion as number}, but this bridge supports up to ${CURRENT_SCHEMA_VERSION}. Upgrade the bridge.`,
      );
    }
    const state = this.options.parseState(raw);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const now = new Date();
    const completedAt = now.toISOString();
    const backupPath = await createLegacyBackup(this.legacyPath, now);
    const temporaryPath = `${this.databasePath}.${randomUUID()}.tmp`;
    try {
      await createPrivateEmptyFile(temporaryPath);
      const database = await openDatabase(temporaryPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX);
      try {
        await configureDatabase(database, true, false);
        await exec(database, "BEGIN IMMEDIATE");
        try {
          await applySchema(database);
          await replaceStateInDatabase(database, state);
          await run(database, `
            INSERT INTO migration_history (
              source_sha256, backup_path, source_task_count, source_run_count, schema_version, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `, [
            sourceSha256,
            backupPath,
            state.tasks.length,
            state.tasks.reduce((count, task) => count + task.runs.length, 0),
            KANBAN_SCHEMA_VERSION,
            completedAt,
          ]);
          const diagnostics = await inspectDatabase(database, temporaryPath);
          if (!diagnostics.ok
            || diagnostics.taskCount !== state.tasks.length
            || diagnostics.runCount !== state.tasks.reduce((count, task) => count + task.runs.length, 0)) {
            throw new Error(`Kanban migration verification failed: ${JSON.stringify(diagnostics)}`);
          }
          await exec(database, "COMMIT");
        } catch (error) {
          await exec(database, "ROLLBACK").catch(() => undefined);
          throw error;
        }
      } finally {
        await closeDatabase(database);
      }
      await syncFile(temporaryPath);
      await rename(temporaryPath, this.databasePath);
      await syncDirectory(this.stateDir);
      await writeMigrationSentinel({
        legacyPath: this.legacyPath,
        sourceSha256,
        backupPath,
        completedAt,
      });
      await this.prepareExistingDatabase();
    } catch (error) {
      await removeTemporaryDatabaseFiles(temporaryPath);
      throw error;
    }
  }

  private async reconcileLegacySentinel(migration: MigrationRow | undefined): Promise<void> {
    if (!await pathExists(this.legacyPath)) {
      return;
    }
    await requireRegularFile(this.legacyPath, "Legacy Board state");
    const source = await readFile(this.legacyPath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Conflicting legacy Board state exists beside ${this.databasePath}; run board diagnostics before continuing`);
    }
    if (
      typeof raw === "object"
      && raw !== null
      && (raw as Record<string, unknown>).kind === "tarocub-kanban-migrated"
    ) {
      const sentinel = raw as Record<string, unknown>;
      if (
        sentinel.authoritativeStore !== "kanban.sqlite"
        || !migration
        || sentinel.sourceSha256 !== migration.source_sha256
        || sentinel.backupFile !== path.basename(migration.backup_path)
      ) {
        throw new Error(`Conflicting legacy Board migration sentinel exists beside ${this.databasePath}; run board diagnostics before continuing`);
      }
      await verifyMigrationBackup(migration, this.legacyPath, { allowMissing: true });
      return;
    }
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    if (!migration || migration.source_sha256 !== sourceSha256) {
      throw new Error(`Conflicting legacy Board state exists beside ${this.databasePath}; run board diagnostics before continuing`);
    }
    await verifyMigrationBackup(migration, this.legacyPath);
    await writeMigrationSentinel({
      legacyPath: this.legacyPath,
      sourceSha256,
      backupPath: migration.backup_path,
      completedAt: migration.completed_at,
    });
  }
}
