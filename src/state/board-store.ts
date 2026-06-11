import path from "node:path";

import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import {
  BoardStoreStateSchema,
  type BoardArtifact,
  type BoardChecklistItem,
  type BoardStoreState,
  type BoardTaskActor,
  type BoardTaskPriority,
  type BoardTaskRecord,
  type BoardTaskRun,
  type BoardTaskStatus,
  type BoardTaskWorkspace,
  type BoardWipLimits,
} from "./board-store-schema.js";

export type {
  BoardStoreState,
  BoardArtifact,
  BoardChecklistItem,
  BoardTaskActor,
  BoardTaskPriority,
  BoardTaskRecord,
  BoardTaskRun,
  BoardTaskStatus,
  BoardTaskWorkspace,
  BoardWipLimits,
} from "./board-store-schema.js";

export type BoardTaskInput = {
  title: string;
  createdBy: BoardTaskActor;
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

export type BoardTaskWorkspaceInput = {
  mode: BoardTaskWorkspace["mode"];
  path?: string;
  branch?: string;
};

export type BoardPlanTaskInput = BoardTaskCardUpdate & {
  key: string;
  title: string;
  assignee?: string;
  dependsOn?: string[];
  review?: {
    required: boolean;
    reviewer?: string;
  };
};

export type BoardPlanInput = {
  createdBy: BoardTaskActor;
  tasks: BoardPlanTaskInput[];
};

const BOARD_TASK_ID_PATTERN = /^B\d+$/i;
const BOARD_CHECKLIST_ID_PATTERN = /^C\d+$/i;
const MAX_BOARD_SUMMARY_CHARS = 4000;
const MAX_BOARD_PLAN_TASKS = 50;
const DEFAULT_WIP_LIMITS: BoardWipLimits = {
  global: 3,
  perAssignee: 1,
  perConversation: 1,
};

export function resolveBoardStorePath(stateDir: string): string {
  return path.join(stateDir, "board.json");
}

export function normalizeBoardTaskId(id: string): string | null {
  const normalized = id.trim().toUpperCase();
  return BOARD_TASK_ID_PATTERN.test(normalized) ? normalized : null;
}

function nowIso(): string {
  return new Date().toISOString();
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
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeArtifacts(values: Array<Pick<BoardArtifact, "kind" | "value">> | undefined, timestamp: string): BoardArtifact[] {
  return (values ?? [])
    .map((artifact) => ({
      kind: artifact.kind.trim(),
      value: artifact.value.trim(),
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
        const text = value.trim();
        return text
          ? {
            id: `C${index + 1}`,
            text,
            done: false,
            createdAt: timestamp,
          }
          : null;
      }
      const text = value.text.trim();
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

function normalizeBoardSummary(summary: string | undefined): string | undefined {
  const trimmed = summary?.trim();
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
    title: task.title.trim(),
    acceptanceCriteria: normalizeStringList(task.acceptanceCriteria),
    priority: task.priority ?? "normal",
    labels: normalizeStringList(task.labels),
    checklist: normalizeChecklist(task.checklist, [], task.createdAt),
    artifacts: (task.artifacts ?? []).map((artifact) => ({ ...artifact })),
    review: {
      required: Boolean(task.review?.required),
      ...(task.review?.reviewer ? { reviewer: task.review.reviewer } : {}),
    },
    dependencies: [...new Set((task.dependencies ?? []).map((id) => normalizeBoardTaskId(id) ?? id))],
    runs: task.runs ?? [],
    ...(workspace ? { workspace } : {}),
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

function parseBoardStoreState(value: unknown): BoardStoreState {
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
  return {
    ...task,
    dependencies: [...task.dependencies],
    runs: task.runs.map((run) => ({ ...run })),
    acceptanceCriteria: [...task.acceptanceCriteria],
    labels: [...task.labels],
    checklist: task.checklist.map((item) => ({ ...item })),
    artifacts: task.artifacts.map((artifact) => ({ ...artifact })),
    review: { ...task.review },
    createdBy: { ...task.createdBy },
    ...(task.workspace ? { workspace: { ...task.workspace } } : {}),
  };
}

function allDependenciesDone(tasks: BoardTaskRecord[], task: BoardTaskRecord): boolean {
  return task.dependencies.every((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId)?.status === "done");
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

function findTask(tasks: BoardTaskRecord[], id: string): BoardTaskRecord {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw new Error(`board task not found: ${id}`);
  }
  return task;
}

export class BoardStore {
  private readonly store: JsonStore<BoardStoreState>;
  private readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = resolveBoardStorePath(stateDir);
    this.store = new JsonStore(this.filePath, parseBoardStoreState);
  }

  async listTasks(status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    const state = await this.store.read(defaultState());
    return state.tasks
      .filter((task) => status === undefined || task.status === status)
      .map(cloneTask);
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

  async createTask(input: BoardTaskInput): Promise<BoardTaskRecord> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("board task title is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const timestamp = nowIso();
      const task: BoardTaskRecord = {
        id: `B${state.nextTaskId}`,
        title,
        status: "todo",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
        priority: input.priority ?? "normal",
        labels: normalizeStringList(input.labels),
        checklist: normalizeChecklist(input.checklist, [], timestamp),
        artifacts: normalizeArtifacts(input.artifacts, timestamp),
        review: {
          required: Boolean(input.review?.required),
          ...(input.review?.reviewer ? { reviewer: input.review.reviewer.trim() } : {}),
        },
        ...(input.assignee?.trim() ? { assignee: input.assignee.trim() } : {}),
        dependencies: [],
        runs: [],
        createdBy: input.createdBy,
      };
      state.nextTaskId += 1;
      state.tasks.push(task);
      await this.store.write(state);
      return cloneTask(task);
    });
  }

  async updateTaskCard(id: string, update: BoardTaskCardUpdate): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    return await this.updateTask(normalizedId, (_state, task) => {
      const timestamp = nowIso();
      if (update.description !== undefined) {
        const description = update.description.trim();
        if (description) {
          task.description = description;
        } else {
          delete task.description;
        }
      }
      if (update.acceptanceCriteria !== undefined) {
        task.acceptanceCriteria = normalizeStringList(update.acceptanceCriteria);
      }
      if (update.priority !== undefined) {
        task.priority = update.priority;
      }
      if (update.labels !== undefined) {
        task.labels = normalizeStringList(update.labels);
      }
      if (update.checklist !== undefined) {
        task.checklist = normalizeChecklist(update.checklist, task.checklist, timestamp);
      }
      if (update.artifacts !== undefined) {
        task.artifacts = normalizeArtifacts(update.artifacts, timestamp);
      }
      task.updatedAt = timestamp;
      return task;
    });
  }

  async setChecklistItemDone(id: string, checklistItemId: string, done: boolean): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedChecklistItemId = requireChecklistItemId(checklistItemId);
    return await this.updateTask(normalizedId, (_state, task) => {
      const item = task.checklist.find((candidate) => candidate.id === normalizedChecklistItemId);
      if (!item) {
        throw new Error(`board checklist item not found: ${normalizedChecklistItemId}`);
      }
      item.done = done;
      if (done) {
        item.completedAt = nowIso();
      } else {
        delete item.completedAt;
      }
      task.updatedAt = nowIso();
      return task;
    });
  }

  async getLimits(): Promise<BoardWipLimits> {
    const state = await this.store.read(defaultState());
    return { ...state.limits };
  }

  async setLimits(limits: Partial<BoardWipLimits>): Promise<BoardWipLimits> {
    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      state.limits = normalizeLimits({
        ...state.limits,
        ...limits,
      });
      await this.store.write(state);
      return { ...state.limits };
    });
  }

  async createPlan(input: BoardPlanInput): Promise<{ tasks: BoardTaskRecord[] }> {
    if (input.tasks.length === 0) {
      throw new Error("board plan requires at least one task");
    }
    if (input.tasks.length > MAX_BOARD_PLAN_TASKS) {
      throw new Error(`board plan can create at most ${MAX_BOARD_PLAN_TASKS} tasks`);
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const timestamp = nowIso();
      const keyToId = new Map<string, string>();
      const created: BoardTaskRecord[] = [];
      for (const planTask of input.tasks) {
        const key = planTask.key.trim();
        const title = planTask.title.trim();
        if (!key || !title) {
          throw new Error("board plan task requires key and title");
        }
        if (keyToId.has(key)) {
          throw new Error(`duplicate board plan key: ${key}`);
        }
        const task: BoardTaskRecord = {
          id: `B${state.nextTaskId}`,
          title,
          status: "todo",
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(planTask.description?.trim() ? { description: planTask.description.trim() } : {}),
          acceptanceCriteria: normalizeStringList(planTask.acceptanceCriteria),
          priority: planTask.priority ?? "normal",
          labels: normalizeStringList(planTask.labels),
          checklist: normalizeChecklist(planTask.checklist, [], timestamp),
          artifacts: normalizeArtifacts(planTask.artifacts, timestamp),
          review: {
            required: Boolean(planTask.review?.required),
            ...(planTask.review?.reviewer ? { reviewer: planTask.review.reviewer.trim() } : {}),
          },
          ...(planTask.assignee?.trim() ? { assignee: planTask.assignee.trim() } : {}),
          dependencies: [],
          runs: [],
          createdBy: input.createdBy,
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
      const cycle = findDependencyCycle(created);
      if (cycle) {
        throw new Error(`board dependency cycle rejected: ${cycle.join(" -> ")}`);
      }
      await this.store.write(state);
      return { tasks: created.map(cloneTask) };
    });
  }

  async setTaskWorkspace(id: string, workspace: BoardTaskWorkspaceInput): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedWorkspace = normalizeWorkspace(workspace as BoardTaskWorkspace, { requireAbsolutePath: true });
    if (!normalizedWorkspace || normalizedWorkspace.mode === "default") {
      return await this.updateTask(normalizedId, (_state, task) => {
        delete task.workspace;
        task.updatedAt = nowIso();
        return task;
      });
    }
    return await this.updateTask(normalizedId, (_state, task) => {
      task.workspace = normalizedWorkspace;
      task.updatedAt = nowIso();
      return task;
    });
  }

  async heartbeatTask(id: string, note?: string, now: Date = new Date()): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    return await this.updateTask(normalizedId, (_state, task) => {
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      const timestamp = now.toISOString();
      activeRun.lastHeartbeatAt = timestamp;
      const normalizedNote = note?.trim();
      if (normalizedNote) {
        activeRun.heartbeatNote = normalizedNote;
      } else {
        delete activeRun.heartbeatNote;
      }
      task.updatedAt = timestamp;
      return task;
    });
  }

  async recoverStaleRuns(input: {
    olderThanMs: number;
    now?: Date;
    reason?: string;
  }): Promise<BoardTaskRecord[]> {
    const olderThanMs = Math.max(0, Math.trunc(input.olderThanMs));
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const timestamp = now.toISOString();
    const reason = input.reason?.trim() || `stale board run recovered after ${Math.round(olderThanMs / 60_000)}m without heartbeat`;

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const recovered: BoardTaskRecord[] = [];
      for (const task of state.tasks) {
        if (task.status !== "running") {
          continue;
        }
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
        task.updatedAt = timestamp;
        recovered.push(cloneTask(task));
      }
      if (recovered.length > 0) {
        await this.store.write(state);
      }
      return recovered;
    });
  }

  async assignTask(id: string, assignee: string): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedAssignee = assignee.trim();
    if (!normalizedAssignee) {
      throw new Error("board task assignee is required");
    }

    return await this.updateTask(normalizedId, (state, task) => {
      task.assignee = normalizedAssignee;
      task.updatedAt = nowIso();
      return task;
    });
  }

  async addDependency(id: string, dependencyId: string): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedDependencyId = requireBoardTaskId(dependencyId);
    if (normalizedId === normalizedDependencyId) {
      throw new Error("board task cannot depend on itself");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      findTask(state.tasks, normalizedDependencyId);
      if (wouldCreateDependencyCycle(state.tasks, normalizedId, normalizedDependencyId)) {
        throw new Error(`board dependency cycle rejected: ${normalizedId} -> ${normalizedDependencyId}`);
      }
      task.dependencies = [...new Set([...task.dependencies, normalizedDependencyId])];
      if (task.status === "ready" && !allDependenciesDone(state.tasks, task)) {
        task.status = "todo";
      }
      task.updatedAt = nowIso();
      await this.store.write(state);
      return cloneTask(task);
    });
  }

  async markReady(id: string): Promise<BoardReadyResult> {
    const normalizedId = requireBoardTaskId(id);

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (task.status !== "todo" && task.status !== "ready") {
        throw new Error(`board task ${normalizedId} cannot be marked ready from ${task.status}`);
      }
      if (unmetDependencies.length === 0 && task.status === "todo") {
        task.status = "ready";
        task.updatedAt = nowIso();
        await this.store.write(state);
      }
      return {
        task: cloneTask(task),
        unmetDependencies,
      };
    });
  }

  async startTask(id: string): Promise<BoardTaskRecord> {
    return await this.startTaskWithRequiredStatus(id);
  }

  async startReadyTask(id: string): Promise<BoardTaskRecord> {
    return await this.startTaskWithRequiredStatus(id, "ready");
  }

  private async startTaskWithRequiredStatus(id: string, requiredStatus?: BoardTaskStatus): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (requiredStatus && task.status !== requiredStatus) {
        throw new Error(`board task ${normalizedId} must be ${requiredStatus} before starting (current: ${task.status})`);
      }
      if (task.runs.some((run) => run.status === "running")) {
        throw new Error(`board task ${normalizedId} already running`);
      }
      if (!requiredStatus && task.status !== "todo" && task.status !== "ready") {
        throw new Error(`board task ${normalizedId} cannot be started from ${task.status}`);
      }
      enforceWipLimits(state, task);
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      if (unmetDependencies.length > 0) {
        throw new Error(`board task ${normalizedId} has unmet dependencies: ${unmetDependencies.join(", ")}`);
      }
      const timestamp = nowIso();
      const run: BoardTaskRun = {
        id: `R${state.nextRunId}`,
        status: "running",
        startedAt: timestamp,
      };
      state.nextRunId += 1;
      task.runs.push(run);
      task.status = "running";
      task.updatedAt = timestamp;
      await this.store.write(state);
      return cloneTask(task);
    });
  }

  async failTask(id: string, error: string): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedError = error.trim();
    if (!normalizedError) {
      throw new Error("board failure reason is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun) {
        throw new Error(`board task ${normalizedId} has no running run`);
      }
      const timestamp = nowIso();
      activeRun.status = "failed";
      activeRun.completedAt = timestamp;
      activeRun.error = normalizedError;
      task.status = "blocked";
      task.blockedReason = normalizedError;
      task.updatedAt = timestamp;
      await this.store.write(state);
      return cloneTask(task);
    });
  }

  async failRunningRun(id: string, runId: string, error: string): Promise<BoardTaskRecord | null> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedRunId = runId.trim();
    const normalizedError = error.trim();
    if (!normalizedRunId) {
      throw new Error("board run id is required");
    }
    if (!normalizedError) {
      throw new Error("board failure reason is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun || activeRun.id !== normalizedRunId) {
        return null;
      }
      const timestamp = nowIso();
      activeRun.status = "failed";
      activeRun.completedAt = timestamp;
      activeRun.error = normalizedError;
      task.status = "blocked";
      task.blockedReason = normalizedError;
      task.updatedAt = timestamp;
      await this.store.write(state);
      return cloneTask(task);
    });
  }

  async blockTask(id: string, reason: string): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new Error("board block reason is required");
    }

    return await this.updateTask(normalizedId, (_state, task) => {
      task.status = "blocked";
      task.blockedReason = normalizedReason;
      task.updatedAt = nowIso();
      return task;
    });
  }

  async unblockTask(id: string): Promise<BoardReadyResult> {
    const normalizedId = requireBoardTaskId(id);

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      delete task.blockedReason;
      const unmetDependencies = task.dependencies.filter((dependencyId) => {
        return state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done";
      });
      task.status = unmetDependencies.length === 0 ? "ready" : "todo";
      task.updatedAt = nowIso();
      await this.store.write(state);
      return {
        task: cloneTask(task),
        unmetDependencies,
      };
    });
  }

  async completeTask(id: string, summary?: string): Promise<BoardCompletionResult> {
    const normalizedId = requireBoardTaskId(id);

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const timestamp = nowIso();
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
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (activeRun) {
        activeRun.status = "done";
        activeRun.completedAt = timestamp;
        if (task.summary) {
          activeRun.summary = task.summary;
        }
      }

      const promotedTaskIds = shouldReview ? [] : promoteDependents(state, normalizedId, timestamp);

      await this.store.write(state);
      return {
        task: cloneTask(task),
        promotedTaskIds,
      };
    });
  }

  async completeRunningRun(id: string, runId: string, summary?: string): Promise<BoardCompletionResult | null> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error("board run id is required");
    }

    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      const activeRun = [...task.runs].reverse().find((run) => run.status === "running");
      if (!activeRun || activeRun.id !== normalizedRunId || task.status !== "running") {
        return null;
      }

      const timestamp = nowIso();
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
      activeRun.status = "done";
      activeRun.completedAt = timestamp;
      if (task.summary) {
        activeRun.summary = task.summary;
      }

      const promotedTaskIds = shouldReview ? [] : promoteDependents(state, normalizedId, timestamp);

      await this.store.write(state);
      return {
        task: cloneTask(task),
        promotedTaskIds,
      };
    });
  }

  async setReviewGate(id: string, review: { required: boolean; reviewer?: string }): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    return await this.updateTask(normalizedId, (_state, task) => {
      task.review = {
        required: review.required,
        ...(review.reviewer?.trim() ? { reviewer: review.reviewer.trim() } : {}),
      };
      task.updatedAt = nowIso();
      return task;
    });
  }

  async approveTask(id: string): Promise<BoardCompletionResult> {
    const normalizedId = requireBoardTaskId(id);
    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, normalizedId);
      if (task.status !== "review") {
        throw new Error(`board task ${normalizedId} is not in review`);
      }
      const timestamp = nowIso();
      task.status = "done";
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
      const promotedTaskIds = promoteDependents(state, normalizedId, timestamp);
      await this.store.write(state);
      return {
        task: cloneTask(task),
        promotedTaskIds,
      };
    });
  }

  async rejectTask(id: string, reason: string): Promise<BoardTaskRecord> {
    const normalizedId = requireBoardTaskId(id);
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new Error("board review rejection reason is required");
    }
    return await this.updateTask(normalizedId, (_state, task) => {
      if (task.status !== "review") {
        throw new Error(`board task ${normalizedId} is not in review`);
      }
      task.status = "blocked";
      task.blockedReason = normalizedReason;
      task.updatedAt = nowIso();
      return task;
    });
  }

  private async updateTask(id: string, mutate: (state: BoardStoreState, task: BoardTaskRecord) => BoardTaskRecord): Promise<BoardTaskRecord> {
    return await this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const task = findTask(state.tasks, id);
      const updated = mutate(state, task);
      await this.store.write(state);
      return cloneTask(updated);
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.then(
      () => withFileMutex(this.filePath, operation),
      () => withFileMutex(this.filePath, operation),
    );
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
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

function enforceWipLimits(state: BoardStoreState, task: BoardTaskRecord): void {
  const runningTasks = state.tasks.filter((candidate) => candidate.status === "running");
  if (runningTasks.length >= state.limits.global) {
    throw new Error(`global WIP limit reached: ${state.limits.global}`);
  }
  if (task.assignee) {
    const assigneeRunning = runningTasks.filter((candidate) => candidate.assignee === task.assignee).length;
    if (assigneeRunning >= state.limits.perAssignee) {
      throw new Error(`assignee WIP limit reached for ${task.assignee}: ${state.limits.perAssignee}`);
    }
  }
  const conversationRunning = runningTasks.filter((candidate) => candidate.createdBy.conversationKey === task.createdBy.conversationKey).length;
  if (conversationRunning >= state.limits.perConversation) {
    throw new Error(`conversation WIP limit reached for ${task.createdBy.conversationKey}: ${state.limits.perConversation}`);
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
    candidate.status = "ready";
    candidate.updatedAt = timestamp;
    promotedTaskIds.push(candidate.id);
  }
  return promotedTaskIds;
}
