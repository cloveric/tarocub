import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { redactSecrets } from "../runtime/secret-redaction.js";
import { appendAuditEvent } from "./audit-log.js";
import {
  BoardStoreStateSchema,
  BoardTaskActorSchema,
  BoardTaskRecordSchema,
  type BoardAttachment,
  type BoardArtifact,
  type BoardClaim,
  type BoardChecklistItem,
  type BoardComment,
  type BoardDispatcherPolicy,
  type BoardEvent,
  type BoardRecord,
  type BoardSettings,
  type BoardStoreState,
  type BoardSubscription,
  type BoardTaskActor,
  type BoardTaskExecution,
  type BoardTaskPriority,
  type BoardTaskRecord,
  type BoardTaskRun,
  type BoardTaskStatus,
  type BoardTaskWorkspace,
  type BoardWipLimits,
} from "./board-store-schema.js";
import {
  resolveKanbanAssetDirectory,
  resolveKanbanDatabasePath,
  SqliteKanbanRepository,
  type BoardDiagnostics,
} from "./sqlite-kanban-repository.js";

export type {
  BoardStoreState,
  BoardAttachment,
  BoardArtifact,
  BoardClaim,
  BoardChecklistItem,
  BoardComment,
  BoardDispatcherPolicy,
  BoardEvent,
  BoardRecord,
  BoardSettings,
  BoardTaskActor,
  BoardTaskExecution,
  BoardTaskPriority,
  BoardTaskRecord,
  BoardTaskRun,
  BoardTaskStatus,
  BoardTaskWorkspace,
  BoardSubscription,
  BoardWipLimits,
} from "./board-store-schema.js";

export type BoardTaskInput = {
  title: string;
  createdBy: BoardTaskActor;
  boardSlug?: string;
  status?: Extract<BoardTaskStatus, "triage" | "todo" | "scheduled">;
  parentTaskId?: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: BoardTaskPriority;
  labels?: string[];
  checklist?: string[];
  artifacts?: Array<Pick<BoardArtifact, "kind" | "value">>;
  assignee?: string;
  review?: {
    required: boolean;
    reviewer?: string;
  };
  scheduledAt?: string;
  timezone?: string;
  execution?: BoardTaskExecution;
};

export type BoardCompletionResult = {
  task: BoardTaskRecord;
  promotedTaskIds: string[];
};

export type BoardReadyResult = {
  task: BoardTaskRecord;
  unmetDependencies: string[];
};

export type BoardTaskCardUpdate = Partial<Omit<Pick<
  BoardTaskInput,
  "description" | "acceptanceCriteria" | "priority" | "labels" | "checklist" | "artifacts"
>, "checklist">> & {
  // Accept existing checklist item objects mixed with new strings so callers
  // (e.g. /board check add) can preserve done/completedAt while appending.
  checklist?: Array<string | BoardChecklistItem>;
};

export type BoardTaskEditUpdate = BoardTaskCardUpdate & {
  title?: string;
  review?: {
    required: boolean;
    reviewer?: string;
  };
};

export type BoardTaskDeleteResult = {
  taskId: string;
  boardSlug: string;
  deleted: true;
};

export type BoardTaskWorkspaceInput = {
  mode: BoardTaskWorkspace["mode"];
  path?: string;
  branch?: string;
};

export type BoardPlanTaskInput = BoardTaskCardUpdate & {
  key: string;
  title: string;
  boardSlug?: string;
  status?: Extract<BoardTaskStatus, "triage" | "todo" | "scheduled">;
  parentTaskId?: string;
  assignee?: string;
  dependsOn?: string[];
  scheduledAt?: string;
  timezone?: string;
  execution?: BoardTaskExecution;
  review?: {
    required: boolean;
    reviewer?: string;
  };
};

export type BoardPlanInput = {
  createdBy: BoardTaskActor;
  tasks: BoardPlanTaskInput[];
};

export type BoardMutationOptions = {
  actor?: BoardTaskActor;
  expectedRevision?: number;
  idempotencyKey?: string;
  now?: Date;
};

export type BoardSettingsPatch = Partial<Omit<BoardSettings, "limits">> & {
  limits?: Partial<BoardWipLimits>;
};

export type BoardTaskExecutionUpdate = Partial<BoardTaskExecution>;

export type BoardTaskCommentInput = BoardMutationOptions & {
  body: string;
  actor: BoardTaskActor;
};

export type BoardAttachmentInput = BoardMutationOptions & {
  sourcePath: string;
  actor: BoardTaskActor;
  originalName?: string;
  mediaType?: string;
  maxBytes?: number;
};

export type BoardDispatchResult = {
  task: BoardTaskRecord | null;
  claim: BoardClaim | null;
  reason?: "manual" | "circuit_open" | "empty" | "wip_limit";
};

export type BoardClaimResult = {
  task: BoardTaskRecord;
  claim: BoardClaim;
};

export type BoardStats = {
  boardSlug: string;
  totalTasks: number;
  byStatus: Record<BoardTaskStatus, number>;
  activeClaims: number;
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
};

export type BoardRepairReport = {
  backupPath?: string;
  expiredClaims: string[];
  inconsistentRuns: string[];
  missingAssets: string[];
  changed: boolean;
};

export type BoardOperationalDiagnostics = {
  storage: BoardDiagnostics;
  expiredClaims: string[];
  inconsistentRuns: string[];
  missingAssets: string[];
};

export type BoardGcReport = {
  candidates: string[];
  quarantined: string[];
  quarantineDir?: string;
};

export type BoardExport = {
  format: "tarocub-kanban";
  version: 1;
  exportedAt: string;
  board: BoardRecord;
  tasks: BoardTaskRecord[];
  comments: BoardComment[];
  attachments: Array<BoardAttachment & { dataBase64?: string }>;
  events?: BoardEvent[];
};

export type BoardExportOptions = {
  includeAttachmentData?: boolean;
  includeDetailedLogs?: boolean;
  includeActorIdentifiers?: boolean;
  includeWorkspaceDetails?: boolean;
  includeEvents?: boolean;
  maxAttachmentBytes?: number;
};

const BOARD_TASK_ID_PATTERN = /^B\d+$/i;
const BOARD_CHECKLIST_ID_PATTERN = /^C\d+$/i;
const MAX_BOARD_SUMMARY_CHARS = 4000;
const MAX_BOARD_PLAN_TASKS = 50;
const MAX_BOARD_COMMENT_CHARS = 20_000;
const DEFAULT_ATTACHMENT_LIMIT_BYTES = 50 * 1024 * 1024;
const MAX_EVENT_PAGE_SIZE = 1_000;
const MAX_EXPORT_EVENTS = 100_000;
const EXPORT_ACTOR_KEYS = new Set([
  "assignee",
  "chatId",
  "conversationKey",
  "dispatchTarget",
  "messageThreadId",
  "owner",
  "reviewer",
  "userId",
]);
const EXPORT_PATH_KEYS = new Set(["backupPath", "path", "quarantineDir", "sourcePath"]);
const DEFAULT_WIP_LIMITS: BoardWipLimits = {
  global: 3,
  perAssignee: 1,
  perConversation: 1,
};

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  limits: { ...DEFAULT_WIP_LIMITS },
  leaseDurationMs: 5 * 60_000,
  defaultTimeoutMs: 30 * 60_000,
  defaultMaxRetries: 2,
  retryBaseDelayMs: 30_000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 5 * 60_000,
  consecutiveInfrastructureFailures: 0,
  automaticReview: false,
};

export function resolveBoardStorePath(stateDir: string): string {
  return path.join(stateDir, "board.json");
}

export function normalizeBoardTaskId(id: string): string | null {
  const normalized = id.trim().toUpperCase();
  return BOARD_TASK_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeIsoDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid date-time`);
  }
  return new Date(timestamp).toISOString();
}

function defaultState(): BoardStoreState {
  return {
    nextTaskId: 1,
    nextRunId: 1,
    limits: { ...DEFAULT_WIP_LIMITS },
    tasks: [],
  };
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => redactSecrets(value.trim())).filter(Boolean))];
}

function normalizeArtifacts(values: Array<Pick<BoardArtifact, "kind" | "value">> | undefined, timestamp: string): BoardArtifact[] {
  return (values ?? [])
    .map((artifact) => ({
      kind: artifact.kind.trim(),
      value: redactSecrets(artifact.value.trim()),
      createdAt: timestamp,
    }))
    .filter((artifact) => artifact.kind.length > 0 && artifact.value.length > 0);
}

function normalizeChecklist(values: Array<string | BoardChecklistItem> | undefined, existing: BoardChecklistItem[], timestamp: string): BoardChecklistItem[] {
  if (!values) {
    return existing.map((item) => ({ ...item }));
  }
  return values
    .map((value, index) => {
      if (typeof value === "string") {
        const text = redactSecrets(value.trim());
        return text
          ? {
            id: `C${index + 1}`,
            text,
            done: false,
            createdAt: timestamp,
          }
          : null;
      }
      const text = redactSecrets(value.text.trim());
      if (!text) {
        return null;
      }
      return {
        ...value,
        id: normalizeChecklistItemId(value.id) ?? `C${index + 1}`,
        text,
        done: Boolean(value.done),
      };
    })
    .filter((item): item is BoardChecklistItem => item !== null);
}

function normalizeChecklistItemId(id: string): string | null {
  const normalized = id.trim().toUpperCase();
  return BOARD_CHECKLIST_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeLimits(limits: Partial<BoardWipLimits> | undefined): BoardWipLimits {
  return {
    global: normalizePositiveLimit(limits?.global, DEFAULT_WIP_LIMITS.global),
    perAssignee: normalizePositiveLimit(limits?.perAssignee, DEFAULT_WIP_LIMITS.perAssignee),
    perConversation: normalizePositiveLimit(limits?.perConversation, DEFAULT_WIP_LIMITS.perConversation),
  };
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function requirePositiveByteLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeBoardSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    throw new Error("board slug must be 1-48 lowercase letters, numbers, or hyphens");
  }
  return slug;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function redactStructuredStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactStructuredStrings);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactStructuredStrings(nested)]),
    );
  }
  return value;
}

function redactExportPayload(
  value: unknown,
  options: { includeActorIdentifiers: boolean; includeWorkspaceDetails: boolean },
  key?: string,
): unknown {
  if (key && EXPORT_ACTOR_KEYS.has(key) && !options.includeActorIdentifiers) {
    return "[redacted]";
  }
  if (key && EXPORT_PATH_KEYS.has(key) && !options.includeWorkspaceDetails) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((nested) => redactExportPayload(nested, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        redactExportPayload(nested, options, nestedKey),
      ]),
    );
  }
  return value;
}

function normalizeBoardSettings(value: Record<string, unknown>): BoardSettings {
  const nestedLimits = value.limits && typeof value.limits === "object" && !Array.isArray(value.limits)
    ? value.limits as Partial<BoardWipLimits>
    : {};
  const flatLimits: Partial<BoardWipLimits> = {
    ...(typeof value.global === "number" ? { global: value.global } : {}),
    ...(typeof value.perAssignee === "number" ? { perAssignee: value.perAssignee } : {}),
    ...(typeof value.perConversation === "number" ? { perConversation: value.perConversation } : {}),
  };
  return {
    limits: normalizeLimits({ ...nestedLimits, ...flatLimits }),
    leaseDurationMs: normalizeNonNegativeInteger(value.leaseDurationMs as number | undefined, DEFAULT_BOARD_SETTINGS.leaseDurationMs),
    defaultTimeoutMs: normalizeNonNegativeInteger(value.defaultTimeoutMs as number | undefined, DEFAULT_BOARD_SETTINGS.defaultTimeoutMs),
    defaultMaxRetries: normalizeNonNegativeInteger(value.defaultMaxRetries as number | undefined, DEFAULT_BOARD_SETTINGS.defaultMaxRetries),
    retryBaseDelayMs: normalizeNonNegativeInteger(value.retryBaseDelayMs as number | undefined, DEFAULT_BOARD_SETTINGS.retryBaseDelayMs),
    circuitBreakerThreshold: normalizePositiveLimit(value.circuitBreakerThreshold as number | undefined, DEFAULT_BOARD_SETTINGS.circuitBreakerThreshold),
    circuitBreakerCooldownMs: normalizeNonNegativeInteger(value.circuitBreakerCooldownMs as number | undefined, DEFAULT_BOARD_SETTINGS.circuitBreakerCooldownMs),
    consecutiveInfrastructureFailures: normalizeNonNegativeInteger(
      value.consecutiveInfrastructureFailures as number | undefined,
      DEFAULT_BOARD_SETTINGS.consecutiveInfrastructureFailures,
    ),
    ...(typeof value.circuitOpenUntil === "string" && value.circuitOpenUntil.trim()
      ? { circuitOpenUntil: normalizeIsoDate(value.circuitOpenUntil, "board circuit deadline") }
      : {}),
    automaticReview: value.automaticReview === true,
  };
}

function serializeBoardSettings(settings: BoardSettings, revision: number): string {
  return JSON.stringify({
    ...settings,
    ...settings.limits,
    limits: settings.limits,
    revision,
  });
}

type BoardRow = {
  id: number;
  slug: string;
  name: string;
  settings_json: string;
  dispatcher_policy: BoardDispatcherPolicy;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  board_slug: string;
  task_id: string | null;
  run_id: string | null;
  event_type: string;
  actor_json: string | null;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
};

type CommentRow = {
  id: string;
  task_id: string;
  body: string;
  actor_json: string;
  created_at: string;
};

type AttachmentRow = {
  id: string;
  task_id: string;
  content_hash: string;
  storage_path: string;
  original_name: string;
  media_type: string | null;
  size_bytes: number;
  created_at: string;
  actor_json: string;
};

type ClaimRow = {
  task_id: string;
  owner: string;
  lease_token: string;
  expires_at: string;
  heartbeat_at: string;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  board_slug: string;
  conversation_key: string;
  event_filter_json: string;
  created_at: string;
};

type BoardAuditProjection = {
  sequence: number;
  boardSlug: string;
  taskId?: string;
  runId?: string;
  eventType: string;
  actor?: BoardTaskActor;
  createdAt: string;
};

type RecoveredClaim = {
  task: BoardTaskRecord;
  runId?: string;
  status: BoardTaskStatus;
  revision: number;
};

function boardFromRow(row: BoardRow): BoardRecord {
  const rawSettings = parseJsonObject(row.settings_json, `settings for board ${row.slug}`);
  const revision = typeof rawSettings.revision === "number" && Number.isInteger(rawSettings.revision) && rawSettings.revision > 0
    ? rawSettings.revision
    : 1;
  return {
    id: row.id,
    slug: row.slug,
    name: redactSecrets(row.name),
    settings: normalizeBoardSettings(rawSettings),
    dispatcherPolicy: row.dispatcher_policy,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseActor(value: string, label: string): BoardTaskActor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = BoardTaskActorSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid ${label}: ${result.error.message}`);
  }
  return redactStructuredStrings(result.data) as BoardTaskActor;
}

