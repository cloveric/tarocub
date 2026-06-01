import { delegateToInstance as defaultDelegateToInstance } from "../bus/bus-client.js";
import { isPeerAllowed, loadBusConfig as defaultLoadBusConfig } from "../bus/bus-config.js";
import type {
  AdapterUsage,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import {
  BoardStore,
  normalizeBoardTaskId,
  type BoardTaskPriority,
  type BoardTaskRecord,
  type BoardTaskStatus,
  type BoardTaskWorkspace,
} from "../state/board-store.js";
import { MiniBusStore, type MiniBusPeerRecord } from "../state/mini-bus-store.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import { getNormalizedTelegramConversationKey } from "./conversation-key.js";
import type { ResumeState } from "./instance-config.js";
import type { Locale } from "./message-renderer.js";
import { parseBoardPlanOutput, renderBoardPlanPrompt } from "./board-plan.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type BoardAction =
  | { kind: "list"; status?: BoardTaskStatus }
  | { kind: "show"; id: string }
  | { kind: "add"; title: string }
  | { kind: "desc"; id: string; description: string }
  | { kind: "accept"; id: string; criterion: string }
  | { kind: "priority"; id: string; priority: BoardTaskPriority }
  | { kind: "labels"; id: string; labels: string[] }
  | { kind: "checkAdd"; id: string; text: string }
  | { kind: "checkDone"; id: string; checklistItemId: string; done: boolean }
  | { kind: "plan"; goal: string }
  | { kind: "assign"; id: string; assignee: string }
  | { kind: "dep"; id: string; dependencyId: string }
  | { kind: "limits"; key?: "global" | "perAssignee" | "perConversation"; value?: number }
  | { kind: "workspace"; id: string; workspace: { mode: BoardTaskWorkspace["mode"]; path?: string; branch?: string } }
  | { kind: "heartbeat"; id: string; note?: string }
  | { kind: "recover"; olderThanMinutes?: number }
  | { kind: "ready"; id: string }
  | { kind: "start"; id: string }
  | { kind: "run"; id: string }
  | { kind: "fail"; id: string; reason: string }
  | { kind: "runs"; id: string }
  | { kind: "block"; id: string; reason: string }
  | { kind: "unblock"; id: string }
  | { kind: "done"; id: string; summary?: string }
  | { kind: "review"; id: string; required: boolean; reviewer?: string }
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string; reason: string }
  | { kind: "usage" };

export interface BoardCommandContext extends TelegramTurnContext {
  abortSignal?: AbortSignal;
  cfg?: {
    budgetUsd?: number;
    resume?: ResumeState;
  };
  bridge?: {
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
      messageThreadId?: number;
      conversationKey?: string;
      locale: Locale;
      text: string;
      files: string[];
      workspaceOverride?: string;
      abortSignal?: AbortSignal;
      onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
      onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    }): Promise<{
      text: string;
      usage?: AdapterUsage;
    }>;
  };
  runQueuedBridgeTurn?<T>(conversationKey: string, job: () => Promise<T>): Promise<T>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  loadBusConfig?: typeof defaultLoadBusConfig;
  delegateToInstance?: typeof defaultDelegateToInstance;
}

const BOARD_STATUSES: BoardTaskStatus[] = ["todo", "ready", "running", "review", "blocked", "done", "archived"];
const BOARD_PRIORITIES: BoardTaskPriority[] = ["low", "normal", "high", "urgent"];

function splitFirstToken(value: string): { first: string; rest: string } | null {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  return match ? { first: match[1]!, rest: (match[2] ?? "").trim() } : null;
}