function requireActor(value: BoardTaskActor, label: string): BoardTaskActor {
  const result = BoardTaskActorSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid ${label}: ${result.error.message}`);
  }
  return redactStructuredStrings(result.data) as BoardTaskActor;
}

function validateExecutionUpdate(execution: BoardTaskExecutionUpdate): void {
  for (const key of ["timeoutMs", "maxRetries"] as const) {
    const value = execution[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`board task execution ${key} must be a non-negative integer`);
    }
  }
}

function mergeBoardSettings(current: BoardSettings, patch: BoardSettingsPatch): BoardSettings {
  const merged: Record<string, unknown> = {
    ...current,
    ...patch,
    limits: {
      ...current.limits,
      ...(patch.limits ?? {}),
    },
  };
  return normalizeBoardSettings(merged);
}

function validateBoardSettingsPatch(patch: BoardSettingsPatch): void {
  for (const [key, value] of Object.entries(patch.limits ?? {})) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`board setting limits.${key} must be a positive integer`);
    }
  }
  for (const key of [
    "leaseDurationMs",
    "defaultTimeoutMs",
    "defaultMaxRetries",
    "retryBaseDelayMs",
    "circuitBreakerCooldownMs",
    "consecutiveInfrastructureFailures",
  ] as const) {
    const value = patch[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`board setting ${key} must be a non-negative integer`);
    }
  }
  if (
    patch.circuitBreakerThreshold !== undefined
    && (!Number.isInteger(patch.circuitBreakerThreshold) || patch.circuitBreakerThreshold <= 0)
  ) {
    throw new Error("board setting circuitBreakerThreshold must be a positive integer");
  }
  if (patch.automaticReview !== undefined && typeof patch.automaticReview !== "boolean") {
    throw new Error("board setting automaticReview must be a boolean");
  }
  if (patch.circuitOpenUntil !== undefined) {
    normalizeIsoDate(patch.circuitOpenUntil, "board circuit deadline");
  }
}

function requireExpectedRevision(actual: number, expected: number | undefined, label: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`${label} stale revision: expected ${expected}, current ${actual}`);
  }
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > 200) {
    throw new Error("board idempotency key must be at most 200 characters");
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function eventFromRow(row: EventRow): BoardEvent {
  return {
    sequence: row.sequence,
    boardSlug: row.board_slug,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    eventType: row.event_type,
    ...(row.actor_json ? { actor: parseActor(row.actor_json, `event ${row.sequence} actor`) } : {}),
    payload: redactStructuredStrings(
      parseJsonObject(row.payload_json, `event ${row.sequence} payload`),
    ) as Record<string, unknown>,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    createdAt: row.created_at,
  };
}

function commentFromRow(row: CommentRow): BoardComment {
  return {
    id: row.id,
    taskId: row.task_id,
    body: redactSecrets(row.body),
    actor: parseActor(row.actor_json, `comment ${row.id} actor`),
    createdAt: row.created_at,
  };
}

function attachmentFromRow(row: AttachmentRow): BoardAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    contentHash: row.content_hash,
    storagePath: row.storage_path,
    originalName: sanitizeAttachmentName(row.original_name),
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    actor: parseActor(row.actor_json, `attachment ${row.id} actor`),
  };
}

function attachmentFromEventPayload(value: unknown, taskId: string): BoardAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("idempotent board attachment detach is incomplete");
  }
  const candidate = value as Partial<BoardAttachment>;
  const actor = BoardTaskActorSchema.safeParse(candidate.actor);
  if (
    typeof candidate.id !== "string"
    || candidate.taskId !== taskId
    || typeof candidate.contentHash !== "string"
    || typeof candidate.storagePath !== "string"
    || typeof candidate.originalName !== "string"
    || !Number.isInteger(candidate.sizeBytes)
    || (candidate.sizeBytes ?? -1) < 0
    || typeof candidate.createdAt !== "string"
    || !actor.success
  ) {
    throw new Error("idempotent board attachment detach is incomplete");
  }
  return {
    id: candidate.id,
    taskId,
    contentHash: candidate.contentHash,
    storagePath: candidate.storagePath,
    originalName: sanitizeAttachmentName(candidate.originalName),
    ...(typeof candidate.mediaType === "string" ? { mediaType: candidate.mediaType } : {}),
    sizeBytes: candidate.sizeBytes!,
    createdAt: normalizeIsoDate(candidate.createdAt, "board attachment timestamp"),
    actor: requireActor(actor.data as BoardTaskActor, "board attachment actor"),
  };
}

function claimFromRow(row: ClaimRow): BoardClaim {
  return {
    taskId: row.task_id,
    owner: row.owner,
    leaseToken: row.lease_token,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
  };
}

function subscriptionFromRow(row: SubscriptionRow): BoardSubscription {
  let filter: unknown;
  try {
    filter = JSON.parse(row.event_filter_json) as unknown;
  } catch (error) {
    throw new Error(`invalid board subscription filter: ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(filter) || filter.some((value) => typeof value !== "string")) {
    throw new Error(`invalid board subscription filter: ${row.id}`);
  }
  return {
    id: row.id,
    boardSlug: row.board_slug,
    conversationKey: row.conversation_key,
    eventFilter: filter,
    createdAt: row.created_at,
  };
}

function redactedActor(): BoardTaskActor {
  return {
    chatId: 0,
    userId: 0,
    conversationKey: "redacted",
  };
}

function normalizeImportedComment(value: unknown, taskIds: Set<string>): BoardComment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid board import comment");
  }
  const candidate = value as Partial<BoardComment>;
  const id = candidate.id?.trim();
  const taskId = candidate.taskId ? requireBoardTaskId(candidate.taskId) : "";
  const body = candidate.body ? redactSecrets(candidate.body.trim()) : undefined;
  const actor = BoardTaskActorSchema.safeParse(candidate.actor);
  if (!id || !taskId || !taskIds.has(taskId) || !body || !actor.success || !candidate.createdAt) {
    throw new Error(`invalid board import comment: ${id ?? "unknown"}`);
  }
  if (body.length > MAX_BOARD_COMMENT_CHARS) {
    throw new Error(`board comment must be at most ${MAX_BOARD_COMMENT_CHARS} characters`);
  }
  return {
    id,
    taskId,
    body,
    actor: requireActor(actor.data as BoardTaskActor, "board comment actor"),
    createdAt: normalizeIsoDate(candidate.createdAt, "board comment timestamp"),
  };
}

function normalizeBoardSummary(summary: string | undefined): string | undefined {
  const trimmed = summary ? redactSecrets(summary.trim()) : undefined;
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= MAX_BOARD_SUMMARY_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BOARD_SUMMARY_CHARS - 3)}...`;
}

function normalizeTask(task: BoardTaskRecord): BoardTaskRecord {
  const workspace = normalizeWorkspace(task.workspace);
  return {
    ...task,
    id: normalizeBoardTaskId(task.id) ?? task.id,
    boardSlug: task.boardSlug?.trim().toLowerCase() || "main",
    ...(task.parentTaskId ? { parentTaskId: normalizeBoardTaskId(task.parentTaskId) ?? task.parentTaskId } : {}),
    title: redactSecrets(task.title.trim()),
    ...(task.description !== undefined ? { description: redactSecrets(task.description.trim()) } : {}),
    acceptanceCriteria: normalizeStringList(task.acceptanceCriteria),
    priority: task.priority ?? "normal",
    labels: normalizeStringList(task.labels),
    checklist: normalizeChecklist(task.checklist, [], task.createdAt),
    artifacts: (task.artifacts ?? []).map((artifact) => ({
      ...artifact,
      value: redactSecrets(artifact.value.trim()),
    })),
    review: {
      required: Boolean(task.review?.required),
      ...(task.review?.reviewer ? { reviewer: task.review.reviewer } : {}),
    },
    dependencies: [...new Set((task.dependencies ?? []).map((id) => normalizeBoardTaskId(id) ?? id))],
    runs: (task.runs ?? []).map((taskRun) => ({
      ...taskRun,
      ...(taskRun.heartbeatNote !== undefined ? { heartbeatNote: redactSecrets(taskRun.heartbeatNote) } : {}),
      ...(taskRun.summary !== undefined ? { summary: redactSecrets(taskRun.summary) } : {}),
      ...(taskRun.error !== undefined ? { error: redactSecrets(taskRun.error) } : {}),
      ...(taskRun.logText !== undefined ? { logText: redactSecrets(taskRun.logText) } : {}),
    })),
    ...(task.summary !== undefined ? { summary: redactSecrets(task.summary) } : {}),
    ...(task.blockedReason !== undefined ? { blockedReason: redactSecrets(task.blockedReason) } : {}),
    execution: normalizeExecution(task.execution),
    revision: Number.isInteger(task.revision) && task.revision > 0 ? task.revision : 1,
    retryCount: Number.isInteger(task.retryCount) && task.retryCount >= 0 ? task.retryCount : 0,
    ...(workspace ? { workspace } : {}),
  };
}

function normalizeExecution(execution: BoardTaskExecution | undefined): BoardTaskExecution {
  if (!execution) {
    return {};
  }
  const engine = execution.engine?.trim();
  const model = execution.model?.trim();
  const effort = execution.effort?.trim();
  return {
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(Number.isInteger(execution.timeoutMs) && execution.timeoutMs! >= 0 ? { timeoutMs: execution.timeoutMs } : {}),
    ...(Number.isInteger(execution.maxRetries) && execution.maxRetries! >= 0 ? { maxRetries: execution.maxRetries } : {}),
  };
}

function normalizeWorkspace(
  workspace: BoardTaskWorkspace | undefined,
  options: { requireAbsolutePath?: boolean } = {},
): BoardTaskWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }
  const mode = workspace.mode ?? "default";
  const pathValue = workspace.path?.trim();
  if (pathValue && options.requireAbsolutePath && !path.isAbsolute(pathValue)) {
    throw new Error("board workspace path must be absolute");
  }
  const branch = workspace.branch?.trim();
  return {
    mode,
    ...(pathValue ? { path: pathValue } : {}),
    ...(branch ? { branch } : {}),
  };
}

export function parseBoardStoreState(value: unknown): BoardStoreState {
  const result = BoardStoreStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid board store state: ${result.error.message}`);
  }

  const tasks = (result.data.tasks ?? [])
    .map((task) => normalizeTask(task as BoardTaskRecord))
    .filter((task) => task.title.length > 0);
  const maxTaskNumber = tasks.reduce((max, task) => {
    const match = task.id.match(/^B(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const maxRunNumber = tasks.flatMap((task) => task.runs).reduce((max, run) => {
    const match = run.id.match(/^R(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return {
    nextTaskId: Math.max(result.data.nextTaskId ?? 1, maxTaskNumber + 1),
    nextRunId: Math.max(result.data.nextRunId ?? 1, maxRunNumber + 1),
    limits: normalizeLimits(result.data.limits),
    tasks,
  };
}

function cloneTask(task: BoardTaskRecord): BoardTaskRecord {
  const normalized = normalizeTask(task);
  return {
    ...normalized,
    dependencies: [...normalized.dependencies],
    runs: normalized.runs.map((run) => ({ ...run })),
    acceptanceCriteria: [...normalized.acceptanceCriteria],
    labels: [...normalized.labels],
    checklist: normalized.checklist.map((item) => ({ ...item })),
    artifacts: normalized.artifacts.map((artifact) => ({ ...artifact })),
    review: { ...normalized.review },
    execution: { ...normalized.execution },
    createdBy: { ...normalized.createdBy },
    ...(normalized.workspace ? { workspace: { ...normalized.workspace } } : {}),
  };
}

function allDependenciesDone(tasks: BoardTaskRecord[], task: BoardTaskRecord): boolean {
  return task.dependencies.every((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId)?.status === "done");
}

function isScheduleDue(task: BoardTaskRecord, now: string): boolean {
  const scheduledAt = task.nextRetryAt ?? task.scheduledAt;
  if (!scheduledAt) {
    return true;
  }
  return Date.parse(scheduledAt) <= Date.parse(now);
}

function startRunRecord(
  state: BoardStoreState,
  task: BoardTaskRecord,
  timestamp: string,
  dispatchTarget?: string,
): BoardTaskRun {
  const run: BoardTaskRun = {
    id: `R${state.nextRunId}`,
    status: "running",
    startedAt: timestamp,
    attempt: task.retryCount + 1,
    ...(task.execution.engine ? { engine: task.execution.engine } : {}),
    ...(task.execution.model ? { model: task.execution.model } : {}),
    ...(task.execution.effort ? { effort: task.execution.effort } : {}),
    ...(dispatchTarget ? { dispatchTarget } : {}),
  };
  state.nextRunId += 1;
  task.runs.push(run);
  task.status = "running";
  delete task.blockedReason;
  delete task.nextRetryAt;
  return run;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sanitizeAttachmentName(value: string): string {
  const sanitized = redactSecrets(path.basename(value))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return (sanitized || "attachment").slice(0, 240);
}

async function hashFileBounded(filePath: string, maxBytes: number): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`board attachment exceeds ${maxBytes} bytes`);
    }
    hash.update(buffer);
  }
  return { hash: hash.digest("hex"), size };
}

async function verifyOwnedAssetFile(
  filePath: string,
  expectedHash: string,
  expectedSize: number,
  label: string,
): Promise<void> {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  const digest = await hashFileBounded(filePath, Math.max(expectedSize, 1));
  if (digest.hash !== expectedHash || digest.size !== expectedSize) {
    throw new Error(`${label} hash or size mismatch`);
  }
}

async function listOwnedAssetFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".trash") continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`board asset root contains a symbolic link: ${path.relative(root, entryPath)}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listOwnedAssetFiles(root, entryPath));
    } else if (entry.isFile()) {
      files.push(path.relative(root, entryPath));
    }
  }
  return files;
}

function wouldCreateDependencyCycle(tasks: BoardTaskRecord[], taskId: string, dependencyId: string): boolean {
  const dependenciesByTask = new Map(tasks.map((task) => [task.id, task.dependencies]));
  dependenciesByTask.set(taskId, [...new Set([...(dependenciesByTask.get(taskId) ?? []), dependencyId])]);

  const seen = new Set<string>();
  const stack = [dependencyId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    stack.push(...(dependenciesByTask.get(current) ?? []));
  }
  return false;
}

function findDependencyCycle(tasks: BoardTaskRecord[]): string[] | null {
  const dependenciesByTask = new Map(tasks.map((task) => [task.id, task.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): string[] | null => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      return [...path.slice(cycleStart), taskId];
    }
    if (visited.has(taskId)) {
      return null;
    }

    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyId of dependenciesByTask.get(taskId) ?? []) {
      if (!dependenciesByTask.has(dependencyId)) {
        continue;
      }
      const cycle = visit(dependencyId);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function findParentCycle(tasks: BoardTaskRecord[]): string[] | null {
  const parentByTask = new Map(tasks.map((task) => [task.id, task.parentTaskId]));
  for (const task of tasks) {
    const visited = new Map<string, number>();
    const path: string[] = [];
    let current: string | undefined = task.id;
    while (current) {
      const cycleStart = visited.get(current);
      if (cycleStart !== undefined) {
        return [...path.slice(cycleStart), current];
      }
      visited.set(current, path.length);
      path.push(current);
      current = parentByTask.get(current);
    }
  }
  return null;
}

function findTask(tasks: BoardTaskRecord[], id: string): BoardTaskRecord {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw new Error(`board task not found: ${id}`);
  }
  return task;
}

export class BoardStore {
  private readonly repository: SqliteKanbanRepository;
  private readonly store: {
    read(defaultValue: BoardStoreState): Promise<BoardStoreState>;
    write(value: BoardStoreState): Promise<void>;
  };
  private pendingWrite: Promise<void> = Promise.resolve();
  private activeAuditProjections: BoardAuditProjection[] | undefined;

  constructor(private readonly stateDir: string) {
    this.repository = new SqliteKanbanRepository(stateDir, {
      parseState: parseBoardStoreState,
      createDefaultState: defaultState,
    });
    this.store = {
      read: async () => await this.repository.readState(),
      write: async (value) => await this.repository.writeState(value),
    };
  }

  async listBoards(): Promise<BoardRecord[]> {
    const rows = await this.repository.queryAll<BoardRow>("SELECT * FROM boards ORDER BY id");
    return rows.map(boardFromRow);
  }

  async getBoard(slug: string): Promise<BoardRecord | null> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const row = await this.repository.queryOne<BoardRow>("SELECT * FROM boards WHERE slug = ?", [normalizedSlug]);
    return row ? boardFromRow(row) : null;
  }

  async createBoard(input: {
    name: string;
    slug?: string;
    settings?: BoardSettingsPatch;
    dispatcherPolicy?: BoardDispatcherPolicy;
  }, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    const name = redactSecrets(input.name.trim());
    if (!name) {
      throw new Error("board name is required");
    }
    validateBoardSettingsPatch(input.settings ?? {});
    const generatedSlug = name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const slug = normalizeBoardSlug(input.slug ?? (generatedSlug || `board-${randomUUID().slice(0, 8)}`));
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.created");
      if (repeated) {
        const repeatedSlug = typeof repeated.payload.slug === "string" ? repeated.payload.slug : slug;
        const existing = await this.getBoard(repeatedSlug);
        if (existing) {
          return existing;
        }
      }
      if (await this.getBoard(slug)) {
        throw new Error(`board already exists: ${slug}`);
      }
      const settings = mergeBoardSettings(DEFAULT_BOARD_SETTINGS, input.settings ?? {});
      const result = await this.repository.execute(`
        INSERT INTO boards (slug, name, settings_json, dispatcher_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        slug,
        name,
        serializeBoardSettings(settings, 1),
        input.dispatcherPolicy ?? "manual",
        timestamp,
        timestamp,
      ]);
      await this.appendEvent({
        boardSlug: slug,
        eventType: "board.created",
        actor: options.actor,
        payload: { slug, name },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return {
        id: result.lastID,
        slug,
        name,
        settings,
        dispatcherPolicy: input.dispatcherPolicy ?? "manual",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  async getActiveBoard(conversationKey: string): Promise<BoardRecord> {
    const normalizedConversationKey = conversationKey.trim();
    if (!normalizedConversationKey) {
      throw new Error("board conversation key is required");
    }
    const row = await this.repository.queryOne<BoardRow>(`
      SELECT boards.*
      FROM board_contexts
      JOIN boards ON boards.id = board_contexts.board_id
      WHERE board_contexts.conversation_key = ?
    `, [normalizedConversationKey]);
    if (row) {
      return boardFromRow(row);
    }
    const main = await this.repository.queryOne<BoardRow>("SELECT * FROM boards WHERE slug = 'main'");
    if (!main) {
      throw new Error("board not found: main");
    }
    return boardFromRow(main);
  }

  async selectBoard(conversationKey: string, slug: string, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    const normalizedConversationKey = conversationKey.trim();
    if (!normalizedConversationKey) {
      throw new Error("board conversation key is required");
    }
    const normalizedSlug = normalizeBoardSlug(slug);
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.selected");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug || repeated.payload.conversationKey !== normalizedConversationKey) {
          throw new Error("idempotency key belongs to a different board selection");
        }
        const selected = await this.getBoard(normalizedSlug);
        if (!selected) throw new Error(`board not found: ${normalizedSlug}`);
        return selected;
      }
      const board = await this.getBoard(normalizedSlug);
      if (!board) {
        throw new Error(`board not found: ${normalizedSlug}`);
      }
      await this.repository.execute(`
        INSERT INTO board_contexts (conversation_key, board_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_key) DO UPDATE SET board_id = excluded.board_id, updated_at = excluded.updated_at
      `, [normalizedConversationKey, board.id, timestamp]);
      await this.appendEvent({
        boardSlug: normalizedSlug,
        eventType: "board.selected",
        actor: options.actor,
        payload: { conversationKey: normalizedConversationKey },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return board;
    });
  }

  async updateBoardSettings(slug: string, patch: BoardSettingsPatch, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    const normalizedSlug = normalizeBoardSlug(slug);
    validateBoardSettingsPatch(patch);
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.settings_updated");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug) {
          throw new Error("idempotency key belongs to a different board settings update");
        }
        const existing = await this.getBoard(normalizedSlug);
        if (existing) {
          return existing;
        }
      }
      const row = await this.repository.queryOne<BoardRow>("SELECT * FROM boards WHERE slug = ?", [normalizedSlug]);
      if (!row) {
        throw new Error(`board not found: ${normalizedSlug}`);
      }
      const board = boardFromRow(row);
      requireExpectedRevision(board.revision, options.expectedRevision, `board ${normalizedSlug}`);
      const settings = mergeBoardSettings(board.settings, patch);
      const revision = board.revision + 1;
      await this.repository.execute(
        "UPDATE boards SET settings_json = ?, updated_at = ? WHERE id = ?",
        [serializeBoardSettings(settings, revision), timestamp, board.id],
      );
      await this.appendEvent({
        boardSlug: normalizedSlug,
        eventType: "board.settings_updated",
        actor: options.actor,
        payload: { revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { ...board, settings, revision, updatedAt: timestamp };
    });
  }

  async setDispatcherPolicy(slug: string, policy: BoardDispatcherPolicy, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    const normalizedSlug = normalizeBoardSlug(slug);
    if (policy !== "manual" && policy !== "automatic") {
      throw new Error(`invalid board dispatcher policy: ${String(policy)}`);
    }
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.dispatcher_updated");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug) {
          throw new Error("idempotency key belongs to a different board dispatcher update");
        }
        const existing = await this.getBoard(normalizedSlug);
        if (existing) {
          return existing;
        }
      }
      const row = await this.repository.queryOne<BoardRow>("SELECT * FROM boards WHERE slug = ?", [normalizedSlug]);
      if (!row) {
        throw new Error(`board not found: ${normalizedSlug}`);
      }
      const board = boardFromRow(row);
      requireExpectedRevision(board.revision, options.expectedRevision, `board ${normalizedSlug}`);
      const revision = board.revision + 1;
      await this.repository.execute(
        "UPDATE boards SET dispatcher_policy = ?, settings_json = ?, updated_at = ? WHERE id = ?",
        [policy, serializeBoardSettings(board.settings, revision), timestamp, board.id],
      );
      await this.appendEvent({
        boardSlug: normalizedSlug,
        eventType: "board.dispatcher_updated",
        actor: options.actor,
        payload: { policy, revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { ...board, dispatcherPolicy: policy, revision, updatedAt: timestamp };
    });
  }

  async listEvents(input: {
    boardSlug?: string;
    taskId?: string;
    afterSequence?: number;
    limit?: number;
  } = {}): Promise<BoardEvent[]> {
    const clauses = ["events.sequence > ?"];
    const params: Array<string | number> = [Math.max(0, Math.trunc(input.afterSequence ?? 0))];
    if (input.boardSlug) {
      clauses.push("boards.slug = ?");
      params.push(normalizeBoardSlug(input.boardSlug));
    }
    if (input.taskId) {
      clauses.push("events.task_id = ?");
      params.push(requireBoardTaskId(input.taskId));
    }
    const limit = Math.min(MAX_EVENT_PAGE_SIZE, Math.max(1, Math.trunc(input.limit ?? 100)));
    params.push(limit);
    const rows = await this.repository.queryAll<EventRow>(`
      SELECT events.*, boards.slug AS board_slug
      FROM events
      JOIN boards ON boards.id = events.board_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY events.sequence
      LIMIT ?
    `, params);
    return rows.map(eventFromRow);
  }

  async listSubscriptions(slug: string): Promise<BoardSubscription[]> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const rows = await this.repository.queryAll<SubscriptionRow>(`
      SELECT notification_subscriptions.*, boards.slug AS board_slug
      FROM notification_subscriptions
      JOIN boards ON boards.id = notification_subscriptions.board_id
      WHERE boards.slug = ?
      ORDER BY notification_subscriptions.created_at, notification_subscriptions.id
    `, [normalizedSlug]);
    return rows.map(subscriptionFromRow);
  }

  async subscribe(
    slug: string,
    conversationKey: string,
    eventFilter: string[] = [],
    options: BoardMutationOptions = {},
  ): Promise<BoardSubscription> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const normalizedConversationKey = conversationKey.trim();
    if (!normalizedConversationKey) throw new Error("board subscription conversation key is required");
    const normalizedFilter = normalizeStringList(eventFilter).slice(0, 100);
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.subscription_updated");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug || repeated.payload.conversationKey !== normalizedConversationKey) {
          throw new Error("idempotency key belongs to a different board subscription");
        }
        const subscriptions = await this.listSubscriptions(normalizedSlug);
        const subscription = subscriptions.find((candidate) => candidate.conversationKey === normalizedConversationKey);
        if (!subscription) throw new Error("idempotent board subscription is incomplete");
        return subscription;
      }
      const board = await this.getBoard(normalizedSlug);
      if (!board) throw new Error(`board not found: ${normalizedSlug}`);
      const existing = await this.repository.queryOne<SubscriptionRow>(`
        SELECT notification_subscriptions.*, boards.slug AS board_slug
        FROM notification_subscriptions
        JOIN boards ON boards.id = notification_subscriptions.board_id
        WHERE notification_subscriptions.board_id = ? AND notification_subscriptions.conversation_key = ?
      `, [board.id, normalizedConversationKey]);
      const subscription: BoardSubscription = existing
        ? { ...subscriptionFromRow(existing), eventFilter: normalizedFilter }
        : {
          id: randomUUID(),
          boardSlug: normalizedSlug,
          conversationKey: normalizedConversationKey,
          eventFilter: normalizedFilter,
          createdAt: timestamp,
        };
      await this.repository.execute(`
        INSERT INTO notification_subscriptions (id, board_id, conversation_key, event_filter_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(board_id, conversation_key) DO UPDATE SET event_filter_json = excluded.event_filter_json
      `, [subscription.id, board.id, subscription.conversationKey, JSON.stringify(subscription.eventFilter), subscription.createdAt]);
      await this.appendEvent({
        boardSlug: normalizedSlug,
        eventType: "board.subscription_updated",
        actor: options.actor,
        payload: { subscriptionId: subscription.id, conversationKey: subscription.conversationKey, eventFilter: subscription.eventFilter },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return subscription;
    });
  }

  async unsubscribe(slug: string, conversationKey: string, options: BoardMutationOptions = {}): Promise<boolean> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const normalizedConversationKey = conversationKey.trim();
    if (!normalizedConversationKey) throw new Error("board subscription conversation key is required");
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.subscription_removed");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug || repeated.payload.conversationKey !== normalizedConversationKey) {
          throw new Error("idempotency key belongs to a different board unsubscription");
        }
        return true;
      }
      const board = await this.getBoard(normalizedSlug);
      if (!board) throw new Error(`board not found: ${normalizedSlug}`);
      const result = await this.repository.execute(
        "DELETE FROM notification_subscriptions WHERE board_id = ? AND conversation_key = ?",
        [board.id, normalizedConversationKey],
      );
      if (result.changes > 0) {
        await this.appendEvent({
          boardSlug: normalizedSlug,
          eventType: "board.subscription_removed",
          actor: options.actor,
          payload: { conversationKey: normalizedConversationKey },
          idempotencyKey: options.idempotencyKey,
          createdAt: timestamp,
        });
      }
      return result.changes > 0;
    });
  }

  async listTasks(status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    const state = await this.store.read(defaultState());
    return state.tasks
      .filter((task) => status === undefined || task.status === status)
      .map(cloneTask);
  }

  async listBoardTasks(slug: string, status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    const normalizedSlug = normalizeBoardSlug(slug);
    return (await this.listTasks(status)).filter((task) => task.boardSlug === normalizedSlug);
  }

  async listChildTasks(id: string): Promise<BoardTaskRecord[]> {
    const normalizedId = requireBoardTaskId(id);
    const state = await this.store.read(defaultState());
    findTask(state.tasks, normalizedId);
    return state.tasks.filter((task) => task.parentTaskId === normalizedId).map(cloneTask);
  }

  async getTask(id: string): Promise<BoardTaskRecord | null> {
    const normalizedId = normalizeBoardTaskId(id);
    if (!normalizedId) {
      return null;
    }
    const state = await this.store.read(defaultState());
    const task = state.tasks.find((candidate) => candidate.id === normalizedId);
    return task ? cloneTask(task) : null;
  }

  async editTask(id: string, update: BoardTaskEditUpdate, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    if (Object.keys(update).length === 0) {
      throw new Error("board task edit requires at least one field");
    }
    return await this.mutateTaskWithEvent(id, "task.edited", options, (_state, task, timestamp) => {
      if (task.status === "archived") {
        throw new Error(`board task ${task.id} cannot be edited while archived`);
      }
      if (update.title !== undefined) {
        const title = redactSecrets(update.title.trim());
        if (!title) throw new Error("board task title is required");
        task.title = title;
      }
      if (update.description !== undefined) {
        const description = redactSecrets(update.description.trim());
        if (description) task.description = description;
        else delete task.description;
      }
      if (update.acceptanceCriteria !== undefined) {
        task.acceptanceCriteria = normalizeStringList(update.acceptanceCriteria);
      }
      if (update.priority !== undefined) task.priority = update.priority;
      if (update.labels !== undefined) task.labels = normalizeStringList(update.labels);
      if (update.checklist !== undefined) {
        task.checklist = normalizeChecklist(update.checklist, task.checklist, timestamp);
      }
      if (update.artifacts !== undefined) {
        task.artifacts = normalizeArtifacts(update.artifacts, timestamp);
      }
      if (update.review !== undefined) {
        task.review = {
          required: Boolean(update.review.required),
          ...(update.review.reviewer?.trim() ? { reviewer: redactSecrets(update.review.reviewer.trim()) } : {}),
        };
      }
      return { fields: Object.keys(update).sort() };
    });
  }

  async acceptTriage(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.triage_accepted", options, (_state, task) => {
      if (task.status !== "triage") {
        throw new Error(`board task ${task.id} cannot leave triage from ${task.status}`);
      }
      task.status = "todo";
      return { status: task.status };
    });
  }

  async reassignTask(id: string, assignee: string | null, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedAssignee = assignee?.trim() ? redactSecrets(assignee.trim()) : undefined;
    return await this.mutateTaskWithEvent(id, "task.reassigned", options, async (_state, task) => {
      const claim = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [task.id]);
      if (claim) {
        throw new Error(`board claim conflict for ${task.id}: release the active claim before reassigning`);
      }
      if (task.status === "archived") {
        throw new Error(`board task ${task.id} cannot be reassigned while archived`);
      }
      if (normalizedAssignee) task.assignee = normalizedAssignee;
      else delete task.assignee;
      return { assignee: normalizedAssignee ?? null };
    });
  }

  async linkDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedDependencyId = requireBoardTaskId(dependencyId);
    return await this.mutateTaskWithEvent(id, "task.dependency_linked", options, (state, task) => {
      if (task.id === normalizedDependencyId) {
        throw new Error("board task cannot depend on itself");
      }
      const dependency = findTask(state.tasks, normalizedDependencyId);
      if (dependency.boardSlug !== task.boardSlug) {
        throw new Error("board dependency tasks must belong to the same board");
      }
      if (task.status === "archived") {
        throw new Error(`board task ${task.id} cannot be linked while archived`);
      }
      if (wouldCreateDependencyCycle(state.tasks, task.id, normalizedDependencyId)) {
        throw new Error(`board dependency cycle rejected: ${task.id} -> ${normalizedDependencyId}`);
      }
      const linked = !task.dependencies.includes(normalizedDependencyId);
      task.dependencies = [...new Set([...task.dependencies, normalizedDependencyId])];
      if (task.status === "ready" && !allDependenciesDone(state.tasks, task)) {
        task.status = "todo";
      }
      return { dependencyId: normalizedDependencyId, linked, status: task.status };
    });
  }

  async deleteTask(
    id: string,
    input: BoardMutationOptions & { confirmTaskId: string },
  ): Promise<BoardTaskDeleteResult> {
    const normalizedId = requireBoardTaskId(id);
    if (requireBoardTaskId(input.confirmTaskId) !== normalizedId) {
      throw new Error(`board task deletion confirmation must exactly match ${normalizedId}`);
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.deleted");
      if (repeated) {
        if (repeated.payload.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different board task deletion");
        }
        return { taskId: normalizedId, boardSlug: repeated.boardSlug, deleted: true };
      }
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      if (task.runs.some((run) => run.status === "running")) {
        throw new Error(`board task ${normalizedId} cannot be deleted while running`);
      }
      if (await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId])) {
        throw new Error(`board claim conflict for ${normalizedId}: release the active claim before deleting`);
      }
      const affectedTaskIds: string[] = [];
      for (const candidate of state.tasks) {
        let changed = false;
        if (candidate.parentTaskId === normalizedId) {
          delete candidate.parentTaskId;
          changed = true;
        }
        if (candidate.dependencies.includes(normalizedId)) {
          candidate.dependencies = candidate.dependencies.filter((dependency) => dependency !== normalizedId);
          changed = true;
        }
        if (changed) {
          candidate.revision += 1;
          candidate.updatedAt = timestamp;
          affectedTaskIds.push(candidate.id);
        }
      }
      state.tasks = state.tasks.filter((candidate) => candidate.id !== normalizedId);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.deleted",
        actor: input.actor,
        payload: { taskId: task.id, title: task.title, affectedTaskIds },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      await this.store.write(state);
      return { taskId: task.id, boardSlug: task.boardSlug, deleted: true };
    });
  }

  async createTask(input: BoardTaskInput, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const title = redactSecrets(input.title.trim());
    if (!title) {
      throw new Error("board task title is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.created");
      if (repeated?.taskId) {
        return cloneTask(findTask(state.tasks, repeated.taskId));
      }
      const timestamp = (options.now ?? new Date()).toISOString();
      const boardSlug = normalizeBoardSlug(input.boardSlug ?? "main");
      if (!await this.getBoard(boardSlug)) {
        throw new Error(`board not found: ${boardSlug}`);
      }
      const parentTaskId = input.parentTaskId ? requireBoardTaskId(input.parentTaskId) : undefined;
      if (parentTaskId) {
        const parent = findTask(state.tasks, parentTaskId);
        if (parent.boardSlug !== boardSlug) {
          throw new Error("board parent and child must belong to the same board");
        }
      }
      if (input.status === "scheduled" && !input.scheduledAt?.trim()) {
        throw new Error("scheduled board task requires scheduledAt");
      }
      const status = input.status ?? (input.scheduledAt?.trim() ? "scheduled" : "todo");
      const task: BoardTaskRecord = {
        id: `B${state.nextTaskId}`,
        boardSlug,
        ...(parentTaskId ? { parentTaskId } : {}),
        title,
        status,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.description?.trim() ? { description: redactSecrets(input.description.trim()) } : {}),
        acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
        priority: input.priority ?? "normal",
        labels: normalizeStringList(input.labels),
        checklist: normalizeChecklist(input.checklist, [], timestamp),
        artifacts: normalizeArtifacts(input.artifacts, timestamp),
        review: {
          required: Boolean(input.review?.required),
          ...(input.review?.reviewer ? { reviewer: redactSecrets(input.review.reviewer.trim()) } : {}),
        },
        ...(input.assignee?.trim() ? { assignee: redactSecrets(input.assignee.trim()) } : {}),
        dependencies: [],
        runs: [],
        ...(input.scheduledAt?.trim() ? { scheduledAt: normalizeIsoDate(input.scheduledAt, "board schedule") } : {}),
        ...(input.timezone?.trim() ? { timezone: input.timezone.trim() } : {}),
        execution: normalizeExecution(input.execution),
        revision: 1,
        retryCount: 0,
        createdBy: requireActor(input.createdBy, "board task actor"),
      };
      state.nextTaskId += 1;
      state.tasks.push(task);
      await this.store.write(state);
      await this.appendEvent({
        boardSlug,
        taskId: task.id,
        eventType: "task.created",
        actor: options.actor ?? input.createdBy,
        payload: { status: task.status, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async updateTaskCard(
    id: string,
    update: BoardTaskCardUpdate,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await this.editTask(id, update, options);
  }

  async appendAcceptanceCriterion(
    id: string,
    criterion: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedCriterion = redactSecrets(criterion.trim());
    if (!normalizedCriterion) {
      throw new Error("board acceptance criterion is required");
    }
    return await this.mutateTaskWithEvent(id, "task.acceptance_criterion_added", options, (_state, task) => {
      task.acceptanceCriteria = normalizeStringList([...task.acceptanceCriteria, normalizedCriterion]);
      return { criterionCount: task.acceptanceCriteria.length };
    });
  }

  async appendChecklistItem(
    id: string,
    text: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedText = redactSecrets(text.trim());
    if (!normalizedText) {
      throw new Error("board checklist item text is required");
    }
    return await this.mutateTaskWithEvent(id, "task.checklist_item_added", options, (_state, task, timestamp) => {
      task.checklist = normalizeChecklist([...task.checklist, normalizedText], task.checklist, timestamp);
      return { checklistItemId: task.checklist.at(-1)?.id ?? null };
    });
  }

  async setChecklistItemDone(
    id: string,
    checklistItemId: string,
    done: boolean,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedChecklistItemId = requireChecklistItemId(checklistItemId);
    return await this.mutateTaskWithEvent(id, "task.checklist_item_updated", options, (_state, task, timestamp) => {
      const item = task.checklist.find((candidate) => candidate.id === normalizedChecklistItemId);
      if (!item) {
        throw new Error(`board checklist item not found: ${normalizedChecklistItemId}`);
      }
      item.done = done;
      if (done) {
        item.completedAt = timestamp;
      } else {
        delete item.completedAt;
      }
      return { checklistItemId: item.id, done };
    });
  }

  async getLimits(): Promise<BoardWipLimits> {
    const state = await this.store.read(defaultState());
    return { ...state.limits };
  }

  async setLimits(limits: Partial<BoardWipLimits>, options: BoardMutationOptions = {}): Promise<BoardWipLimits> {
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.legacy_limits_updated");
      if (repeated) {
        if (repeated.boardSlug !== "main") {
          throw new Error("idempotency key belongs to a different board limit update");
        }
        return await this.getLimits();
      }
      const state = await this.store.read(defaultState());
      state.limits = normalizeLimits({
        ...state.limits,
        ...limits,
      });
      const board = await this.getBoard("main");
      if (!board) throw new Error("board not found: main");
      requireExpectedRevision(board.revision, options.expectedRevision, "board main");
      await this.store.write(state);
      const revision = board.revision + 1;
      await this.repository.execute(
        "UPDATE boards SET settings_json = ?, updated_at = ? WHERE id = ?",
        [serializeBoardSettings({ ...board.settings, limits: state.limits }, revision), timestamp, board.id],
      );
      await this.appendEvent({
        boardSlug: "main",
        eventType: "board.legacy_limits_updated",
        actor: options.actor,
        payload: { limits: state.limits, revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { ...state.limits };
    });
  }

  async createPlan(input: BoardPlanInput, options: BoardMutationOptions = {}): Promise<{ tasks: BoardTaskRecord[] }> {
    if (input.tasks.length === 0) {
      throw new Error("board plan requires at least one task");
    }
    if (input.tasks.length > MAX_BOARD_PLAN_TASKS) {
      throw new Error(`board plan can create at most ${MAX_BOARD_PLAN_TASKS} tasks`);
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "board.plan_created");
      if (repeated) {
        const taskIds = Array.isArray(repeated.payload.taskIds)
          ? repeated.payload.taskIds.filter((value): value is string => typeof value === "string")
          : [];
        if (taskIds.length === 0) {
          throw new Error("idempotent board plan is incomplete");
        }
        return { tasks: taskIds.map((taskId) => cloneTask(findTask(state.tasks, taskId))) };
      }
      const timestamp = (options.now ?? new Date()).toISOString();
      const keyToId = new Map<string, string>();
      const created: BoardTaskRecord[] = [];
      const requestedBoards = new Set(input.tasks.map((task) => normalizeBoardSlug(task.boardSlug ?? "main")));
      for (const boardSlug of requestedBoards) {
        if (!await this.getBoard(boardSlug)) {
          throw new Error(`board not found: ${boardSlug}`);
        }
      }
      for (const planTask of input.tasks) {
        const key = planTask.key.trim();
        const title = redactSecrets(planTask.title.trim());
        if (!key || !title) {
          throw new Error("board plan task requires key and title");
        }
        if (keyToId.has(key)) {
          throw new Error(`duplicate board plan key: ${key}`);
        }
        if (planTask.status === "scheduled" && !planTask.scheduledAt?.trim()) {
          throw new Error(`scheduled board plan task requires scheduledAt: ${key}`);
        }
        const task: BoardTaskRecord = {
          id: `B${state.nextTaskId}`,
          boardSlug: normalizeBoardSlug(planTask.boardSlug ?? "main"),
          ...(planTask.parentTaskId ? { parentTaskId: requireBoardTaskId(planTask.parentTaskId) } : {}),
          title,
          status: planTask.status ?? (planTask.scheduledAt?.trim() ? "scheduled" : "todo"),
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(planTask.description?.trim() ? { description: redactSecrets(planTask.description.trim()) } : {}),
          acceptanceCriteria: normalizeStringList(planTask.acceptanceCriteria),
          priority: planTask.priority ?? "normal",
          labels: normalizeStringList(planTask.labels),
          checklist: normalizeChecklist(planTask.checklist, [], timestamp),
          artifacts: normalizeArtifacts(planTask.artifacts, timestamp),
          review: {
            required: Boolean(planTask.review?.required),
            ...(planTask.review?.reviewer ? { reviewer: redactSecrets(planTask.review.reviewer.trim()) } : {}),
          },
          ...(planTask.assignee?.trim() ? { assignee: redactSecrets(planTask.assignee.trim()) } : {}),
          dependencies: [],
          runs: [],
          ...(planTask.scheduledAt?.trim() ? { scheduledAt: normalizeIsoDate(planTask.scheduledAt, "board schedule") } : {}),
          ...(planTask.timezone?.trim() ? { timezone: planTask.timezone.trim() } : {}),
          execution: normalizeExecution(planTask.execution),
          revision: 1,
          retryCount: 0,
          createdBy: requireActor(input.createdBy, "board plan actor"),
        };
        state.nextTaskId += 1;
        keyToId.set(key, task.id);
        state.tasks.push(task);
        created.push(task);
      }
      for (let index = 0; index < input.tasks.length; index++) {
        const dependencies = input.tasks[index]!.dependsOn ?? [];
        created[index]!.dependencies = [...new Set(dependencies.map((dependencyKey) => {
          const dependencyId = keyToId.get(dependencyKey.trim());
          if (!dependencyId) {
            throw new Error(`unknown board plan dependency: ${dependencyKey}`);
          }
          return dependencyId;
        }))];
      }
      for (const task of created) {
        if (!task.parentTaskId) continue;
        if (task.parentTaskId === task.id) {
          throw new Error("board task cannot be its own parent");
        }
        const parent = findTask(state.tasks, task.parentTaskId);
        if (parent.boardSlug !== task.boardSlug) {
          throw new Error("board parent and child must belong to the same board");
        }
      }
      const cycle = findDependencyCycle(created);
      if (cycle) {
        throw new Error(`board dependency cycle rejected: ${cycle.join(" -> ")}`);
      }
      const parentCycle = findParentCycle(state.tasks);
      if (parentCycle) {
        throw new Error(`board parent cycle rejected: ${parentCycle.join(" -> ")}`);
      }
      await this.store.write(state);
      for (const task of created) {
        await this.appendEvent({
          boardSlug: task.boardSlug,
          taskId: task.id,
          eventType: "task.created",
          actor: options.actor ?? input.createdBy,
          payload: { source: "plan", status: task.status, revision: task.revision },
          createdAt: timestamp,
        });
      }
      await this.appendEvent({
        boardSlug: created[0]!.boardSlug,
        eventType: "board.plan_created",
        actor: options.actor ?? input.createdBy,
        payload: { taskIds: created.map((task) => task.id) },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { tasks: created.map(cloneTask) };
    });
  }

  async setTaskWorkspace(
    id: string,
    workspace: BoardTaskWorkspaceInput,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedWorkspace = normalizeWorkspace(workspace as BoardTaskWorkspace, { requireAbsolutePath: true });
    return await this.mutateTaskWithEvent(id, "task.workspace_updated", options, (_state, task) => {
      if (!normalizedWorkspace || normalizedWorkspace.mode === "default") {
        delete task.workspace;
        return { mode: "default" };
      }
      task.workspace = normalizedWorkspace;
      return { mode: normalizedWorkspace.mode };
    });
  }

  async setTaskExecution(id: string, execution: BoardTaskExecutionUpdate, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    validateExecutionUpdate(execution);
    return await this.mutateTaskWithEvent(id, "task.execution_updated", options, (_state, task) => {
      task.execution = normalizeExecution({ ...task.execution, ...execution });
      return { execution: task.execution };
    });
  }

  async setParentTask(id: string, parentTaskId: string | null, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.parent_updated", options, (state, task) => {
      if (parentTaskId === null || parentTaskId.trim() === "") {
        delete task.parentTaskId;
        return { parentTaskId: null };
      }
      const normalizedParentId = requireBoardTaskId(parentTaskId);
      if (normalizedParentId === task.id) {
        throw new Error("board task cannot be its own parent");
      }
      const parent = findTask(state.tasks, normalizedParentId);
      if (parent.boardSlug !== task.boardSlug) {
        throw new Error("board parent and child must belong to the same board");
      }
      let cursor: BoardTaskRecord | undefined = parent;
      const visited = new Set<string>();
      while (cursor?.parentTaskId) {
        if (cursor.parentTaskId === task.id) {
          throw new Error(`board parent cycle rejected: ${task.id} -> ${normalizedParentId}`);
        }
        if (visited.has(cursor.id)) {
          throw new Error("existing board parent cycle detected");
        }
        visited.add(cursor.id);
        cursor = state.tasks.find((candidate) => candidate.id === cursor!.parentTaskId);
      }
      task.parentTaskId = normalizedParentId;
      return { parentTaskId: normalizedParentId };
    });
  }

  async removeDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedDependencyId = requireBoardTaskId(dependencyId);
    return await this.mutateTaskWithEvent(id, "task.dependency_removed", options, (state, task, timestamp) => {
      if (!task.dependencies.includes(normalizedDependencyId)) {
        return { dependencyId: normalizedDependencyId, removed: false };
      }
      task.dependencies = task.dependencies.filter((candidate) => candidate !== normalizedDependencyId);
      if (task.status === "todo" && allDependenciesDone(state.tasks, task) && isScheduleDue(task, timestamp)) {
        task.status = "ready";
      }
      return { dependencyId: normalizedDependencyId, removed: true, status: task.status };
    });
  }

  async scheduleTask(
    id: string,
    scheduledAt: string,
    timezone?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedScheduledAt = normalizeIsoDate(scheduledAt, "board schedule");
    const normalizedTimezone = timezone?.trim();
    return await this.mutateTaskWithEvent(id, "task.scheduled", options, (_state, task) => {
      if (["running", "review", "done", "archived"].includes(task.status)) {
        throw new Error(`board task ${task.id} cannot be scheduled from ${task.status}`);
      }
      task.status = "scheduled";
      task.scheduledAt = normalizedScheduledAt;
      if (normalizedTimezone) {
        task.timezone = normalizedTimezone;
      } else {
        delete task.timezone;
      }
      delete task.nextRetryAt;
      delete task.blockedReason;
      return { scheduledAt: normalizedScheduledAt, timezone: normalizedTimezone };
    });
  }

  async promoteScheduledTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.promoted", options, (state, task, timestamp) => {
      if (task.status !== "scheduled") {
        throw new Error(`board task ${task.id} cannot be promoted from ${task.status}`);
      }
      if (!isScheduleDue(task, timestamp)) {
        throw new Error(`board task ${task.id} schedule is not due`);
      }
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (unmetDependencies.length > 0) {
        throw new Error(`board task ${task.id} has unmet dependencies: ${unmetDependencies.join(", ")}`);
      }
      task.status = "ready";
      delete task.nextRetryAt;
      return { status: task.status };
    });
  }

  async promoteDueTasks(slug: string, now: Date = new Date()): Promise<BoardTaskRecord[]> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const promoted: BoardTaskRecord[] = [];
      for (const task of state.tasks) {
        if (
          task.boardSlug !== normalizedSlug
          || task.status !== "scheduled"
          || !isScheduleDue(task, timestamp)
          || !allDependenciesDone(state.tasks, task)
        ) {
          continue;
        }
        task.status = "ready";
        task.revision += 1;
        task.updatedAt = timestamp;
        delete task.nextRetryAt;
        promoted.push(task);
      }
      if (promoted.length === 0) {
        return [];
      }
      await this.store.write(state);
      for (const task of promoted) {
        await this.appendEvent({
          boardSlug: task.boardSlug,
          taskId: task.id,
          eventType: "task.promoted",
          payload: { status: task.status, revision: task.revision },
          createdAt: timestamp,
        });
      }
      return promoted.map(cloneTask);
    });
  }

  async archiveTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.archived", options, async (_state, task, timestamp) => {
      if (task.status === "archived") {
        throw new Error(`board task ${task.id} is already archived`);
      }
      task.archivedFromStatus = task.status;
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (activeRun) {
        activeRun.status = "cancelled";
        activeRun.completedAt = timestamp;
        activeRun.error = "task archived";
      }
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      task.status = "archived";
      return { previousStatus: task.archivedFromStatus, runId: activeRun?.id ?? null };
    });
  }

  async restoreTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.restored", options, (state, task, timestamp) => {
      if (task.status !== "archived") {
        throw new Error(`board task ${task.id} is not archived`);
      }
      const previous = task.archivedFromStatus ?? "todo";
      delete task.archivedFromStatus;
      if (previous === "running") {
        task.status = "blocked";
        task.blockedReason = "restored after an interrupted run";
      } else if (previous === "scheduled" && isScheduleDue(task, timestamp) && allDependenciesDone(state.tasks, task)) {
        task.status = "ready";
      } else if (previous === "ready" && !allDependenciesDone(state.tasks, task)) {
        task.status = "todo";
      } else {
        task.status = previous === "archived" ? "todo" : previous;
      }
      return { status: task.status };
    });
  }

  async cancelTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedReason = redactSecrets(reason.trim()) || "cancelled";
    return await this.closeActiveRun(id, "cancelled", normalizedReason, "task.cancelled", options);
  }

  async timeoutTask(id: string, reason = "task timed out", options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedReason = redactSecrets(reason.trim()) || "task timed out";
    return await this.closeActiveRun(id, "timed_out", normalizedReason, "task.timed_out", options);
  }

  async reopenReview(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.review_reopened", options, (_state, task) => {
      if (task.status !== "blocked") {
        throw new Error(`board task ${task.id} cannot reopen review from ${task.status}`);
      }
      if (!task.runs.some((run) => run.status === "review_requested")) {
        throw new Error(`board task ${task.id} has no review request`);
      }
      task.status = "review";
      delete task.blockedReason;
      return { status: task.status };
    });
  }

  async updateRunEvidence(id: string, runId: string, update: {
    logText?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    summary?: string;
  }, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error("board run id is required");
    }
    return await this.mutateTaskWithEvent(id, "run.evidence_updated", options, (_state, task) => {
      const taskRun = task.runs.find((run) => run.id === normalizedRunId);
      if (!taskRun) {
        throw new Error(`board run not found: ${normalizedRunId}`);
      }
      if (update.logText !== undefined) {
        taskRun.logText = redactSecrets(update.logText).slice(0, 100_000);
      }
      if (update.summary !== undefined) {
        const summary = normalizeBoardSummary(update.summary);
        if (summary) taskRun.summary = summary;
        else delete taskRun.summary;
      }
      for (const [key, value] of [
        ["inputTokens", update.inputTokens],
        ["outputTokens", update.outputTokens],
      ] as const) {
        if (value !== undefined) {
          if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
          taskRun[key] = value;
        }
      }
      if (update.costUsd !== undefined) {
        if (!Number.isFinite(update.costUsd) || update.costUsd < 0) {
          throw new Error("costUsd must be non-negative");
        }
        taskRun.costUsd = update.costUsd;
      }
      return { runId: normalizedRunId };
    });
  }

  async listComments(id: string): Promise<BoardComment[]> {
    const normalizedId = requireBoardTaskId(id);
    if (!await this.getTask(normalizedId)) {
      throw new Error(`board task not found: ${normalizedId}`);
    }
    const rows = await this.repository.queryAll<CommentRow>(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id",
      [normalizedId],
    );
    return rows.map(commentFromRow);
  }

  async addComment(id: string, input: BoardTaskCommentInput): Promise<{ task: BoardTaskRecord; comment: BoardComment }> {
    const normalizedId = requireBoardTaskId(id);
    const body = redactSecrets(input.body.trim());
    if (!body) {
      throw new Error("board comment body is required");
    }
    if (body.length > MAX_BOARD_COMMENT_CHARS) {
      throw new Error(`board comment must be at most ${MAX_BOARD_COMMENT_CHARS} characters`);
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.comment_added");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId || typeof repeated.payload.commentId !== "string") {
          throw new Error("idempotency key belongs to a different board comment");
        }
        const existing = await this.repository.queryOne<CommentRow>("SELECT * FROM comments WHERE id = ?", [repeated.payload.commentId]);
        if (!existing) {
          throw new Error(`board comment not found: ${repeated.payload.commentId}`);
        }
        return { task: cloneTask(task), comment: commentFromRow(existing) };
      }
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      const comment: BoardComment = {
        id: randomUUID(),
        taskId: normalizedId,
        body,
        actor: requireActor(input.actor, "board comment actor"),
        createdAt: timestamp,
      };
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.repository.execute(
        "INSERT INTO comments (id, task_id, body, actor_json, created_at) VALUES (?, ?, ?, ?, ?)",
        [comment.id, comment.taskId, comment.body, JSON.stringify(comment.actor), comment.createdAt],
      );
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.comment_added",
        actor: input.actor,
        payload: { commentId: comment.id, revision: task.revision },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), comment };
    });
  }

  async getClaim(id: string): Promise<BoardClaim | null> {
    const normalizedId = requireBoardTaskId(id);
    const row = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
    return row ? claimFromRow(row) : null;
  }

  async listClaims(slug?: string): Promise<BoardClaim[]> {
    const rows = slug
      ? await this.repository.queryAll<ClaimRow>(`
        SELECT claims.*
        FROM claims
        JOIN tasks ON tasks.id = claims.task_id
        JOIN boards ON boards.id = tasks.board_id
        WHERE boards.slug = ?
        ORDER BY claims.created_at, claims.task_id
      `, [normalizeBoardSlug(slug)])
      : await this.repository.queryAll<ClaimRow>("SELECT * FROM claims ORDER BY created_at, task_id");
    return rows.map(claimFromRow);
  }

  async claimTask(
    id: string,
    owner: string,
    input: BoardMutationOptions & { leaseDurationMs?: number } = {},
  ): Promise<BoardClaimResult> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedOwner = redactSecrets(owner.trim());
    if (!normalizedOwner) {
      throw new Error("board claim owner is required");
    }
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.claimed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        const existing = await this.getClaim(normalizedId);
        if (
          !existing
          || repeated.taskId !== normalizedId
          || repeated.payload.claimCreatedAt !== existing.createdAt
        ) {
          throw new Error("board claim conflict: idempotent claim is no longer active");
        }
        return { task: cloneTask(task), claim: existing };
      }
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      if (task.status !== "ready") {
        throw new Error(`board task ${normalizedId} must be ready before claiming (current: ${task.status})`);
      }
      const existingRow = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
      if (existingRow && Date.parse(existingRow.expires_at) > now.getTime()) {
        throw new Error(`board task ${normalizedId} is already claimed by ${existingRow.owner}`);
      }
      const recoveredClaims = existingRow
        ? await this.recoverExpiredClaimRows(state, [existingRow], timestamp)
        : [];
      const board = await this.getBoard(task.boardSlug);
      if (!board) {
        throw new Error(`board not found: ${task.boardSlug}`);
      }
      const leaseDurationMs = normalizeNonNegativeInteger(input.leaseDurationMs, board.settings.leaseDurationMs);
      const claim: BoardClaim = {
        taskId: normalizedId,
        owner: normalizedOwner,
        leaseToken: randomUUID(),
        expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        heartbeatAt: timestamp,
        createdAt: timestamp,
      };
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.repository.execute(`
        INSERT INTO claims (task_id, owner, lease_token, expires_at, heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [claim.taskId, claim.owner, claim.leaseToken, claim.expiresAt, claim.heartbeatAt, claim.createdAt]);
      await this.appendClaimExpiredEvents(recoveredClaims, timestamp);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.claimed",
        actor: input.actor,
        payload: {
          owner: claim.owner,
          expiresAt: claim.expiresAt,
          claimCreatedAt: claim.createdAt,
          revision: task.revision,
        },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), claim };
    });
  }

  async heartbeatClaim(
    id: string,
    leaseToken: string,
    input: BoardMutationOptions & { leaseDurationMs?: number; note?: string } = {},
  ): Promise<BoardClaimResult> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedToken = leaseToken.trim();
    if (!normalizedToken) {
      throw new Error("board lease token is required");
    }
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.claim_heartbeat");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different board claim heartbeat");
        }
        const existing = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
        if (!existing || repeated.payload.claimCreatedAt !== existing.created_at) {
          throw new Error("board claim conflict: idempotent heartbeat is no longer active");
        }
        return { task: cloneTask(task), claim: claimFromRow(existing) };
      }
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      const row = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
      if (!row || row.lease_token !== normalizedToken) {
        throw new Error(`board claim conflict for ${normalizedId}`);
      }
      if (Date.parse(row.expires_at) <= now.getTime()) {
        throw new Error(`board claim expired for ${normalizedId}`);
      }
      const board = await this.getBoard(task.boardSlug);
      if (!board) {
        throw new Error(`board not found: ${task.boardSlug}`);
      }
      const leaseDurationMs = normalizeNonNegativeInteger(input.leaseDurationMs, board.settings.leaseDurationMs);
      const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      await this.repository.execute(
        "UPDATE claims SET expires_at = ?, heartbeat_at = ? WHERE task_id = ? AND lease_token = ?",
        [expiresAt, timestamp, normalizedId, normalizedToken],
      );
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (activeRun) {
        activeRun.lastHeartbeatAt = timestamp;
        const note = input.note ? redactSecrets(input.note.trim()) : undefined;
        if (note) activeRun.heartbeatNote = note;
      }
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        ...(activeRun ? { runId: activeRun.id } : {}),
        eventType: "task.claim_heartbeat",
        actor: input.actor,
        payload: { expiresAt, claimCreatedAt: row.created_at, revision: task.revision },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return {
        task: cloneTask(task),
        claim: { ...claimFromRow(row), expiresAt, heartbeatAt: timestamp },
      };
    });
  }

  async releaseClaim(id: string, leaseToken: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedToken = leaseToken.trim();
    if (!normalizedToken) {
      throw new Error("board lease token is required");
    }
    return await this.mutateTaskWithEvent(id, "task.claim_released", options, async (_state, task) => {
      if (task.runs.some((run) => run.status === "running")) {
        throw new Error(`board task ${task.id} claim cannot be released while its run is active`);
      }
      const row = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [task.id]);
      if (!row || row.lease_token !== normalizedToken) {
        throw new Error(`board claim conflict for ${task.id}`);
      }
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      return { owner: row.owner };
    });
  }

  async startClaimedTask(id: string, leaseToken: string, options: BoardMutationOptions = {}): Promise<BoardClaimResult> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedToken = leaseToken.trim();
    if (!normalizedToken) {
      throw new Error("board lease token is required");
    }
    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_started");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const claimRow = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
      if (repeated) {
        if (
          !claimRow
          || repeated.taskId !== normalizedId
          || repeated.payload.claimCreatedAt !== claimRow.created_at
        ) {
          throw new Error("board claim conflict: idempotent run no longer has its original claim");
        }
        return { task: cloneTask(task), claim: claimFromRow(claimRow) };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (!claimRow || claimRow.lease_token !== normalizedToken) {
        throw new Error(`board claim conflict for ${normalizedId}`);
      }
      if (Date.parse(claimRow.expires_at) <= now.getTime()) {
        throw new Error(`board claim expired for ${normalizedId}`);
      }
      if (task.status !== "ready") {
        throw new Error(`board task ${normalizedId} must be ready before starting (current: ${task.status})`);
      }
      if (!allDependenciesDone(state.tasks, task)) {
        throw new Error(`board task ${normalizedId} has unmet dependencies`);
      }
      const board = await this.getBoard(task.boardSlug);
      if (!board) {
        throw new Error(`board not found: ${task.boardSlug}`);
      }
      enforceWipLimits(state, task, board.settings.limits);
      const taskRun = startRunRecord(state, task, timestamp, claimRow.owner);
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: taskRun.id,
        eventType: "task.run_started",
        actor: options.actor,
        payload: {
          owner: claimRow.owner,
          attempt: taskRun.attempt,
          claimCreatedAt: claimRow.created_at,
          revision: task.revision,
        },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), claim: claimFromRow(claimRow) };
    });
  }

  async dispatchNext(slug: string, input: BoardMutationOptions & {
    owner?: string;
    automatic?: boolean;
  } = {}): Promise<BoardDispatchResult> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const owner = input.owner?.trim() ? redactSecrets(input.owner.trim()) : `dispatcher:${normalizedSlug}`;
    return await this.enqueueWrite(async () => {
      const board = await this.getBoard(normalizedSlug);
      if (!board) {
        throw new Error(`board not found: ${normalizedSlug}`);
      }
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.dispatched");
      if (repeated) {
        if (repeated.boardSlug !== normalizedSlug || !repeated.taskId) {
          throw new Error("idempotency key belongs to a different board dispatch");
        }
        const state = await this.store.read(defaultState());
        const task = findTask(state.tasks, repeated.taskId);
        const claim = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [task.id]);
        if (claim && repeated.payload.claimCreatedAt !== claim.created_at) {
          throw new Error("board claim conflict: idempotent dispatch no longer has its original claim");
        }
        return { task: cloneTask(task), claim: claim ? claimFromRow(claim) : null };
      }
      if (input.automatic !== false && board.dispatcherPolicy !== "automatic") {
        return { task: null, claim: null, reason: "manual" };
      }
      const state = await this.store.read(defaultState());
      const promoted: BoardTaskRecord[] = [];
      for (const task of state.tasks) {
        if (
          task.boardSlug === normalizedSlug
          && task.status === "scheduled"
          && isScheduleDue(task, timestamp)
          && allDependenciesDone(state.tasks, task)
        ) {
          task.status = "ready";
          task.revision += 1;
          task.updatedAt = timestamp;
          delete task.nextRetryAt;
          promoted.push(task);
        }
      }
      const claimRows = await this.repository.queryAll<ClaimRow>(`
        SELECT claims.*
        FROM claims
        JOIN tasks ON tasks.id = claims.task_id
        JOIN boards ON boards.id = tasks.board_id
        WHERE boards.slug = ?
      `, [normalizedSlug]);
      const activeClaims = new Map<string, ClaimRow>();
      const expiredClaimRows: ClaimRow[] = [];
      for (const claim of claimRows) {
        if (Date.parse(claim.expires_at) <= now.getTime()) {
          expiredClaimRows.push(claim);
        } else {
          activeClaims.set(claim.task_id, claim);
        }
      }
      const recoveredClaims = await this.recoverExpiredClaimRows(state, expiredClaimRows, timestamp);
      if (board.settings.circuitOpenUntil && Date.parse(board.settings.circuitOpenUntil) > now.getTime()) {
        if (promoted.length > 0 || recoveredClaims.length > 0) {
          await this.store.write(state);
          await this.appendClaimExpiredEvents(recoveredClaims, timestamp);
          for (const task of promoted) {
            await this.appendEvent({
              boardSlug: normalizedSlug,
              taskId: task.id,
              eventType: "task.promoted",
              payload: { status: task.status, revision: task.revision },
              createdAt: timestamp,
            });
          }
        }
        return { task: null, claim: null, reason: "circuit_open" };
      }
      const priorityRank: Record<BoardTaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      const candidates = state.tasks
        .filter((task) => task.boardSlug === normalizedSlug && task.status === "ready" && !activeClaims.has(task.id))
        .sort((left, right) => {
          return priorityRank[left.priority] - priorityRank[right.priority]
            || Date.parse(left.createdAt) - Date.parse(right.createdAt)
            || left.id.localeCompare(right.id, undefined, { numeric: true });
        });
      let selected: BoardTaskRecord | undefined;
      for (const candidate of candidates) {
        try {
          enforceWipLimits(state, candidate, board.settings.limits);
          selected = candidate;
          break;
        } catch (error) {
          if (!/WIP limit/i.test(error instanceof Error ? error.message : String(error))) {
            throw error;
          }
        }
      }
      if (!selected) {
        if (promoted.length > 0 || recoveredClaims.length > 0) {
          await this.store.write(state);
          await this.appendClaimExpiredEvents(recoveredClaims, timestamp);
          for (const task of promoted) {
            await this.appendEvent({
              boardSlug: normalizedSlug,
              taskId: task.id,
              eventType: "task.promoted",
              payload: { status: task.status, revision: task.revision },
              createdAt: timestamp,
            });
          }
        }
        return {
          task: null,
          claim: null,
          reason: candidates.length > 0 ? "wip_limit" : "empty",
        };
      }
      const claim: BoardClaim = {
        taskId: selected.id,
        owner,
        leaseToken: randomUUID(),
        expiresAt: new Date(now.getTime() + board.settings.leaseDurationMs).toISOString(),
        heartbeatAt: timestamp,
        createdAt: timestamp,
      };
      const taskRun = startRunRecord(state, selected, timestamp, owner);
      selected.revision += 1;
      selected.updatedAt = timestamp;
      await this.store.write(state);
      await this.repository.execute(`
        INSERT INTO claims (task_id, owner, lease_token, expires_at, heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [claim.taskId, claim.owner, claim.leaseToken, claim.expiresAt, claim.heartbeatAt, claim.createdAt]);
      await this.appendClaimExpiredEvents(recoveredClaims, timestamp);
      for (const task of promoted) {
        if (task.id === selected.id) continue;
        await this.appendEvent({
          boardSlug: normalizedSlug,
          taskId: task.id,
          eventType: "task.promoted",
          payload: { status: task.status, revision: task.revision },
          createdAt: timestamp,
        });
      }
      await this.appendEvent({
        boardSlug: normalizedSlug,
        taskId: selected.id,
        runId: taskRun.id,
        eventType: "task.dispatched",
        actor: input.actor,
        payload: {
          owner,
          attempt: taskRun.attempt,
          expiresAt: claim.expiresAt,
          claimCreatedAt: claim.createdAt,
          revision: selected.revision,
        },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(selected), claim };
    });
  }

  async completeClaimedTask(
    id: string,
    leaseToken: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedToken = leaseToken.trim();
    if (!normalizedToken) {
      throw new Error("board lease token is required");
    }
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const eventType = "task.claimed_run_completed";
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, eventType);
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different claimed task completion");
        }
        const promotedTaskIds = Array.isArray(repeated.payload.promotedTaskIds)
          ? repeated.payload.promotedTaskIds.filter((value): value is string => typeof value === "string")
          : [];
        return { task: cloneTask(task), promotedTaskIds };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const claim = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
      if (!claim || claim.lease_token !== normalizedToken) {
        throw new Error(`board claim conflict for ${normalizedId}`);
      }
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun || task.status !== "running") {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      const shouldReview = task.review.required;
      const normalizedSummary = normalizeBoardSummary(summary);
      activeRun.status = shouldReview ? "review_requested" : "done";
      activeRun.completedAt = timestamp;
      if (normalizedSummary) activeRun.summary = normalizedSummary;
      task.status = shouldReview ? "review" : "done";
      if (normalizedSummary) task.summary = normalizedSummary;
      if (shouldReview) delete task.completedAt;
      else task.completedAt = timestamp;
      task.retryCount = 0;
      delete task.nextRetryAt;
      delete task.blockedReason;
      task.revision += 1;
      task.updatedAt = timestamp;
      const promotedTaskIds = shouldReview ? [] : promoteDependents(state, normalizedId, timestamp);
      for (const promotedId of promotedTaskIds) {
        const promoted = findTask(state.tasks, promotedId);
        promoted.revision += 1;
      }
      await this.store.write(state);
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);
      const board = await this.getBoard(task.boardSlug);
      if (board && (board.settings.consecutiveInfrastructureFailures > 0 || board.settings.circuitOpenUntil)) {
        const settings = {
          ...board.settings,
          consecutiveInfrastructureFailures: 0,
        };
        delete settings.circuitOpenUntil;
        await this.repository.execute(
          "UPDATE boards SET settings_json = ?, updated_at = ? WHERE id = ?",
          [serializeBoardSettings(settings, board.revision + 1), timestamp, board.id],
        );
      }
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType,
        actor: options.actor,
        payload: {
          outcome: shouldReview ? "review_requested" : "succeeded",
          promotedTaskIds,
          revision: task.revision,
        },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), promotedTaskIds };
    });
  }

  async recordDispatchFailure(
    id: string,
    leaseToken: string,
    error: string,
    input: BoardMutationOptions & { infrastructure?: boolean } = {},
  ): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedToken = leaseToken.trim();
    const normalizedError = redactSecrets(error.trim());
    if (!normalizedToken) throw new Error("board lease token is required");
    if (!normalizedError) throw new Error("board failure reason is required");
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.dispatch_failed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different dispatch failure");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      const claim = await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId]);
      if (!claim || claim.lease_token !== normalizedToken) {
        throw new Error(`board claim conflict for ${normalizedId}`);
      }
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      activeRun.status = "failed";
      activeRun.completedAt = timestamp;
      activeRun.error = normalizedError;
      const board = await this.getBoard(task.boardSlug);
      if (!board) throw new Error(`board not found: ${task.boardSlug}`);
      task.retryCount += 1;
      const maxRetries = task.execution.maxRetries ?? board.settings.defaultMaxRetries;
      if (task.retryCount <= maxRetries) {
        const delay = board.settings.retryBaseDelayMs * (2 ** Math.min(task.retryCount - 1, 10));
        task.status = "scheduled";
        task.nextRetryAt = new Date(now.getTime() + delay).toISOString();
        task.scheduledAt = task.nextRetryAt;
        delete task.blockedReason;
      } else {
        task.status = "blocked";
        task.blockedReason = normalizedError;
        delete task.nextRetryAt;
      }
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);
      if (input.infrastructure) {
        const failures = board.settings.consecutiveInfrastructureFailures + 1;
        const settings: BoardSettings = {
          ...board.settings,
          consecutiveInfrastructureFailures: failures,
          ...(failures >= board.settings.circuitBreakerThreshold
            ? { circuitOpenUntil: new Date(now.getTime() + board.settings.circuitBreakerCooldownMs).toISOString() }
            : {}),
        };
        await this.repository.execute(
          "UPDATE boards SET settings_json = ?, updated_at = ? WHERE id = ?",
          [serializeBoardSettings(settings, board.revision + 1), timestamp, board.id],
        );
      }
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.dispatch_failed",
        actor: input.actor,
        payload: {
          infrastructure: input.infrastructure === true,
          retryCount: task.retryCount,
          nextRetryAt: task.nextRetryAt ?? null,
          status: task.status,
          revision: task.revision,
        },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async recoverExpiredClaims(now: Date = new Date()): Promise<BoardTaskRecord[]> {
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const rows = await this.repository.queryAll<ClaimRow>("SELECT * FROM claims WHERE expires_at <= ? ORDER BY expires_at", [timestamp]);
      if (rows.length === 0) return [];
      const state = await this.store.read(defaultState());
      const recovered = await this.recoverExpiredClaimRows(state, rows, timestamp);
      await this.store.write(state);
      await this.appendClaimExpiredEvents(recovered, timestamp);
      return recovered.map(({ task }) => cloneTask(task));
    });
  }

  async recoverTimedOutRuns(now: Date = new Date()): Promise<BoardTaskRecord[]> {
    const timestamp = now.toISOString();
    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const boards = new Map((await this.listBoards()).map((board) => [board.slug, board]));
      const timedOut: BoardTaskRecord[] = [];
      for (const task of state.tasks) {
        const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
        if (!activeRun) continue;
        const timeoutMs = task.execution.timeoutMs ?? boards.get(task.boardSlug)?.settings.defaultTimeoutMs;
        if (timeoutMs === undefined || timeoutMs === 0) continue;
        const lastSeen = Date.parse(activeRun.lastHeartbeatAt ?? activeRun.startedAt);
        if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen < timeoutMs) continue;
        activeRun.status = "timed_out";
        activeRun.completedAt = timestamp;
        activeRun.error = `run timed out after ${timeoutMs}ms`;
        task.status = "blocked";
        task.blockedReason = activeRun.error;
        task.revision += 1;
        task.updatedAt = timestamp;
        await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
        timedOut.push(task);
      }
      if (timedOut.length === 0) return [];
      await this.store.write(state);
      for (const task of timedOut) {
        const activeRun = [...task.runs].reverse().find((run) => {
          return run.status === "timed_out" && run.completedAt === timestamp;
        });
        if (!activeRun) {
          throw new Error(`board task ${task.id} timed-out run could not be identified`);
        }
        await this.appendEvent({
          boardSlug: task.boardSlug,
          taskId: task.id,
          runId: activeRun.id,
          eventType: "task.timed_out",
          payload: { error: activeRun.error, revision: task.revision },
          createdAt: timestamp,
        });
      }
      return timedOut.map(cloneTask);
    });
  }

  async requestReview(id: string, summary?: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.review_requested", options, async (_state, task, timestamp) => {
      if (!task.review.required) {
        throw new Error(`board task ${task.id} does not require review`);
      }
      if (task.status !== "running") {
        throw new Error(`board task ${task.id} cannot request review from ${task.status}`);
      }
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) throw new Error(`board task ${task.id} has no running run`);
      const normalizedSummary = normalizeBoardSummary(summary);
      activeRun.status = "review_requested";
      activeRun.completedAt = timestamp;
      if (normalizedSummary) activeRun.summary = normalizedSummary;
      task.status = "review";
      if (normalizedSummary) task.summary = normalizedSummary;
      delete task.completedAt;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      return { runId: activeRun.id, reviewer: task.review.reviewer ?? null };
    });
  }

  async approveReview(id: string, options: BoardMutationOptions = {}): Promise<BoardCompletionResult> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.review_approved");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different review approval");
        }
        const promotedTaskIds = Array.isArray(repeated.payload.promotedTaskIds)
          ? repeated.payload.promotedTaskIds.filter((value): value is string => typeof value === "string")
          : [];
        return { task: cloneTask(task), promotedTaskIds };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (task.status !== "review") {
        throw new Error(`board task ${normalizedId} is not in review`);
      }
      task.status = "done";
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
      task.revision += 1;
      const promotedTaskIds = promoteDependents(state, normalizedId, timestamp);
      for (const promotedId of promotedTaskIds) {
        findTask(state.tasks, promotedId).revision += 1;
      }
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.review_approved",
        actor: options.actor,
        payload: { promotedTaskIds, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), promotedTaskIds };
    });
  }

  async requestChanges(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedReason = redactSecrets(reason.trim());
    if (!normalizedReason) throw new Error("board review change reason is required");
    return await this.mutateTaskWithEvent(id, "task.review_changes_requested", options, (_state, task) => {
      if (task.status !== "review") {
        throw new Error(`board task ${task.id} is not in review`);
      }
      task.status = "blocked";
      task.blockedReason = normalizedReason;
      return { reason: normalizedReason };
    });
  }

  async stats(slug: string): Promise<BoardStats> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const tasks = await this.listBoardTasks(normalizedSlug);
    const byStatus = Object.fromEntries(
      (["triage", "todo", "scheduled", "ready", "running", "review", "blocked", "done", "archived"] as BoardTaskStatus[])
        .map((status) => [status, 0]),
    ) as Record<BoardTaskStatus, number>;
    let activeRuns = 0;
    let completedRuns = 0;
    let failedRuns = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    for (const task of tasks) {
      byStatus[task.status] += 1;
      for (const taskRun of task.runs) {
        if (taskRun.status === "running") activeRuns += 1;
        else if (["done", "succeeded", "review_requested"].includes(taskRun.status)) completedRuns += 1;
        else failedRuns += 1;
        totalInputTokens += taskRun.inputTokens ?? 0;
        totalOutputTokens += taskRun.outputTokens ?? 0;
        totalCostUsd += taskRun.costUsd ?? 0;
      }
    }
    return {
      boardSlug: normalizedSlug,
      totalTasks: tasks.length,
      byStatus,
      activeClaims: (await this.listClaims(normalizedSlug)).length,
      activeRuns,
      completedRuns,
      failedRuns,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
    };
  }

  async exportBoard(slug: string, options: BoardExportOptions = {}): Promise<BoardExport> {
    const normalizedSlug = normalizeBoardSlug(slug);
    const board = await this.getBoard(normalizedSlug);
    if (!board) throw new Error(`board not found: ${normalizedSlug}`);
    const includeActors = options.includeActorIdentifiers === true;
    const includeWorkspaceDetails = options.includeWorkspaceDetails === true;
    const tasks = (await this.listBoardTasks(normalizedSlug)).map((task) => {
      const exported = cloneTask(task);
      if (!includeActors) {
        exported.createdBy = redactedActor();
        delete exported.assignee;
        exported.review = { required: exported.review.required };
        exported.runs = exported.runs.map((taskRun) => {
          const sanitized = { ...taskRun };
          delete sanitized.dispatchTarget;
          return sanitized;
        });
      }
      if (!includeWorkspaceDetails && exported.workspace) {
        exported.workspace = { mode: exported.workspace.mode };
      }
      if (!options.includeDetailedLogs) {
        exported.runs = exported.runs.map((taskRun) => {
          const sanitized = { ...taskRun };
          delete sanitized.logText;
          return sanitized;
        });
      }
      return exported;
    });
    const commentRows = await this.repository.queryAll<CommentRow>(`
      SELECT comments.*
      FROM comments
      JOIN tasks ON tasks.id = comments.task_id
      JOIN boards ON boards.id = tasks.board_id
      WHERE boards.slug = ?
      ORDER BY comments.created_at, comments.id
    `, [normalizedSlug]);
    const comments = commentRows.map(commentFromRow).map((comment) => {
      return includeActors ? comment : { ...comment, actor: redactedActor() };
    });
    const attachmentRows = await this.repository.queryAll<AttachmentRow>(`
      SELECT attachments.*
      FROM attachments
      JOIN tasks ON tasks.id = attachments.task_id
      JOIN boards ON boards.id = tasks.board_id
      WHERE boards.slug = ?
      ORDER BY attachments.created_at, attachments.id
    `, [normalizedSlug]);
    const maxAttachmentBytes = requirePositiveByteLimit(
      options.maxAttachmentBytes,
      DEFAULT_ATTACHMENT_LIMIT_BYTES,
      "board export attachment limit",
    );
    const attachments: Array<BoardAttachment & { dataBase64?: string }> = [];
    for (const row of attachmentRows) {
      const attachment = attachmentFromRow(row);
      const exported: BoardAttachment & { dataBase64?: string } = includeActors
        ? attachment
        : { ...attachment, actor: redactedActor() };
      if (options.includeAttachmentData) {
        const assetPath = await this.resolveOwnedAssetPath(attachment.storagePath);
        const assetStat = await stat(assetPath);
        if (!assetStat.isFile() || assetStat.size !== attachment.sizeBytes || assetStat.size > maxAttachmentBytes) {
          throw new Error(`board attachment asset is invalid or oversized: ${attachment.id}`);
        }
        const data = await readFile(assetPath);
        const digest = createHash("sha256").update(data).digest("hex");
        if (data.length !== attachment.sizeBytes || data.length > maxAttachmentBytes || digest !== attachment.contentHash) {
          throw new Error(`board attachment asset hash mismatch: ${attachment.id}`);
        }
        exported.dataBase64 = data.toString("base64");
      }
      attachments.push(exported);
    }
    let events: BoardEvent[] | undefined;
    if (options.includeEvents) {
      events = [];
      let afterSequence = 0;
      while (true) {
        const remaining = MAX_EXPORT_EVENTS - events.length;
        const page = await this.listEvents({
          boardSlug: normalizedSlug,
          afterSequence,
          limit: Math.min(MAX_EVENT_PAGE_SIZE, remaining + 1),
        });
        if (page.length === 0) break;
        if (page.length > remaining) {
          throw new Error("board export event limit exceeded");
        }
        events.push(...page.map((event) => ({
          ...event,
          ...(!includeActors ? { actor: undefined } : {}),
          payload: redactExportPayload(event.payload, {
            includeActorIdentifiers: includeActors,
            includeWorkspaceDetails,
          }) as Record<string, unknown>,
        })));
        afterSequence = page[page.length - 1]!.sequence;
        if (page.length < Math.min(MAX_EVENT_PAGE_SIZE, remaining + 1)) break;
      }
    }
    return {
      format: "tarocub-kanban",
      version: 1,
      exportedAt: new Date().toISOString(),
      board,
      tasks,
      comments,
      attachments,
      ...(events ? { events } : {}),
    };
  }

  async importBoard(
    value: unknown,
    input: BoardMutationOptions & { slug?: string; name?: string; maxAttachmentBytes?: number } = {},
  ): Promise<{ board: BoardRecord; taskIds: string[] }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("board import must be an object");
    }
    const source = value as Partial<BoardExport>;
    if (source.format !== "tarocub-kanban" || source.version !== 1) {
      throw new Error(`unsupported board import format or version: ${String(source.version)}`);
    }
    if (!source.board || !Array.isArray(source.tasks) || !Array.isArray(source.comments) || !Array.isArray(source.attachments)) {
      throw new Error("board import is missing required records");
    }
    const sourceBoard = source.board;
    const slug = normalizeBoardSlug(input.slug ?? sourceBoard.slug);
    const name = redactSecrets((input.name ?? sourceBoard.name).trim());
    if (!name) throw new Error("board name is required");
    const taskIds = new Set<string>();
    const runIds = new Set<string>();
    const tasks = source.tasks.map((candidate) => {
      const parsed = BoardTaskRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(`invalid board import task: ${parsed.error.message}`);
      }
      const task = normalizeTask(parsed.data as BoardTaskRecord);
      if (taskIds.has(task.id)) throw new Error(`duplicate board import task id: ${task.id}`);
      taskIds.add(task.id);
      task.boardSlug = slug;
      for (const taskRun of task.runs) {
        if (runIds.has(taskRun.id)) throw new Error(`duplicate board import run id: ${taskRun.id}`);
        runIds.add(taskRun.id);
      }
      return task;
    });
    for (const task of tasks) {
      if (task.parentTaskId && !taskIds.has(task.parentTaskId)) {
        throw new Error(`board import parent is outside the imported board: ${task.parentTaskId}`);
      }
      for (const dependencyId of task.dependencies) {
        if (!taskIds.has(dependencyId)) {
          throw new Error(`board import dependency is outside the imported board: ${dependencyId}`);
        }
      }
    }
    const cycle = findDependencyCycle(tasks);
    if (cycle) throw new Error(`board dependency cycle rejected: ${cycle.join(" -> ")}`);
    const parentCycle = findParentCycle(tasks);
    if (parentCycle) throw new Error(`board parent cycle rejected: ${parentCycle.join(" -> ")}`);
    const comments = source.comments.map((candidate) => normalizeImportedComment(candidate, taskIds));
    if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
      throw new Error("duplicate board import comment id");
    }
    const repeatedImport = await this.findIdempotentEvent(input.idempotencyKey, "board.imported");
    if (repeatedImport) {
      const existing = await this.getBoard(slug);
      if (!existing || repeatedImport.boardSlug !== slug) {
        throw new Error("idempotent board import is incomplete");
      }
      return { board: existing, taskIds: tasks.map((task) => task.id) };
    }
    if (await this.getBoard(slug)) throw new Error(`board already exists: ${slug}`);
    const preflightState = await this.store.read(defaultState());
    for (const task of tasks) {
      if (preflightState.tasks.some((existing) => existing.id === task.id)) {
        throw new Error(`board import task id already exists: ${task.id}`);
      }
    }
    if (preflightState.tasks.some((existing) => existing.runs.some((taskRun) => runIds.has(taskRun.id)))) {
      throw new Error("board import run id already exists");
    }
    const maxAttachmentBytes = requirePositiveByteLimit(
      input.maxAttachmentBytes,
      DEFAULT_ATTACHMENT_LIMIT_BYTES,
      "board import attachment limit",
    );
    const attachments: BoardAttachment[] = [];
    for (const candidate of source.attachments) {
      const attachment = await this.prepareImportedAttachment(candidate, taskIds, maxAttachmentBytes);
      attachments.push(attachment);
    }
    if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
      throw new Error("duplicate board import attachment id");
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "board.imported");
      if (repeated) {
        const existing = await this.getBoard(slug);
        if (!existing) throw new Error("idempotent board import is incomplete");
        return { board: existing, taskIds: tasks.map((task) => task.id) };
      }
      if (await this.getBoard(slug)) throw new Error(`board already exists: ${slug}`);
      const state = await this.store.read(defaultState());
      for (const task of tasks) {
        if (state.tasks.some((existing) => existing.id === task.id)) {
          throw new Error(`board import task id already exists: ${task.id}`);
        }
        if (state.tasks.some((existing) => existing.runs.some((taskRun) => runIds.has(taskRun.id)))) {
          throw new Error("board import run id already exists");
        }
      }
      const settings = mergeBoardSettings(DEFAULT_BOARD_SETTINGS, sourceBoard.settings ?? {});
      const boardResult = await this.repository.execute(`
        INSERT INTO boards (slug, name, settings_json, dispatcher_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [slug, name, serializeBoardSettings(settings, 1), "manual", timestamp, timestamp]);
      state.tasks.push(...tasks);
      await this.store.write(state);
      for (const comment of comments) {
        await this.repository.execute(
          "INSERT INTO comments (id, task_id, body, actor_json, created_at) VALUES (?, ?, ?, ?, ?)",
          [comment.id, comment.taskId, comment.body, JSON.stringify(comment.actor), comment.createdAt],
        );
      }
      for (const attachment of attachments) {
        await this.repository.execute(`
          INSERT INTO attachments (
            id, task_id, content_hash, storage_path, original_name, media_type, size_bytes, created_at, actor_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          attachment.id,
          attachment.taskId,
          attachment.contentHash,
          attachment.storagePath,
          attachment.originalName,
          attachment.mediaType ?? null,
          attachment.sizeBytes,
          attachment.createdAt,
          JSON.stringify(attachment.actor),
        ]);
      }
      await this.appendEvent({
        boardSlug: slug,
        eventType: "board.imported",
        actor: input.actor,
        payload: { taskCount: tasks.length, commentCount: comments.length, attachmentCount: attachments.length, slug },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      const board: BoardRecord = {
        id: boardResult.lastID,
        slug,
        name,
        settings,
        dispatcherPolicy: "manual",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { board, taskIds: tasks.map((task) => task.id) };
    });
  }

  async operationalDiagnostics(now: Date = new Date()): Promise<BoardOperationalDiagnostics> {
    const storage = await this.repository.diagnostics();
    if (!storage.initialized || !storage.ok) {
      return { storage, expiredClaims: [], inconsistentRuns: [], missingAssets: [] };
    }
    const state = await this.store.read(defaultState());
    const expiredClaims = (await this.repository.queryAll<ClaimRow>(
      "SELECT * FROM claims WHERE expires_at <= ? ORDER BY expires_at",
      [now.toISOString()],
    )).map((claim) => claim.task_id);
    const inconsistentRuns: string[] = [];
    for (const task of state.tasks) {
      const activeRuns = task.runs.filter((taskRun) => taskRun.status === "running");
      if (activeRuns.length > 0 && task.status !== "running") {
        inconsistentRuns.push(`${task.id}: active run while task is ${task.status}`);
      } else if (task.status === "running" && activeRuns.length === 0) {
        inconsistentRuns.push(`${task.id}: running task without active run`);
      }
    }
    const attachmentRows = await this.repository.queryAll<AttachmentRow>("SELECT * FROM attachments ORDER BY id");
    const missingAssets: string[] = [];
    for (const row of attachmentRows) {
      try {
        const assetPath = await this.resolveOwnedAssetPath(row.storage_path);
        const digest = await hashFileBounded(assetPath, Math.max(row.size_bytes, 1));
        if (digest.hash !== row.content_hash || digest.size !== row.size_bytes) {
          missingAssets.push(row.id);
        }
      } catch {
        missingAssets.push(row.id);
      }
    }
    return { storage, expiredClaims, inconsistentRuns, missingAssets };
  }

  async repair(input: BoardMutationOptions & { confirm?: boolean } = {}): Promise<BoardRepairReport> {
    const now = input.now ?? new Date();
    const diagnostics = await this.operationalDiagnostics(now);
    const preview: BoardRepairReport = {
      expiredClaims: diagnostics.expiredClaims,
      inconsistentRuns: diagnostics.inconsistentRuns,
      missingAssets: diagnostics.missingAssets,
      changed: false,
    };
    if (!input.confirm) return preview;
    if (!diagnostics.storage.ok || !diagnostics.storage.initialized) {
      throw new Error("Kanban repair requires a healthy initialized database");
    }
    const suffix = now.toISOString().replace(/[-:.]/g, "");
    const backupPath = await this.repository.backupTo(
      `${resolveKanbanDatabasePath(this.stateDir)}.repair-${suffix}-${randomUUID()}.bak`,
    );
    const timestamp = now.toISOString();
    const changedTaskIds = await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const changed = new Set<string>();
      const expired = await this.repository.queryAll<ClaimRow>(
        "SELECT * FROM claims WHERE expires_at <= ? ORDER BY expires_at",
        [timestamp],
      );
      for (const claim of expired) {
        const task = findTask(state.tasks, claim.task_id);
        const activeRun = [...task.runs].reverse().find((taskRun) => taskRun.status === "running");
        if (activeRun) {
          activeRun.status = "timed_out";
          activeRun.completedAt = timestamp;
          activeRun.error = "claim lease expired during repair";
          task.status = "blocked";
          task.blockedReason = activeRun.error;
          changed.add(task.id);
        }
        await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      }
      for (const task of state.tasks) {
        const activeRuns = task.runs.filter((taskRun) => taskRun.status === "running");
        if (activeRuns.length > 0 && task.status !== "running") {
          for (const taskRun of activeRuns) {
            taskRun.status = "blocked";
            taskRun.completedAt = timestamp;
            taskRun.error = `repair closed run while task was ${task.status}`;
          }
          changed.add(task.id);
        } else if (task.status === "running" && activeRuns.length === 0) {
          task.status = "blocked";
          task.blockedReason = "repair found running task without an active run";
          changed.add(task.id);
        }
      }
      for (const taskId of changed) {
        const task = findTask(state.tasks, taskId);
        task.revision += 1;
        task.updatedAt = timestamp;
      }
      if (changed.size > 0) await this.store.write(state);
      for (const taskId of changed) {
        const task = findTask(state.tasks, taskId);
        await this.appendEvent({
          boardSlug: task.boardSlug,
          taskId,
          eventType: "task.repaired",
          actor: input.actor,
          payload: { status: task.status, revision: task.revision },
          createdAt: timestamp,
        });
      }
      return [...changed];
    });
    return {
      backupPath,
      expiredClaims: diagnostics.expiredClaims,
      inconsistentRuns: diagnostics.inconsistentRuns,
      missingAssets: diagnostics.missingAssets,
      changed: diagnostics.expiredClaims.length > 0 || changedTaskIds.length > 0,
    };
  }

  async gcAssets(input: BoardMutationOptions & { confirm?: boolean } = {}): Promise<BoardGcReport> {
    await this.repository.queryOne<{ id: number }>("SELECT id FROM boards WHERE slug = 'main'");
    const assetRoot = resolveKanbanAssetDirectory(this.stateDir);
    const files = await listOwnedAssetFiles(assetRoot);
    const referenced = new Set((await this.repository.queryAll<{ storage_path: string }>(
      "SELECT storage_path FROM attachments",
    )).map((row) => path.normalize(row.storage_path)));
    const candidates = files.filter((file) => !referenced.has(path.normalize(file))).sort();
    if (!input.confirm || candidates.length === 0) {
      return { candidates, quarantined: [] };
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    const quarantineDir = path.join(assetRoot, ".trash", timestamp.replace(/[-:.]/g, ""));
    const quarantined: string[] = [];
    for (const relativePath of candidates) {
      const sourcePath = path.resolve(assetRoot, relativePath);
      if (!isPathInside(path.resolve(assetRoot), sourcePath)) {
        throw new Error(`board GC candidate escapes asset root: ${relativePath}`);
      }
      const sourceStat = await lstat(sourcePath);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`board GC candidate is not a regular file: ${relativePath}`);
      }
      const destinationPath = path.join(quarantineDir, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      await rename(sourcePath, destinationPath);
      quarantined.push(relativePath);
    }
    await this.enqueueWrite(async () => {
      await this.appendEvent({
        boardSlug: "main",
        eventType: "board.assets_quarantined",
        actor: input.actor,
        payload: { count: quarantined.length, quarantineDir },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
    });
    return { candidates, quarantined, quarantineDir };
  }

  async listAttachments(id: string): Promise<BoardAttachment[]> {
    const normalizedId = requireBoardTaskId(id);
    if (!await this.getTask(normalizedId)) {
      throw new Error(`board task not found: ${normalizedId}`);
    }
    const rows = await this.repository.queryAll<AttachmentRow>(
      "SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      [normalizedId],
    );
    return rows.map(attachmentFromRow);
  }

  async attachFile(id: string, input: BoardAttachmentInput): Promise<{ task: BoardTaskRecord; attachment: BoardAttachment }> {
    const normalizedId = requireBoardTaskId(id);
    const initialTask = await this.getTask(normalizedId);
    if (!initialTask) {
      throw new Error(`board task not found: ${normalizedId}`);
    }
    const prepared = await this.prepareAttachmentFile(initialTask, input);
    const timestamp = (input.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(input.idempotencyKey, "task.attachment_added");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId || typeof repeated.payload.attachmentId !== "string") {
          throw new Error("idempotency key belongs to a different board attachment");
        }
        const existing = await this.repository.queryOne<AttachmentRow>(
          "SELECT * FROM attachments WHERE id = ?",
          [repeated.payload.attachmentId],
        );
        if (!existing) {
          throw new Error(`board attachment not found: ${repeated.payload.attachmentId}`);
        }
        return { task: cloneTask(task), attachment: attachmentFromRow(existing) };
      }
      requireExpectedRevision(task.revision, input.expectedRevision, `board task ${normalizedId}`);
      const attachment: BoardAttachment = {
        id: randomUUID(),
        taskId: normalizedId,
        contentHash: prepared.contentHash,
        storagePath: prepared.storagePath,
        originalName: sanitizeAttachmentName(input.originalName ?? path.basename(input.sourcePath)),
        ...(input.mediaType?.trim() ? { mediaType: input.mediaType.trim().slice(0, 200) } : {}),
        sizeBytes: prepared.sizeBytes,
        createdAt: timestamp,
        actor: requireActor(input.actor, "board attachment actor"),
      };
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.repository.execute(`
        INSERT INTO attachments (
          id, task_id, content_hash, storage_path, original_name, media_type, size_bytes, created_at, actor_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        attachment.id,
        attachment.taskId,
        attachment.contentHash,
        attachment.storagePath,
        attachment.originalName,
        attachment.mediaType ?? null,
        attachment.sizeBytes,
        attachment.createdAt,
        JSON.stringify(attachment.actor),
      ]);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.attachment_added",
        actor: input.actor,
        payload: {
          attachmentId: attachment.id,
          contentHash: attachment.contentHash,
          sizeBytes: attachment.sizeBytes,
          revision: task.revision,
        },
        idempotencyKey: input.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), attachment };
    });
  }

  async detachAttachment(
    id: string,
    attachmentId: string,
    options: BoardMutationOptions = {},
  ): Promise<{ task: BoardTaskRecord; attachment: BoardAttachment }> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedAttachmentId = attachmentId.trim();
    if (!normalizedAttachmentId) {
      throw new Error("board attachment id is required");
    }
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.attachment_detached");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId || repeated.payload.attachmentId !== normalizedAttachmentId) {
          throw new Error("idempotency key belongs to a different board attachment detach");
        }
        return {
          task: cloneTask(task),
          attachment: attachmentFromEventPayload(repeated.payload.attachment, normalizedId),
        };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const row = await this.repository.queryOne<AttachmentRow>(
        "SELECT * FROM attachments WHERE id = ? AND task_id = ?",
        [normalizedAttachmentId, normalizedId],
      );
      if (!row) {
        throw new Error(`board attachment not found: ${normalizedAttachmentId}`);
      }
      const attachment = attachmentFromRow(row);
      await this.repository.execute("DELETE FROM attachments WHERE id = ?", [normalizedAttachmentId]);
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.attachment_detached",
        actor: options.actor,
        payload: {
          attachmentId: normalizedAttachmentId,
          attachment,
          contentHash: attachment.contentHash,
          revision: task.revision,
        },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return { task: cloneTask(task), attachment };
    });
  }

  async heartbeatTask(
    id: string,
    note?: string,
    now: Date = new Date(),
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? now).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_heartbeat");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different task heartbeat");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      activeRun.lastHeartbeatAt = timestamp;
      const normalizedNote = note ? redactSecrets(note.trim()) : undefined;
      if (normalizedNote) {
        activeRun.heartbeatNote = normalizedNote;
      } else {
        delete activeRun.heartbeatNote;
      }
      task.updatedAt = timestamp;
      task.revision += 1;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.run_heartbeat",
        actor: options.actor,
        payload: { revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async recoverStaleRuns(input: {
    olderThanMs: number;
    now?: Date;
    reason?: string;
    actor?: BoardTaskActor;
  }): Promise<BoardTaskRecord[]> {
    const olderThanMs = Math.max(0, Math.trunc(input.olderThanMs));
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const timestamp = now.toISOString();
    const reason = input.reason?.trim()
      ? redactSecrets(input.reason.trim())
      : `stale board run recovered after ${Math.round(olderThanMs / 60_000)}m without heartbeat`;

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const recovered: Array<{ task: BoardTaskRecord; runId: string }> = [];
      for (const task of state.tasks) {
        const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
        if (!activeRun) {
          continue;
        }
        const lastSeen = Date.parse(activeRun.lastHeartbeatAt ?? activeRun.startedAt);
        if (!Number.isFinite(lastSeen) || nowMs - lastSeen < olderThanMs) {
          continue;
        }
        activeRun.status = "failed";
        activeRun.completedAt = timestamp;
        activeRun.error = reason;
        task.status = "blocked";
        task.blockedReason = reason;
        task.revision += 1;
        task.updatedAt = timestamp;
        await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
        recovered.push({ task, runId: activeRun.id });
      }
      if (recovered.length > 0) {
        await this.store.write(state);
        for (const { task, runId } of recovered) {
          await this.appendEvent({
            boardSlug: task.boardSlug,
            taskId: task.id,
            runId,
            eventType: "task.stale_run_recovered",
            actor: input.actor,
            payload: { reason, revision: task.revision },
            createdAt: timestamp,
          });
        }
      }
      return recovered.map(({ task }) => cloneTask(task));
    });
  }

  async assignTask(id: string, assignee: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedAssignee = redactSecrets(assignee.trim());
    if (!normalizedAssignee) {
      throw new Error("board task assignee is required");
    }
    return await this.reassignTask(id, normalizedAssignee, options);
  }

  async addDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.linkDependency(id, dependencyId, options);
  }

  async markReady(id: string, options: BoardMutationOptions = {}): Promise<BoardReadyResult> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.marked_ready");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different ready transition");
        }
        return { task: cloneTask(task), unmetDependencies };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (task.status !== "todo" && task.status !== "ready") {
        throw new Error(`board task ${normalizedId} cannot be marked ready from ${task.status}`);
      }
      if (unmetDependencies.length === 0 && task.status === "todo") {
        task.status = "ready";
        task.revision += 1;
        task.updatedAt = timestamp;
        await this.store.write(state);
        await this.appendEvent({
          boardSlug: task.boardSlug,
          taskId: task.id,
          eventType: "task.marked_ready",
          actor: options.actor,
          payload: { revision: task.revision },
          idempotencyKey: options.idempotencyKey,
          createdAt: timestamp,
        });
      }
      return {
        task: cloneTask(task),
        unmetDependencies,
      };
    });
  }

  async startTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.startTaskWithRequiredStatus(id, undefined, options);
  }

  async startReadyTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await this.startTaskWithRequiredStatus(id, "ready", options);
  }

  private async startTaskWithRequiredStatus(
    id: string,
    requiredStatus: BoardTaskStatus | undefined,
    options: BoardMutationOptions,
  ): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_started");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different run start");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (requiredStatus && task.status !== requiredStatus) {
        throw new Error(`board task ${normalizedId} must be ${requiredStatus} before starting (current: ${task.status})`);
      }
      if (task.runs.some((run) => run.status === "running")) {
        throw new Error(`board task ${normalizedId} already running`);
      }
      if (!requiredStatus && task.status !== "todo" && task.status !== "ready") {
        throw new Error(`board task ${normalizedId} cannot be started from ${task.status}`);
      }
      if (await this.repository.queryOne<ClaimRow>("SELECT * FROM claims WHERE task_id = ?", [normalizedId])) {
        throw new Error(`board claim conflict for ${normalizedId}: use the claimed-task start operation`);
      }
      enforceWipLimits(state, task);
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (unmetDependencies.length > 0) {
        throw new Error(`board task ${normalizedId} has unmet dependencies: ${unmetDependencies.join(", ")}`);
      }
      const run: BoardTaskRun = {
        id: `R${state.nextRunId}`,
        status: "running",
        startedAt: timestamp,
      };
      state.nextRunId += 1;
      task.runs.push(run);
      task.status = "running";
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: run.id,
        eventType: "task.run_started",
        actor: options.actor,
        payload: { attempt: run.attempt ?? 1, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async failTask(id: string, error: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedError = redactSecrets(error.trim());
    if (!normalizedError) {
      throw new Error("board failure reason is required");
    }
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_failed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different run failure");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      activeRun.status = "failed";
      activeRun.completedAt = timestamp;
      activeRun.error = normalizedError;
      task.status = "blocked";
      task.blockedReason = normalizedError;
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.run_failed",
        actor: options.actor,
        payload: { error: normalizedError, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async failRunningRun(
    id: string,
    runId: string,
    error: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord | null> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedRunId = runId.trim();
    const normalizedError = redactSecrets(error.trim());
    if (!normalizedRunId) {
      throw new Error("board run id is required");
    }
    if (!normalizedError) {
      throw new Error("board failure reason is required");
    }
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_failed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId || repeated.runId !== normalizedRunId) {
          throw new Error("idempotency key belongs to a different run failure");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun || activeRun.id !== normalizedRunId) {
        return null;
      }
      activeRun.status = "failed";
      activeRun.completedAt = timestamp;
      activeRun.error = normalizedError;
      task.status = "blocked";
      task.blockedReason = normalizedError;
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.run_failed",
        actor: options.actor,
        payload: { error: normalizedError, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async blockTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedReason = redactSecrets(reason.trim());
    if (!normalizedReason) {
      throw new Error("board block reason is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (task.status === "done" || task.status === "archived" || task.status === "review") {
        throw new Error(`board task ${normalizedId} cannot be blocked from ${task.status}`);
      }
      const timestamp = (options.now ?? new Date()).toISOString();
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.blocked");
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different task block");
        }
        return cloneTask(task);
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (activeRun) {
        activeRun.status = "failed";
        activeRun.completedAt = timestamp;
        activeRun.error = normalizedReason;
      }
      task.status = "blocked";
      task.blockedReason = normalizedReason;
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        ...(activeRun ? { runId: activeRun.id } : {}),
        eventType: "task.blocked",
        actor: options.actor,
        payload: { reason: normalizedReason, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  async unblockTask(id: string, options: BoardMutationOptions = {}): Promise<BoardReadyResult> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.unblocked");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different task unblock");
        }
        return { task: cloneTask(task), unmetDependencies };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (task.status !== "blocked") {
        throw new Error(`board task ${normalizedId} cannot be unblocked from ${task.status}`);
      }
      delete task.blockedReason;
      task.status = unmetDependencies.length === 0 ? "ready" : "todo";
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        eventType: "task.unblocked",
        actor: options.actor,
        payload: { status: task.status, unmetDependencies, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return {
        task: cloneTask(task),
        unmetDependencies,
      };
    });
  }

  async completeTask(
    id: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_completed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error("idempotency key belongs to a different task completion");
        }
        const promotedTaskIds = Array.isArray(repeated.payload.promotedTaskIds)
          ? repeated.payload.promotedTaskIds.filter((value): value is string => typeof value === "string")
          : [];
        return { task: cloneTask(task), promotedTaskIds };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      if (task.status !== "running") {
        throw new Error(`board task ${normalizedId} cannot be completed from ${task.status}`);
      }
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      const shouldReview = task.review.required;
      const normalizedSummary = normalizeBoardSummary(summary);
      task.status = shouldReview ? "review" : "done";
      if (!shouldReview) {
        task.completedAt = timestamp;
      } else {
        delete task.completedAt;
      }
      task.updatedAt = timestamp;
      if (normalizedSummary) {
        task.summary = normalizedSummary;
      }
      delete task.blockedReason;
      activeRun.status = shouldReview ? "review_requested" : "done";
      activeRun.completedAt = timestamp;
      if (task.summary) {
        activeRun.summary = task.summary;
      }

      const promotedTaskIds = shouldReview ? [] : promoteDependents(state, normalizedId, timestamp);
      task.revision += 1;
      for (const promotedId of promotedTaskIds) {
        findTask(state.tasks, promotedId).revision += 1;
      }
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);

      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.run_completed",
        actor: options.actor,
        payload: {
          outcome: shouldReview ? "review_requested" : "succeeded",
          promotedTaskIds,
          revision: task.revision,
        },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return {
        task: cloneTask(task),
        promotedTaskIds,
      };
    });
  }

  async completeRunningRun(
    id: string,
    runId: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult | null> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error("board run id is required");
    }
    const timestamp = (options.now ?? new Date()).toISOString();

    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, "task.run_completed");
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (repeated) {
        if (repeated.taskId !== normalizedId || repeated.runId !== normalizedRunId) {
          throw new Error("idempotency key belongs to a different run completion");
        }
        const promotedTaskIds = Array.isArray(repeated.payload.promotedTaskIds)
          ? repeated.payload.promotedTaskIds.filter((value): value is string => typeof value === "string")
          : [];
        return { task: cloneTask(task), promotedTaskIds };
      }
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun || activeRun.id !== normalizedRunId || task.status !== "running") {
        return null;
      }
      const shouldReview = task.review.required;
      const normalizedSummary = normalizeBoardSummary(summary);
      task.status = shouldReview ? "review" : "done";
      if (!shouldReview) {
        task.completedAt = timestamp;
      } else {
        delete task.completedAt;
      }
      task.updatedAt = timestamp;
      if (normalizedSummary) {
        task.summary = normalizedSummary;
      }
      delete task.blockedReason;
      activeRun.status = shouldReview ? "review_requested" : "done";
      activeRun.completedAt = timestamp;
      if (task.summary) {
        activeRun.summary = task.summary;
      }

      const promotedTaskIds = shouldReview ? [] : promoteDependents(state, normalizedId, timestamp);
      task.revision += 1;
      for (const promotedId of promotedTaskIds) {
        findTask(state.tasks, promotedId).revision += 1;
      }
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [normalizedId]);

      await this.store.write(state);
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        runId: activeRun.id,
        eventType: "task.run_completed",
        actor: options.actor,
        payload: {
          outcome: shouldReview ? "review_requested" : "succeeded",
          promotedTaskIds,
          revision: task.revision,
        },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return {
        task: cloneTask(task),
        promotedTaskIds,
      };
    });
  }

  async setReviewGate(
    id: string,
    review: { required: boolean; reviewer?: string },
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, "task.review_gate_updated", options, (_state, task) => {
      task.review = {
        required: review.required,
        ...(review.reviewer?.trim() ? { reviewer: redactSecrets(review.reviewer.trim()) } : {}),
      };
      return { required: task.review.required, reviewer: task.review.reviewer ?? null };
    });
  }

  async approveTask(id: string, options: BoardMutationOptions = {}): Promise<BoardCompletionResult> {
    return await this.approveReview(id, options);
  }

  async rejectTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    const normalizedReason = redactSecrets(reason.trim());
    if (!normalizedReason) {
      throw new Error("board review rejection reason is required");
    }
    return await this.requestChanges(id, normalizedReason, options);
  }

  private async resolveOwnedAssetPath(storagePath: string): Promise<string> {
    if (!storagePath || path.isAbsolute(storagePath)) {
      throw new Error("board attachment storage path must be relative");
    }
    const assetRoot = await realpath(resolveKanbanAssetDirectory(this.stateDir));
    const candidate = path.resolve(assetRoot, storagePath);
    if (!isPathInside(assetRoot, candidate)) {
      throw new Error("board attachment storage path escapes the asset root");
    }
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new Error("board attachment asset must be a regular non-symbolic-link file");
    }
    return candidate;
  }

  private async prepareImportedAttachment(
    value: unknown,
    taskIds: Set<string>,
    maxBytes: number,
  ): Promise<BoardAttachment> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid board import attachment");
    }
    const candidate = value as Partial<BoardAttachment> & { dataBase64?: string };
    const id = candidate.id?.trim();
    const taskId = candidate.taskId ? requireBoardTaskId(candidate.taskId) : "";
    const contentHash = candidate.contentHash?.trim().toLowerCase();
    const actor = BoardTaskActorSchema.safeParse(candidate.actor);
    if (
      !id
      || !taskId
      || !taskIds.has(taskId)
      || !contentHash
      || !/^[a-f0-9]{64}$/.test(contentHash)
      || !actor.success
      || !candidate.createdAt
      || typeof candidate.dataBase64 !== "string"
    ) {
      throw new Error(`invalid board import attachment: ${id ?? "unknown"}`);
    }
    if (candidate.dataBase64.length > Math.ceil(maxBytes / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.dataBase64)) {
      throw new Error(`board import attachment is oversized or not valid base64: ${id}`);
    }
    const data = Buffer.from(candidate.dataBase64, "base64");
    if (data.length > maxBytes || data.length !== candidate.sizeBytes) {
      throw new Error(`board import attachment size mismatch: ${id}`);
    }
    const actualHash = createHash("sha256").update(data).digest("hex");
    if (actualHash !== contentHash) {
      throw new Error(`board import attachment hash mismatch: ${id}`);
    }
    const storagePath = path.join(contentHash.slice(0, 2), contentHash);
    await this.writeOwnedAsset(storagePath, data, contentHash);
    return {
      id,
      taskId,
      contentHash,
      storagePath,
      originalName: sanitizeAttachmentName(candidate.originalName ?? "attachment"),
      ...(candidate.mediaType?.trim() ? { mediaType: candidate.mediaType.trim().slice(0, 200) } : {}),
      sizeBytes: data.length,
      createdAt: normalizeIsoDate(candidate.createdAt, "board attachment timestamp"),
      actor: requireActor(actor.data as BoardTaskActor, "board attachment actor"),
    };
  }

  private async writeOwnedAsset(storagePath: string, data: Buffer, expectedHash: string): Promise<void> {
    const assetRoot = resolveKanbanAssetDirectory(this.stateDir);
    const destination = path.resolve(assetRoot, storagePath);
    if (!isPathInside(path.resolve(assetRoot), destination)) {
      throw new Error("board attachment storage path escapes the asset root");
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(destination), 0o700);
    const existing = await lstat(destination).catch(() => null);
    if (existing) {
      await verifyOwnedAssetFile(destination, expectedHash, data.length, `board attachment asset ${storagePath}`);
      return;
    }
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, destination);
      await verifyOwnedAssetFile(destination, expectedHash, data.length, `board attachment asset ${storagePath}`);
      await chmod(destination, 0o600);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async prepareAttachmentFile(
    task: BoardTaskRecord,
    input: BoardAttachmentInput,
  ): Promise<{ contentHash: string; storagePath: string; sizeBytes: number }> {
    if (!path.isAbsolute(input.sourcePath)) {
      throw new Error("board attachment path must be absolute");
    }
    const sourceStat = await lstat(input.sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error("board attachment must be a regular non-symbolic-link file");
    }
    const resolvedSource = await realpath(input.sourcePath);
    const resolvedStateDir = await realpath(this.stateDir);
    const allowedRoots = [resolvedStateDir];
    if (task.workspace?.path) {
      const workspaceStat = await lstat(task.workspace.path).catch(() => null);
      if (workspaceStat?.isDirectory() && !workspaceStat.isSymbolicLink()) {
        allowedRoots.push(await realpath(task.workspace.path));
      }
    }
    if (!allowedRoots.some((root) => isPathInside(root, resolvedSource))) {
      throw new Error("board attachment is outside the instance state and task workspace roots");
    }
    const maxBytes = requirePositiveByteLimit(input.maxBytes, DEFAULT_ATTACHMENT_LIMIT_BYTES, "board attachment limit");
    const sourceDigest = await hashFileBounded(resolvedSource, maxBytes);
    const assetRoot = resolveKanbanAssetDirectory(this.stateDir);
    const relativePath = path.join(sourceDigest.hash.slice(0, 2), sourceDigest.hash);
    const destinationPath = path.join(assetRoot, relativePath);
    const destinationDirectory = path.dirname(destinationPath);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    await chmod(destinationDirectory, 0o700);

    const existingStat = await lstat(destinationPath).catch(() => null);
    if (existingStat) {
      await verifyOwnedAssetFile(
        destinationPath,
        sourceDigest.hash,
        sourceDigest.size,
        `board attachment asset ${relativePath}`,
      );
      await chmod(destinationPath, 0o600);
      return { contentHash: sourceDigest.hash, storagePath: relativePath, sizeBytes: sourceDigest.size };
    }

    const temporaryPath = path.join(destinationDirectory, `.${sourceDigest.hash}.${randomUUID()}.tmp`);
    try {
      await copyFile(resolvedSource, temporaryPath);
      await chmod(temporaryPath, 0o600);
      const copiedDigest = await hashFileBounded(temporaryPath, maxBytes);
      if (copiedDigest.hash !== sourceDigest.hash || copiedDigest.size !== sourceDigest.size) {
        throw new Error("board attachment changed while being copied");
      }
      await rename(temporaryPath, destinationPath).catch(async (error: unknown) => {
        if (!await lstat(destinationPath).catch(() => null)) {
          throw error;
        }
      });
      await verifyOwnedAssetFile(
        destinationPath,
        sourceDigest.hash,
        sourceDigest.size,
        `board attachment asset ${relativePath}`,
      );
      await chmod(destinationPath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return { contentHash: sourceDigest.hash, storagePath: relativePath, sizeBytes: sourceDigest.size };
  }

  private async closeActiveRun(
    id: string,
    runStatus: "cancelled" | "timed_out",
    reason: string,
    eventType: string,
    options: BoardMutationOptions,
  ): Promise<BoardTaskRecord> {
    return await this.mutateTaskWithEvent(id, eventType, options, async (_state, task, timestamp) => {
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${task.id} has no running run`);
      }
      activeRun.status = runStatus;
      activeRun.completedAt = timestamp;
      activeRun.error = reason;
      task.status = "blocked";
      task.blockedReason = reason;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      return { runId: activeRun.id, runStatus, reason };
    });
  }

  private async recoverExpiredClaimRows(
    state: BoardStoreState,
    rows: ClaimRow[],
    timestamp: string,
  ): Promise<RecoveredClaim[]> {
    const recovered: RecoveredClaim[] = [];
    for (const row of rows) {
      const task = findTask(state.tasks, row.task_id);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (activeRun) {
        activeRun.status = "timed_out";
        activeRun.completedAt = timestamp;
        activeRun.error = "claim lease expired";
        task.status = "blocked";
        task.blockedReason = "claim lease expired";
      } else if (task.status === "running") {
        task.status = "blocked";
        task.blockedReason = "claim lease expired without an active run";
      }
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.repository.execute("DELETE FROM claims WHERE task_id = ?", [task.id]);
      recovered.push({
        task,
        ...(activeRun ? { runId: activeRun.id } : {}),
        status: task.status,
        revision: task.revision,
      });
    }
    return recovered;
  }

  private async appendClaimExpiredEvents(recovered: RecoveredClaim[], timestamp: string): Promise<void> {
    for (const { task, runId, status, revision } of recovered) {
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        ...(runId ? { runId } : {}),
        eventType: "task.claim_expired",
        payload: { status, revision },
        createdAt: timestamp,
      });
    }
  }

  private async findIdempotentEvent(idempotencyKey: string | undefined, eventType: string): Promise<BoardEvent | null> {
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    if (!normalizedKey) {
      return null;
    }
    const row = await this.repository.queryOne<EventRow>(`
      SELECT events.*, boards.slug AS board_slug
      FROM events
      JOIN boards ON boards.id = events.board_id
      WHERE events.idempotency_key = ?
    `, [normalizedKey]);
    if (!row) {
      return null;
    }
    if (row.event_type !== eventType) {
      throw new Error(`idempotency key already used for ${row.event_type}`);
    }
    return eventFromRow(row);
  }

  private async appendEvent(input: {
    boardSlug: string;
    taskId?: string;
    runId?: string;
    eventType: string;
    actor?: BoardTaskActor;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    createdAt: string;
  }): Promise<number> {
    const board = await this.repository.queryOne<{ id: number }>("SELECT id FROM boards WHERE slug = ?", [input.boardSlug]);
    if (!board) {
      throw new Error(`board not found: ${input.boardSlug}`);
    }
    const eventActor = input.actor ? requireActor(input.actor, "board event actor") : undefined;
    const eventPayload = redactStructuredStrings(input.payload ?? {}) as Record<string, unknown>;
    const result = await this.repository.execute(`
      INSERT INTO events (
        board_id, task_id, run_id, event_type, actor_json, payload_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      board.id,
      input.taskId ?? null,
      input.runId ?? null,
      input.eventType,
      eventActor ? JSON.stringify(eventActor) : null,
      JSON.stringify(eventPayload),
      normalizeIdempotencyKey(input.idempotencyKey) ?? null,
      input.createdAt,
    ]);
    this.activeAuditProjections?.push({
      sequence: result.lastID,
      boardSlug: input.boardSlug,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      eventType: input.eventType,
      ...(eventActor ? { actor: eventActor } : {}),
      createdAt: input.createdAt,
    });
    return result.lastID;
  }

  private async mutateTaskWithEvent(
    id: string,
    eventType: string,
    options: BoardMutationOptions,
    mutate: (
      state: BoardStoreState,
      task: BoardTaskRecord,
      timestamp: string,
    ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>,
  ): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const timestamp = (options.now ?? new Date()).toISOString();
    return await this.enqueueWrite(async () => {
      const repeated = await this.findIdempotentEvent(options.idempotencyKey, eventType);
      const state = await this.store.read(defaultState());
      if (repeated) {
        if (repeated.taskId !== normalizedId) {
          throw new Error(`idempotency key already used for task ${repeated.taskId ?? "none"}`);
        }
        return cloneTask(findTask(state.tasks, normalizedId));
      }
      const task = findTask(state.tasks, normalizedId);
      requireExpectedRevision(task.revision, options.expectedRevision, `board task ${normalizedId}`);
      const payload = await mutate(state, task, timestamp) ?? {};
      task.revision += 1;
      task.updatedAt = timestamp;
      await this.store.write(state);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      const mutatedRunId = typeof payload.runId === "string" ? payload.runId : undefined;
      await this.appendEvent({
        boardSlug: task.boardSlug,
        taskId: task.id,
        ...(mutatedRunId || activeRun ? { runId: mutatedRunId ?? activeRun!.id } : {}),
        eventType,
        actor: options.actor,
        payload: { ...payload, revision: task.revision },
        idempotencyKey: options.idempotencyKey,
        createdAt: timestamp,
      });
      return cloneTask(task);
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.then(
      () => this.runWriteTransaction(operation),
      () => this.runWriteTransaction(operation),
    );
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async runWriteTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let projections: BoardAuditProjection[] = [];
    const result = await this.repository.transaction(async () => {
      if (this.activeAuditProjections) {
        throw new Error("nested Kanban write transaction is not supported");
      }
      this.activeAuditProjections = [];
      try {
        return await operation();
      } finally {
        projections = this.activeAuditProjections;
        this.activeAuditProjections = undefined;
      }
    });
    for (const projection of projections) {
      await appendAuditEvent(this.stateDir, {
        timestamp: projection.createdAt,
        type: "board.event",
        ...(projection.actor ? {
          chatId: projection.actor.chatId,
          userId: projection.actor.userId,
          conversationKey: projection.actor.conversationKey,
          ...(projection.actor.messageThreadId !== undefined
            ? { messageThreadId: projection.actor.messageThreadId }
            : {}),
        } : {}),
        outcome: "success",
        metadata: {
          sequence: projection.sequence,
          boardSlug: projection.boardSlug,
          eventType: projection.eventType,
          ...(projection.taskId ? { taskId: projection.taskId } : {}),
          ...(projection.runId ? { runId: projection.runId } : {}),
        },
      }).catch((error: unknown) => {
        console.warn(
          `Failed to project Kanban event ${projection.sequence} to the audit log:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    return result;
  }

  async diagnostics(): Promise<BoardDiagnostics> {
    return await this.repository.diagnostics();
  }
}