function parseBoardCommand(text: string): BoardAction | null {
  const match = text.trim().match(/^\/(?:board|kanban)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const body = (match[1] ?? "").trim();
  if (!body || body.toLowerCase() === "list" || body.toLowerCase() === "status") {
    return { kind: "list" };
  }

  const [rawAction = "", ...restParts] = body.split(/\s+/);
  const action = rawAction.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (action === "add" || action === "create" || action === "new") {
    return rest ? { kind: "add", title: rest } : { kind: "usage" };
  }
  if (action === "plan" || action === "decompose") {
    return rest ? { kind: "plan", goal: rest } : { kind: "usage" };
  }
  if (action === "desc" || action === "describe" || action === "description") {
    const descMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return descMatch ? { kind: "desc", id: descMatch[1]!, description: descMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "accept" || action === "criteria") {
    const acceptMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return acceptMatch ? { kind: "accept", id: acceptMatch[1]!, criterion: acceptMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "priority") {
    const priorityMatch = rest.match(/^(\S+)\s+(\S+)$/);
    if (!priorityMatch || !isBoardPriority(priorityMatch[2]!)) {
      return { kind: "usage" };
    }
    return { kind: "priority", id: priorityMatch[1]!, priority: priorityMatch[2]! };
  }
  if (action === "labels" || action === "label") {
    const labelsMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return labelsMatch
      ? { kind: "labels", id: labelsMatch[1]!, labels: labelsMatch[2]!.split(/\s+/).filter(Boolean) }
      : { kind: "usage" };
  }
  if (action === "check" || action === "checklist") {
    const checkMatch = rest.match(/^(\S+)\s+(add|done|todo)\s+([\s\S]+)$/i);
    if (!checkMatch) {
      return { kind: "usage" };
    }
    const checkAction = checkMatch[2]!.toLowerCase();
    if (checkAction === "add") {
      return { kind: "checkAdd", id: checkMatch[1]!, text: checkMatch[3]!.trim() };
    }
    return { kind: "checkDone", id: checkMatch[1]!, checklistItemId: checkMatch[3]!.trim(), done: checkAction === "done" };
  }
  if (action === "list") {
    if (!rest) {
      return { kind: "list" };
    }
    return isBoardStatus(rest) ? { kind: "list", status: rest } : { kind: "usage" };
  }
  if (action === "show" || action === "view") {
    return rest ? { kind: "show", id: rest } : { kind: "usage" };
  }
  if (action === "assign") {
    const assignMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return assignMatch ? { kind: "assign", id: assignMatch[1]!, assignee: assignMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "dep" || action === "depends" || action === "after") {
    const depMatch = rest.match(/^(\S+)\s+(\S+)$/);
    return depMatch ? { kind: "dep", id: depMatch[1]!, dependencyId: depMatch[2]! } : { kind: "usage" };
  }
  if (action === "limits" || action === "limit") {
    if (!rest) {
      return { kind: "limits" };
    }
    const limitMatch = rest.match(/^(global|assignee|perAssignee|conversation|perConversation)\s+(\d+)$/i);
    if (!limitMatch) {
      return { kind: "usage" };
    }
    const rawKey = limitMatch[1]!.toLowerCase();
    const key = rawKey === "global"
      ? "global"
      : rawKey === "assignee" || rawKey === "perassignee"
        ? "perAssignee"
        : "perConversation";
    return { kind: "limits", key, value: Number(limitMatch[2]) };
  }
  if (action === "workspace" || action === "worktree") {
    const idParts = splitFirstToken(rest);
    if (!idParts) {
      return { kind: "usage" };
    }
    const id = idParts.first;
    if (action === "worktree") {
      const worktreeParts = idParts.rest ? idParts.rest.split(/\s+/) : [];
      if (worktreeParts.length > 2) {
        return { kind: "usage" };
      }
      return {
        kind: "workspace",
        id,
        workspace: {
          mode: "worktree",
          ...(worktreeParts[0] ? { path: worktreeParts[0] } : {}),
          ...(worktreeParts[1] ? { branch: worktreeParts[1] } : {}),
        },
      };
    }
    const workspaceParts = splitFirstToken(idParts.rest);
    const mode = workspaceParts?.first;
    if (!mode || !isBoardWorkspaceMode(mode)) {
      return { kind: "usage" };
    }
    return {
      kind: "workspace",
      id,
      workspace: {
        mode,
        ...(workspaceParts.rest ? { path: workspaceParts.rest } : {}),
      },
    };
  }
  if (action === "heartbeat" || action === "ping") {
    const heartbeatMatch = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
    return heartbeatMatch ? { kind: "heartbeat", id: heartbeatMatch[1]!, note: heartbeatMatch[2]?.trim() } : { kind: "usage" };
  }
  if (action === "recover") {
    if (!rest) {
      return { kind: "recover" };
    }
    const minutes = Number(rest);
    return Number.isFinite(minutes) && minutes >= 0 ? { kind: "recover", olderThanMinutes: minutes } : { kind: "usage" };
  }
  if (action === "ready") {
    return rest ? { kind: "ready", id: rest } : { kind: "usage" };
  }
  if (action === "start") {
    return rest ? { kind: "start", id: rest } : { kind: "usage" };
  }
  if (action === "run") {
    return rest ? { kind: "run", id: rest } : { kind: "usage" };
  }
  if (action === "fail" || action === "failed") {
    const failMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return failMatch ? { kind: "fail", id: failMatch[1]!, reason: failMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "runs" || action === "history") {
    return rest ? { kind: "runs", id: rest } : { kind: "usage" };
  }
  if (action === "block") {
    const blockMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return blockMatch ? { kind: "block", id: blockMatch[1]!, reason: blockMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "unblock") {
    return rest ? { kind: "unblock", id: rest } : { kind: "usage" };
  }
  if (action === "done" || action === "finish" || action === "complete") {
    const doneMatch = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
    return doneMatch ? { kind: "done", id: doneMatch[1]!, summary: doneMatch[2]?.trim() } : { kind: "usage" };
  }
  if (action === "review") {
    const reviewMatch = rest.match(/^(\S+)\s+(on|off)(?:\s+(\S+))?$/i);
    return reviewMatch
      ? {
        kind: "review",
        id: reviewMatch[1]!,
        required: reviewMatch[2]!.toLowerCase() === "on",
        ...(reviewMatch[3] ? { reviewer: reviewMatch[3] } : {}),
      }
      : { kind: "usage" };
  }
  if (action === "approve") {
    return rest ? { kind: "approve", id: rest } : { kind: "usage" };
  }
  if (action === "reject") {
    const rejectMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return rejectMatch ? { kind: "reject", id: rejectMatch[1]!, reason: rejectMatch[2]!.trim() } : { kind: "usage" };
  }

  return { kind: "usage" };
}

function isBoardStatus(value: string): value is BoardTaskStatus {
  return (BOARD_STATUSES as string[]).includes(value);
}

function isBoardPriority(value: string): value is BoardTaskPriority {
  return (BOARD_PRIORITIES as string[]).includes(value);
}

function isBoardWorkspaceMode(value: string): value is BoardTaskWorkspace["mode"] {
  return value === "default" || value === "dir" || value === "worktree" || value === "scratch";
}

function renderBoardUsage(locale: Locale): string {
  return locale === "zh"
    ? "用法: /board [list|add|plan|desc|accept|priority|labels|check|assign|dep|limits|worktree|workspace|heartbeat|recover|review|approve|reject|ready|run|start|fail|runs|block|unblock|done]"
    : "Usage: /board [list|add|plan|desc|accept|priority|labels|check|assign|dep|limits|worktree|workspace|heartbeat|recover|review|approve|reject|ready|run|start|fail|runs|block|unblock|done]";
}

function renderNoBoardTasks(locale: Locale): string {
  return locale === "zh"
    ? "当前 Board 还没有任务。用 /board add <任务> 添加。"
    : "No board tasks yet. Use /board add <task> to add one.";
}

function renderTaskLine(task: BoardTaskRecord): string {
  const assignee = task.assignee ? ` @${task.assignee}` : "";
  const dependencies = task.dependencies.length > 0 ? ` deps:${task.dependencies.join(",")}` : "";
  return `[${task.status}] ${task.id} ${task.title}${assignee}${dependencies}`;
}

function renderTaskList(tasks: BoardTaskRecord[], locale: Locale): string {
  if (tasks.length === 0) {
    return renderNoBoardTasks(locale);
  }
  return tasks.map(renderTaskLine).join("\n");
}

function renderTaskDetail(task: BoardTaskRecord, locale: Locale): string {
  const lines = [
    `${task.id}: ${task.title}`,
    `status: ${task.status}`,
    `priority: ${task.priority}`,
    `assignee: ${task.assignee ?? "none"}`,
    `labels: ${task.labels.length > 0 ? task.labels.join(", ") : "none"}`,
    `review: ${task.review.required ? task.review.reviewer ?? "required" : "off"}`,
    `dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(", ") : "none"}`,
    task.workspace ? `workspace: ${task.workspace.mode}${task.workspace.path ? ` ${task.workspace.path}` : ""}${task.workspace.branch ? ` branch:${task.workspace.branch}` : ""}` : "workspace: default",
  ];
  if (task.description) {
    lines.push(`description: ${task.description}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    lines.push(`acceptance: ${task.acceptanceCriteria.join(" | ")}`);
  }
  if (task.checklist.length > 0) {
    lines.push(`checklist: ${task.checklist.map((item) => `${item.done ? "x" : " "}${item.id}:${item.text}`).join(" | ")}`);
  }
  if (task.blockedReason) {
    lines.push(`blocked: ${task.blockedReason}`);
  }
  if (task.summary) {
    lines.push(`summary: ${task.summary}`);
  }
  lines.push(`source: ${task.createdBy.conversationKey}`);
  if (locale === "zh") {
    return lines
      .join("\n")
      .replace("status:", "状态:")
      .replace("priority:", "优先级:")
      .replace("assignee:", "负责人:")
      .replace("labels:", "标签:")
      .replace("review:", "复核:")
      .replace("dependencies:", "依赖:")
      .replace("workspace:", "工作区:")
      .replace("description:", "描述:")
      .replace("acceptance:", "完成标准:")
      .replace("checklist:", "清单:")
      .replace("blocked:", "阻塞:")
      .replace("summary:", "总结:")
      .replace("source:", "来源:");
  }
  return lines.join("\n");
}

function renderBoardLimits(limits: { global: number; perAssignee: number; perConversation: number }): string {
  return `WIP limits: global=${limits.global}, perAssignee=${limits.perAssignee}, perConversation=${limits.perConversation}`;
}

function renderTaskRuns(task: BoardTaskRecord, locale: Locale): string {
  if (task.runs.length === 0) {
    return locale === "zh" ? `${task.id} 还没有 run。` : `${task.id} has no runs yet.`;
  }
  const lines = task.runs.map((run) => {
    const detail = run.error ?? run.summary ?? "";
    return `[${run.status}] ${run.id}${detail ? ` ${detail}` : ""}`;
  });
  return [`${task.id} runs:`, ...lines].join("\n");
}

function renderInvalidTaskId(locale: Locale): string {
  return locale === "zh" ? "任务 ID 无效，应类似 B1。" : "Invalid task id. Expected something like B1.";
}

function renderTaskNotFound(id: string, locale: Locale): string {
  return locale === "zh" ? `未找到任务 ${id}。` : `Task ${id} was not found.`;
}

function renderTaskCreated(task: BoardTaskRecord, locale: Locale): string {
  return locale === "zh"
    ? `已创建 ${task.id}: ${task.title}`
    : `Created ${task.id}: ${task.title}`;
}

function renderPlanCreated(tasks: BoardTaskRecord[], locale: Locale): string {
  const ids = tasks.map((task) => task.id).join(", ");
  const lines = tasks.map((task) => renderTaskLine(task));
  return locale === "zh"
    ? [`已创建计划: ${ids}`, ...lines].join("\n")
    : [`Created plan: ${ids}`, ...lines].join("\n");
}

function renderWorkspaceUpdated(task: BoardTaskRecord, locale: Locale): string {
  const workspace = task.workspace ?? { mode: "default" as const };
  const detail = [
    workspace.mode,
    workspace.path,
    workspace.branch ? `branch=${workspace.branch}` : undefined,
  ].filter(Boolean).join(" ");
  return locale === "zh"
    ? `工作区 ${task.id}: ${detail}`
    : `Workspace ${task.id}: ${detail}`;
}

function renderPromoted(promotedTaskIds: string[], locale: Locale): string | null {
  if (promotedTaskIds.length === 0) {
    return null;
  }
  return locale === "zh"
    ? `已推进: ${promotedTaskIds.join(", ")}`
    : `Promoted: ${promotedTaskIds.join(", ")}`;
}

function renderUnmetDependencies(id: string, dependencies: string[], locale: Locale): string {
  return locale === "zh"
    ? `${id} 还不能 ready，未完成依赖: ${dependencies.join(", ")}`
    : `${id} is not ready yet. Unmet dependencies: ${dependencies.join(", ")}`;
}

function renderBoardRunPrompt(task: BoardTaskRecord, locale: Locale): string {
  const lines = locale === "zh"
    ? [
        `你正在执行 Board 任务 ${task.id}。`,
        "",
        `标题：${task.title}`,
        task.description ? `描述：${task.description}` : null,
        `优先级：${task.priority}`,
        task.workspace ? `工作区：${task.workspace.mode}${task.workspace.path ? ` ${task.workspace.path}` : ""}` : null,
        task.labels.length > 0 ? `标签：${task.labels.join(", ")}` : null,
        task.acceptanceCriteria.length > 0
          ? ["完成标准：", ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`)].join("\n")
          : null,
        task.checklist.length > 0
          ? ["清单：", ...task.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.id} ${item.text}`)].join("\n")
          : null,
        "",
        "请完成这张卡，并返回结果摘要、关键改动、产物路径或阻塞原因。不要直接修改 Board 状态。",
      ]
    : [
        `You are executing Board task ${task.id}.`,
        "",
        `Title: ${task.title}`,
        task.description ? `Description: ${task.description}` : null,
        `Priority: ${task.priority}`,
        task.workspace ? `Workspace: ${task.workspace.mode}${task.workspace.path ? ` ${task.workspace.path}` : ""}` : null,
        task.labels.length > 0 ? `Labels: ${task.labels.join(", ")}` : null,
        task.acceptanceCriteria.length > 0
          ? ["Acceptance criteria:", ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`)].join("\n")
          : null,
        task.checklist.length > 0
          ? ["Checklist:", ...task.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.id} ${item.text}`)].join("\n")
          : null,
        "",
        "Complete this card and return a concise result summary, key changes, artifacts, or blockers. Do not update Board state directly.",
      ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function clipBoardRunSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 1800) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1800)}...`;
}

function renderBoardRunSucceeded(input: {
  task: BoardTaskRecord;
  targetKind: "mini" | "agent";
  targetName: string;
  promotedTaskIds: string[];
  locale: Locale;
}): string {
  const target = input.targetKind === "mini" ? `Mini Bus ${input.targetName}` : `Agent Bus ${input.targetName}`;
  const status = input.task.status === "review"
    ? (input.locale === "zh" ? "进入复核" : "moved to review")
    : (input.locale === "zh" ? "已完成" : "done");
  const summary = input.task.summary ? clipBoardRunSummary(input.task.summary) : "";
  const promotedText = renderPromoted(input.promotedTaskIds, input.locale);
  const header = input.locale === "zh"
    ? `已通过 ${target} 执行 ${input.task.id}，状态：${status}。`
    : `Ran ${input.task.id} via ${target}; status: ${status}.`;
  return [header, summary ? `\n${summary}` : null, promotedText].filter((line): line is string => line !== null).join("\n");
}

function renderBoardRunFailed(id: string, detail: string, locale: Locale): string {
  return locale === "zh"
    ? `执行失败 ${id}：${detail}`
    : `Run failed ${id}: ${detail}`;
}

function assertBoardRunReady(task: BoardTaskRecord): void {
  if (task.status !== "ready") {
    throw new Error(`board task ${task.id} must be ready before run (current: ${task.status})`);
  }
  if (!task.assignee) {
    throw new Error(`board task ${task.id} has no assignee`);
  }
}

async function runBoardTask(input: {
  stateDir: string;
  store: BoardStore;
  miniBusStore: Pick<MiniBusStore, "getPeer">;
  normalized: NormalizedTelegramMessage;
  context: BoardCommandContext;
  locale: Locale;
  id: string;
}): Promise<{
  task: BoardTaskRecord;
  targetKind: "mini" | "agent";
  targetName: string;
  promotedTaskIds: string[];
  usage?: AdapterUsage;
}> {
  const task = await input.store.getTask(input.id);
  if (!task) {
    const normalizedId = normalizeBoardTaskId(input.id);
    throw new Error(normalizedId ? `board task not found: ${normalizedId}` : `invalid board task id: ${input.id}`);
  }
  assertBoardRunReady(task);

  const assignee = task.assignee!;
  const currentConversationKey = getNormalizedTelegramConversationKey(input.normalized);
  const peer = await input.miniBusStore.getPeer(input.normalized.chatId, assignee);
  const targetKind: "mini" | "agent" = peer ? "mini" : "agent";
  if (peer?.conversationKey === currentConversationKey) {
    throw new Error(`board task ${task.id} cannot run on the current topic`);
  }
  if (!peer) {
    await assertAgentBusAssignee({
      stateDir: input.stateDir,
      taskId: task.id,
      assignee,
      context: input.context,
    });
  }

  const prompt = renderBoardRunPrompt(task, input.locale);
  const startedTask = await input.store.startReadyTask(task.id);
  const runId = startedTask.runs.at(-1)?.id;
  if (!runId) {
    throw new Error(`board task ${task.id} started without a run id`);
  }
  try {
    const result: { text: string; usage?: AdapterUsage } = peer
      ? await runMiniBoardTask({
          peer,
          task,
          prompt,
          locale: input.locale,
          normalized: input.normalized,
          context: input.context,
        })
      : await runAgentBoardTask({
          stateDir: input.stateDir,
          targetInstance: assignee,
          prompt,
          context: input.context,
        });
    const completion = await input.store.completeRunningRun(task.id, runId, result.text);
    if (!completion) {
      throw new Error(`board task ${task.id} run ${runId} is no longer running`);
    }
    return {
      task: completion.task,
      targetKind,
      targetName: assignee,
      promotedTaskIds: completion.promotedTaskIds,
      usage: result.usage,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await input.store.failRunningRun(task.id, runId, detail);
    throw error;
  }
}

async function assertAgentBusAssignee(input: {
  stateDir: string;
  taskId: string;
  assignee: string;
  context: BoardCommandContext;
}): Promise<void> {
  if (input.assignee === (input.context.instanceName ?? "default")) {
    throw new Error(`board task ${input.taskId} cannot be delegated to the current instance`);
  }
  const loadBusConfig = input.context.loadBusConfig ?? defaultLoadBusConfig;
  const busConfig = await loadBusConfig(input.stateDir);
  if (!busConfig || !isPeerAllowed(busConfig, input.assignee)) {
    throw new Error(`board task ${input.taskId} assignee ${input.assignee} is not a Mini Bus peer or allowed Agent Bus instance`);
  }
}

async function runMiniBoardTask(input: {
  peer: MiniBusPeerRecord;
  task: BoardTaskRecord;
  prompt: string;
  locale: Locale;
  normalized: NormalizedTelegramMessage;
  context: BoardCommandContext;
}): Promise<{ text: string; usage?: AdapterUsage }> {
  if (!input.context.bridge) {
    throw new Error("board run requires a bridge for Mini Bus assignees");
  }
  const run = input.context.runQueuedBridgeTurn ?? (async <T>(_conversationKey: string, job: () => Promise<T>) => await job());
  return await run(input.peer.conversationKey, async () => await input.context.bridge!.handleAuthorizedMessage({
    chatId: input.peer.chatId,
    userId: input.normalized.userId,
    chatType: "bus",
    ...(input.peer.messageThreadId !== undefined ? { messageThreadId: input.peer.messageThreadId } : {}),
    conversationKey: input.peer.conversationKey,
    locale: input.locale,
    text: input.prompt,
    files: [],
    workspaceOverride: input.task.workspace?.path ?? input.context.cfg?.resume?.workspacePath,
    abortSignal: input.context.abortSignal,
    onApprovalRequest: input.context.onApprovalRequest,
    onEngineEvent: input.context.onEngineEvent,
  }));
}

async function runAgentBoardTask(input: {
  stateDir: string;
  targetInstance: string;
  prompt: string;
  context: BoardCommandContext;
}): Promise<{ text: string }> {
  const delegateToInstance = input.context.delegateToInstance ?? defaultDelegateToInstance;
  const result = await delegateToInstance({
    fromInstance: input.context.instanceName ?? "default",
    targetInstance: input.targetInstance,
    prompt: input.prompt,
    depth: 0,
    stateDir: input.stateDir,
  });
  return { text: result.text };
}

async function replyAndAudit(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  normalized: NormalizedTelegramMessage;
  context: BoardCommandContext;
  text: string;
  outcome?: "success" | "reply" | "invalid" | "error";
  action?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await input.context.api.sendMessage(input.normalized.chatId, input.text);
  await appendUpdateHandleAuditEventBestEffort(input.stateDir, input.context, input.normalized, {
    outcome: input.outcome ?? "success",
    detail: input.text,
    metadata: {
      durationMs: Date.now() - input.startedAt,
      command: "board",
      ...(input.action ? { action: input.action } : {}),
      ...input.metadata,
    },
  });
}

export async function handleBoardTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  normalized: NormalizedTelegramMessage;
  context: BoardCommandContext;
  store?: BoardStore;
  miniBusStore?: Pick<MiniBusStore, "getPeer">;
}): Promise<boolean> {
  const action = parseBoardCommand(input.normalized.text);
  if (!action) {
    return false;
  }

  const { stateDir, startedAt, locale, normalized, context } = input;
  const store = input.store ?? new BoardStore(stateDir);
  const miniBusStore = input.miniBusStore ?? new MiniBusStore(stateDir);

  try {
    if (action.kind === "usage") {
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: renderBoardUsage(locale),
        outcome: "invalid",
      });
      return true;
    }

    if (action.kind === "list") {
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: renderTaskList(await store.listTasks(action.status), locale),
        action: "list",
        metadata: action.status ? { status: action.status } : undefined,
      });
      return true;
    }

    if (action.kind === "add") {
      const task = await store.createTask({
        title: action.title,
        createdBy: {
          chatId: normalized.chatId,
          userId: normalized.userId,
          ...(normalized.messageThreadId !== undefined ? { messageThreadId: normalized.messageThreadId } : {}),
          conversationKey: getNormalizedTelegramConversationKey(normalized),
        },
      });
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: renderTaskCreated(task, locale),
        action: "add",
        metadata: { boardTaskId: task.id },
      });
      return true;
    }

    if (action.kind === "plan") {
      if (!context.bridge) {
        await replyAndAudit({
          stateDir,
          startedAt,
          locale,
          normalized,
          context,
          text: locale === "zh" ? "Board plan 需要当前引擎来拆解任务。" : "Board plan requires the current engine to decompose tasks.",
          outcome: "invalid",
          action: "plan",
        });
        return true;
      }
      const result = await context.bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        ...(normalized.messageThreadId !== undefined ? { messageThreadId: normalized.messageThreadId } : {}),
        conversationKey: getNormalizedTelegramConversationKey(normalized),
        locale,
        text: renderBoardPlanPrompt(action.goal, locale),
        files: [],
        workspaceOverride: context.cfg?.resume?.workspacePath,
        abortSignal: context.abortSignal,
        onApprovalRequest: context.onApprovalRequest,
        onEngineEvent: context.onEngineEvent,
      });
      const planned = await store.createPlan({
        createdBy: {
          chatId: normalized.chatId,
          userId: normalized.userId,
          ...(normalized.messageThreadId !== undefined ? { messageThreadId: normalized.messageThreadId } : {}),
          conversationKey: getNormalizedTelegramConversationKey(normalized),
        },
        tasks: parseBoardPlanOutput(result.text),
      });
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: renderPlanCreated(planned.tasks, locale),
        action: "plan",
        metadata: { boardTaskIds: planned.tasks.map((task) => task.id) },
      });
      return true;
    }

    if (action.kind === "desc") {
      const task = await store.updateTaskCard(action.id, { description: action.description });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Updated ${task.id} description`, action: "desc", metadata: { boardTaskId: task.id } });
      return true;
    }

    if (action.kind === "accept") {
      const task = await store.getTask(action.id);
      const updated = await store.updateTaskCard(action.id, {
        acceptanceCriteria: [...(task?.acceptanceCriteria ?? []), action.criterion],
      });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Updated ${updated.id} acceptance criteria`, action: "accept", metadata: { boardTaskId: updated.id } });
      return true;
    }

    if (action.kind === "priority") {
      const task = await store.updateTaskCard(action.id, { priority: action.priority });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Set ${task.id} priority to ${task.priority}`, action: "priority", metadata: { boardTaskId: task.id, priority: task.priority } });
      return true;
    }

    if (action.kind === "labels") {
      const task = await store.updateTaskCard(action.id, { labels: action.labels });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Updated ${task.id} labels: ${task.labels.join(", ") || "none"}`, action: "labels", metadata: { boardTaskId: task.id, labels: task.labels } });
      return true;
    }

    if (action.kind === "checkAdd") {
      const task = await store.getTask(action.id);
      const updated = await store.updateTaskCard(action.id, {
        checklist: [...(task?.checklist.map((item) => item.text) ?? []), action.text],
      });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Added checklist item to ${updated.id}`, action: "check-add", metadata: { boardTaskId: updated.id } });
      return true;
    }

    if (action.kind === "checkDone") {
      const task = await store.setChecklistItemDone(action.id, action.checklistItemId, action.done);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Updated ${task.id} checklist ${action.checklistItemId}`, action: "check", metadata: { boardTaskId: task.id, checklistItemId: action.checklistItemId, done: action.done } });
      return true;
    }

    if (action.kind === "show") {
      const id = normalizeBoardTaskId(action.id);
      if (!id) {
        await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: renderInvalidTaskId(locale), outcome: "invalid", action: "show" });
        return true;
      }
      const task = await store.getTask(id);
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: task ? renderTaskDetail(task, locale) : renderTaskNotFound(id, locale),
        outcome: task ? "success" : "invalid",
        action: "show",
        metadata: { boardTaskId: id },
      });
      return true;
    }

    if (action.kind === "assign") {
      const task = await store.assignTask(action.id, action.assignee);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Assigned ${task.id} to ${task.assignee}`, action: "assign", metadata: { boardTaskId: task.id, assignee: task.assignee } });
      return true;
    }

    if (action.kind === "dep") {
      const task = await store.addDependency(action.id, action.dependencyId);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `${task.id} depends on ${task.dependencies.join(", ")}`, action: "dep", metadata: { boardTaskId: task.id, dependencies: task.dependencies } });
      return true;
    }

    if (action.kind === "limits") {
      if (action.key && action.value !== undefined && action.value <= 0) {
        const text = locale === "zh"
          ? "WIP limit 必须是正整数。"
          : "WIP limit must be a positive integer.";
        await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text, outcome: "invalid", action: "limits", metadata: { key: action.key, value: action.value } });
        return true;
      }
      const limits = action.key && action.value !== undefined
        ? await store.setLimits({ [action.key]: action.value })
        : await store.getLimits();
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: renderBoardLimits(limits), action: "limits", metadata: { limits } });
      return true;
    }

    if (action.kind === "workspace") {
      const task = await store.setTaskWorkspace(action.id, action.workspace);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: renderWorkspaceUpdated(task, locale), action: "workspace", metadata: { boardTaskId: task.id, workspace: task.workspace } });
      return true;
    }

    if (action.kind === "heartbeat") {
      const task = await store.heartbeatTask(action.id, action.note);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: locale === "zh" ? `已记录 ${task.id} heartbeat` : `Heartbeat ${task.id}`, action: "heartbeat", metadata: { boardTaskId: task.id } });
      return true;
    }

    if (action.kind === "recover") {
      const olderThanMinutes = action.olderThanMinutes ?? 15;
      const recovered = await store.recoverStaleRuns({ olderThanMs: olderThanMinutes * 60 * 1000 });
      const text = recovered.length > 0
        ? (locale === "zh" ? `已恢复卡住的 Board run: ${recovered.map((task) => task.id).join(", ")}` : `Recovered stale board runs: ${recovered.map((task) => task.id).join(", ")}`)
        : (locale === "zh" ? "没有发现卡住的 Board run。" : "No stale board runs found.");
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text, action: "recover", metadata: { boardTaskIds: recovered.map((task) => task.id), olderThanMinutes } });
      return true;
    }

    if (action.kind === "ready") {
      const result = await store.markReady(action.id);
      const text = result.unmetDependencies.length > 0
        ? renderUnmetDependencies(result.task.id, result.unmetDependencies, locale)
        : `Ready ${result.task.id}`;
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text, outcome: result.unmetDependencies.length > 0 ? "reply" : "success", action: "ready", metadata: { boardTaskId: result.task.id, unmetDependencies: result.unmetDependencies } });
      return true;
    }

    if (action.kind === "start") {
      const task = await store.startTask(action.id);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Started ${task.id}`, action: "start", metadata: { boardTaskId: task.id, runId: task.runs.at(-1)?.id } });
      return true;
    }

    if (action.kind === "run") {
      if (await maybeReplyWithBudgetExhausted(stateDir, context.cfg?.budgetUsd, locale, context, normalized)) {
        return true;
      }
      try {
        const result = await runBoardTask({
          stateDir,
          store,
          miniBusStore,
          normalized,
          context,
          locale,
          id: action.id,
        });
        if (result.usage) {
          await recordTurnUsageAndBudgetAudit(stateDir, context.cfg?.budgetUsd, context, normalized, result.usage);
        }
        await replyAndAudit({
          stateDir,
          startedAt,
          locale,
          normalized,
          context,
          text: renderBoardRunSucceeded({
            task: result.task,
            targetKind: result.targetKind,
            targetName: result.targetName,
            promotedTaskIds: result.promotedTaskIds,
            locale,
          }),
          action: "run",
          metadata: {
            boardTaskId: result.task.id,
            runId: result.task.runs.at(-1)?.id,
            targetKind: result.targetKind,
            targetName: result.targetName,
            promotedTaskIds: result.promotedTaskIds,
          },
        });
      } catch (error) {
        const id = normalizeBoardTaskId(action.id) ?? action.id;
        const detail = error instanceof Error ? error.message : String(error);
        await replyAndAudit({
          stateDir,
          startedAt,
          locale,
          normalized,
          context,
          text: renderBoardRunFailed(id, detail, locale),
          outcome: "error",
          action: "run",
          metadata: { boardTaskId: id },
        });
      }
      return true;
    }

    if (action.kind === "fail") {
      const task = await store.failTask(action.id, action.reason);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Failed ${task.id}: ${task.blockedReason}`, action: "fail", metadata: { boardTaskId: task.id, runId: task.runs.at(-1)?.id } });
      return true;
    }

    if (action.kind === "runs") {
      const id = normalizeBoardTaskId(action.id);
      if (!id) {
        await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: renderInvalidTaskId(locale), outcome: "invalid", action: "runs" });
        return true;
      }
      const task = await store.getTask(id);
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: task ? renderTaskRuns(task, locale) : renderTaskNotFound(id, locale),
        outcome: task ? "success" : "invalid",
        action: "runs",
        metadata: { boardTaskId: id },
      });
      return true;
    }

    if (action.kind === "block") {
      const task = await store.blockTask(action.id, action.reason);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Blocked ${task.id}: ${task.blockedReason}`, action: "block", metadata: { boardTaskId: task.id } });
      return true;
    }

    if (action.kind === "review") {
      const task = await store.setReviewGate(action.id, {
        required: action.required,
        ...(action.reviewer ? { reviewer: action.reviewer } : {}),
      });
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Review ${task.id}: ${task.review.required ? task.review.reviewer ?? "on" : "off"}`, action: "review", metadata: { boardTaskId: task.id, review: task.review } });
      return true;
    }

    if (action.kind === "approve") {
      const result = await store.approveTask(action.id);
      const promotedText = renderPromoted(result.promotedTaskIds, locale);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: [`Approved ${result.task.id}`, promotedText].filter(Boolean).join("\n"), action: "approve", metadata: { boardTaskId: result.task.id, promotedTaskIds: result.promotedTaskIds } });
      return true;
    }

    if (action.kind === "reject") {
      const task = await store.rejectTask(action.id, action.reason);
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text: `Rejected ${task.id}: ${task.blockedReason}`, action: "reject", metadata: { boardTaskId: task.id } });
      return true;
    }

    if (action.kind === "unblock") {
      const result = await store.unblockTask(action.id);
      const text = result.unmetDependencies.length > 0
        ? `${result.task.id} unblocked; waiting on ${result.unmetDependencies.join(", ")}`
        : `Unblocked ${result.task.id}; ready`;
      await replyAndAudit({ stateDir, startedAt, locale, normalized, context, text, action: "unblock", metadata: { boardTaskId: result.task.id, unmetDependencies: result.unmetDependencies } });
      return true;
    }

    if (action.kind === "done") {
      const result = await store.completeTask(action.id, action.summary);
      const promotedText = renderPromoted(result.promotedTaskIds, locale);
      await replyAndAudit({
        stateDir,
        startedAt,
        locale,
        normalized,
        context,
        text: [locale === "zh" ? `已完成 ${result.task.id}` : `Done ${result.task.id}`, promotedText].filter(Boolean).join("\n"),
        action: "done",
        metadata: { boardTaskId: result.task.id, promotedTaskIds: result.promotedTaskIds },
      });
      return true;
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await replyAndAudit({
      stateDir,
      startedAt,
      locale,
      normalized,
      context,
      text: locale === "zh" ? `Board 错误：${detail}` : `Board error: ${detail}`,
      outcome: "error",
      action: action.kind,
    });
    return true;
  }
}