function requireBoardTaskId(id: string): string {
  const normalizedId = normalizeBoardTaskId(id);
  if (!normalizedId) {
    throw new Error(`invalid board task id: ${id}`);
  }
  return normalizedId;
}

function requireChecklistItemId(id: string): string {
  const normalizedId = normalizeChecklistItemId(id);
  if (!normalizedId) {
    throw new Error(`invalid board checklist item id: ${id}`);
  }
  return normalizedId;
}

function enforceWipLimits(state: BoardStoreState, task: BoardTaskRecord, limits: BoardWipLimits = state.limits): void {
  const runningTasks = state.tasks.filter((candidate) => {
    return candidate.status === "running" && candidate.boardSlug === task.boardSlug;
  });
  if (runningTasks.length >= limits.global) {
    throw new Error(`global WIP limit reached: ${limits.global}`);
  }
  if (task.assignee) {
    const assigneeRunning = runningTasks.filter((candidate) => candidate.assignee === task.assignee).length;
    if (assigneeRunning >= limits.perAssignee) {
      throw new Error(`assignee WIP limit reached for ${task.assignee}: ${limits.perAssignee}`);
    }
  }
  const conversationRunning = runningTasks.filter((candidate) => candidate.createdBy.conversationKey === task.createdBy.conversationKey).length;
  if (conversationRunning >= limits.perConversation) {
    throw new Error(`conversation WIP limit reached for ${task.createdBy.conversationKey}: ${limits.perConversation}`);
  }
}

function promoteDependents(state: BoardStoreState, completedTaskId: string, timestamp: string): string[] {
  const promotedTaskIds: string[] = [];
  for (const candidate of state.tasks) {
    if (candidate.status !== "todo") {
      continue;
    }
    if (!candidate.dependencies.includes(completedTaskId)) {
      continue;
    }
    if (!allDependenciesDone(state.tasks, candidate)) {
      continue;
    }
    if (!isScheduleDue(candidate, timestamp)) {
      continue;
    }
    candidate.status = "ready";
    candidate.updatedAt = timestamp;
    promotedTaskIds.push(candidate.id);
  }
  return promotedTaskIds;
}
