import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexThreadGoal,
  CodexThreadGoalResponse,
  CodexUserMessageInput,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "./adapter.js";
import { appendUniqueSendImageTag, extractGeneratedImagePath, sendImageTag } from "./generated-files.js";
import { killProcessTree } from "./process-tree.js";
import { readValidatedConfigFile } from "../telegram/instance-config.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end?(callback?: () => void): void;
};

type AppServerChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

export type AppServerSpawnCodex = (command: string, args: string[], options: SpawnOptions) => AppServerChildProcess;
const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_PROTOCOL_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 4_000;
export const CODEX_APP_SERVER_TURN_TIMEOUT_MS = 60 * 60_000;
export const CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;
export const CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS = 180_000;
export const CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const CODEX_APP_SERVER_TURN_INTERRUPT_TIMEOUT_MS = 5_000;
export const CODEX_APP_SERVER_TURN_STEER_TIMEOUT_MS = 5_000;
export const CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS = 60_000;
type AppServerApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

type JsonRpcId = number | string;

type JsonRpcResponse = {
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    message?: string;
    code?: number;
  };
  method?: string;
  params?: Record<string, unknown>;
};

type AppServerRequest = JsonRpcResponse & {
  id: JsonRpcId;
  method: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  threadId?: string;
  createdAt: number;
  childGeneration: number;
};

class CodexAppServerRequestTimeoutError extends Error {
  constructor(message: string, readonly childGeneration: number) {
    super(message);
    this.name = "CodexAppServerRequestTimeoutError";
  }
}

class ThreadReadTimeoutError extends CodexAppServerRequestTimeoutError {
  constructor(message: string, childGeneration: number) {
    super(message, childGeneration);
    this.name = "ThreadReadTimeoutError";
  }
}

function isThreadReadTimeoutError(error: unknown): error is ThreadReadTimeoutError {
  return error instanceof ThreadReadTimeoutError || (error instanceof Error && error.name === "ThreadReadTimeoutError");
}

type PendingTurn = {
  chunks: string[];
  finalText?: string;
  generatedImageTags: string[];
  usage?: AdapterUsage;
  errorMessage?: string;
  turnId?: string;
  /** Cumulative stderr chars seen when this turn started; failure diagnostics
   * only include stderr produced after this point, so an hours-old tail line
   * (e.g. a stale 401) cannot misclassify an unrelated later failure. */
  stderrOffset: number;
  startedAt: number;
  lastActivityAt?: number;
  lastActivityMethod?: string;
  lastInactivityAt?: number;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  inactivityTimeout?: ReturnType<typeof setTimeout>;
  inactivityTimeoutDisabled?: boolean;
  abortCleanup?: () => void;
  resolve: (result: { text: string; usage?: AdapterUsage }) => void;
  reject: (error: Error) => void;
};

type AppServerProtocolDiagnostic = {
  at: number;
  id?: number;
  method: string;
  threadId?: string;
  childGeneration: number;
  status?: "ok" | "error";
};

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

export interface CodexToolItemEvent {
  toolName: string;
  toolInput?: unknown;
  toolUseId?: string;
  output?: string;
  isError: boolean;
}

/**
 * Map a completed Codex app-server item to a tool event for the Lark run card.
 * Codex reports tool work as typed items (commandExecution / fileChange /
 * mcpToolCall / webSearch). Field names vary across Codex versions, so every
 * extraction is best-effort and guarded; unknown items return null.
 */
export function extractCodexToolItem(item: unknown): CodexToolItemEvent | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const rec = item as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";
  const id = typeof rec.id === "string" ? rec.id : undefined;
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return undefined;
  };
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };
  const statusText = str("status");
  const isErrorStatus = statusText === "failed" || statusText === "error";

  switch (type) {
    case "commandExecution":
    case "command_execution": {
      const command = str("command", "cmd");
      const exitCode = num("exitCode", "exit_code");
      return {
        toolName: "Bash",
        ...(command !== undefined ? { toolInput: { command } } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("aggregatedOutput", "aggregated_output", "output", "stdout"),
        isError: isErrorStatus || (exitCode !== undefined && exitCode !== 0),
      };
    }
    case "fileChange":
    case "file_change": {
      const path = str("path", "file_path");
      return {
        toolName: "Edit",
        ...(path !== undefined ? { toolInput: { file_path: path } } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("summary", "output"),
        isError: isErrorStatus,
      };
    }
    case "mcpToolCall":
    case "mcp_tool_call": {
      const server = str("server");
      const tool = str("tool", "name");
      return {
        toolName: tool ? (server ? `${server}.${tool}` : tool) : "MCP tool",
        toolInput: rec.arguments ?? rec.input ?? undefined,
        ...(id ? { toolUseId: id } : {}),
        output: str("output", "result"),
        isError: isErrorStatus,
      };
    }
    case "webSearch":
    case "web_search": {
      const query = str("query");
      return {
        toolName: "WebSearch",
        ...(query !== undefined ? { toolInput: { query } } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("output", "result"),
        isError: isErrorStatus,
      };
    }
    case "plan":
    case "update_plan": {
      // Codex's plan/checklist — render it like Claude's TodoWrite plan panel.
      const todos = codexPlanTodos(rec.plan ?? rec.steps ?? rec.items);
      if (!todos) {
        return null;
      }
      return {
        toolName: "TodoWrite",
        toolInput: { todos },
        ...(id ? { toolUseId: id } : {}),
        isError: false,
      };
    }
    default:
      return null;
  }
}

/**
 * Convert Codex plan steps (`[{step, status}]`, status pending/in_progress/
 * completed) into the TodoWrite todo shape the run card's plan panel renders.
 * Returns null when there is nothing usable. Field access is defensive because
 * Codex's payload shape varies across versions.
 */
export function codexPlanTodos(planValue: unknown): Array<{ content: string; status: string; activeForm: string }> | null {
  const arr = Array.isArray(planValue)
    ? planValue
    : (planValue && typeof planValue === "object" && Array.isArray((planValue as Record<string, unknown>).steps)
      ? (planValue as Record<string, unknown>).steps as unknown[]
      : undefined);
  if (!arr) {
    return null;
  }
  const todos = arr
    .map((entry) => {
      const step = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const content = typeof step.step === "string" ? step.step
        : typeof step.content === "string" ? step.content
        : typeof step.text === "string" ? step.text
        : "";
      const status = typeof step.status === "string" ? step.status : "pending";
      return { content: content.trim(), status, activeForm: content.trim() };
    })
    .filter((todo) => todo.content.length > 0);
  return todos.length > 0 ? todos : null;
}

function resolveTurnApprovalPolicy(
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>,
): AppServerApprovalPolicy {
  return onApprovalRequest ? "on-request" : "never";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readUsageNumber(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readAdapterUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = readUsageNumber(usage, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const outputTokens = readUsageNumber(usage, "outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  const cachedTokens = readUsageNumber(usage, "cachedTokens", "cached_tokens", "cachedInputTokens", "cached_input_tokens");
  const costUsd = readUsageNumber(usage, "costUsd", "cost_usd");
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: cachedTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function readTurnUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const turn = value as Record<string, unknown>;
  return readAdapterUsage(turn.usage) ?? readAdapterUsage(turn);
}

function readThreadGoal(value: unknown): CodexThreadGoal | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const goal = value as {
    threadId?: unknown;
    objective?: unknown;
    status?: unknown;
    tokenBudget?: unknown;
    tokensUsed?: unknown;
    timeUsedSeconds?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (
    typeof goal.threadId !== "string" ||
    typeof goal.objective !== "string" ||
    (goal.status !== "active" && goal.status !== "paused" && goal.status !== "budgetLimited" && goal.status !== "complete")
  ) {
    return null;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: numberOrNull(goal.tokenBudget),
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
  };
}

function readGoalResponse(value: unknown): CodexThreadGoalResponse {
  const goal = typeof value === "object" && value !== null && "goal" in value
    ? readThreadGoal((value as { goal?: unknown }).goal)
    : null;
  return { goal };
}

/** Goal statuses at which the autonomous pursuit has stopped — the watch should end. */
function isTerminalGoalStatus(status: CodexThreadGoal["status"]): boolean {
  return status === "complete" || status === "budgetLimited";
}

/**
 * How often watchThreadGoal polls the goal status as a fallback. A long multi-turn goal
 * can miss the live terminal thread/goal/updated event, which would otherwise hang the
 * watch (and the caller's active-run slot) forever — the instance then looks permanently
 * "busy" and refuses to restart. Polling guarantees the watch resolves when the goal ends.
 */
const GOAL_WATCH_POLL_MS = 30_000;
const GOAL_RPC_REQUEST_OPTIONS = {
  timeoutMs: CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS,
  destroyOnTimeout: true,
} as const;

function readClearedResponse(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "cleared" in value &&
    (value as { cleared?: unknown }).cleared === true;
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalizedCommand = normalizeExecutableCommand(command);

  if (/\.(cmd|bat)$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...args],
    };
  }

  if (/\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", normalizedCommand, ...args],
    };
  }

  return { command: normalizedCommand, args, shell: false };
}

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export class CodexAppServerAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "telegram-out-only" as const;
  readonly supportsTurnScopedEnv = false;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: AppServerSpawnCodex;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  /**
   * Approval mode of the running app-server, captured at spawn alongside
   * sandbox_mode. Turns only forward command approvals in "normal" mode; in
   * bypass (danger-full-access) and full-auto the user opted out of approvals, so
   * the turn runs with policy "never". Without this gate Codex asked even in yolo.
   */
  private currentApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  private child: AppServerChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializeKey: string | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  /** Cumulative chars ever appended to stderrTail (pre-trim), used as the
   * per-turn offset baseline for turn-scoped failure diagnostics. */
  private stderrSeenChars = 0;
  private stdoutDiagnosticTail = "";
  private childGeneration = 0;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly nonBlockingRequestIds = new Set<number>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  // Watchers for a self-running thread goal (no user-initiated turn). Codex pursues a
  // goal autonomously and emits the SAME turn/item notifications; when there is no
  // pendingTurn for the thread, events fall back to this watcher so a goal can drive a
  // live run card. Keyed by threadId. Normal turns are unaffected (pendingTurns wins).
  private readonly goalWatchers = new Map<string, {
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    resolve: (goal: CodexThreadGoal | null) => void;
    latestGoal: CodexThreadGoal | null;
  }>();
  private readonly loadedThreads = new Set<string>();
  private completingTurns = 0;
  private readonly idleWaiters = new Set<() => void>();
  // Remembers the initializeKey whose pending config change we have already
  // warned about, so a deferred re-init logs ONCE per distinct change instead of
  // on every message that keeps hitting the busy child.
  private deferredConfigWarningKey: string | null = null;
  private lastRequestDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastResponseDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastNotificationDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastTurnActivityDiagnostic: AppServerProtocolDiagnostic | null = null;

  constructor(
    private readonly codexExecutable: string,
    private readonly cwd: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | AppServerSpawnCodex,
    spawnCodexArg?: AppServerSpawnCodex,
    instructionsPath?: string,
    engineHomePath?: string,
    configPath?: string,
    private readonly turnTimeoutMs: number = CODEX_APP_SERVER_TURN_TIMEOUT_MS,
    private readonly turnInactivityTimeoutMs: number | null = CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS,
    private readonly threadReadTimeoutMs: number = CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS,
  ) {
    const buildChildEnv = () => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (engineHomePath) {
        env.CODEX_HOME = engineHomePath;
      }
      // Otherwise inherit CODEX_HOME from the parent env so bots track the
      // same config dir the user's main Codex CLI uses. Unset → ~/.codex/.
      return env;
    };

    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? buildChildEnv()
        : childEnvOrSpawn ?? buildChildEnv();

    this.spawnCodex =
      typeof childEnvOrSpawn === "function"
        ? childEnvOrSpawn
        : spawnCodexArg ?? (spawn as unknown as AppServerSpawnCodex);
    this.instructionsPath = instructionsPath;
    this.configPath = configPath;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);

    const instructions = combineInstructions(
      this.instructionsPath ? await this.loadInstructions() : null,
      input.instructions ?? null,
    );
    const prompt = this.buildPrompt(input, instructions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    const turn = await this.startTurn(
      threadId,
      prompt,
      input.onProgress,
      input.onEngineEvent,
      // A config change may be deferred while the shared child is busy. Gate
      // approvals with the mode that actually spawned the running child, not
      // the newly-read config, so policy and sandbox never become half-applied.
      this.currentApprovalMode,
      input.onApprovalRequest,
      input.abortSignal,
      input.disableRuntimeTimeout ? null : this.turnTimeoutMs,
    );

    return {
      text: turn.text.trim() || `Session ${threadId} completed.`,
      sessionId: threadId !== sessionId ? threadId : undefined,
      usage: turn.usage,
    };
  }

  async getThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    const result = await this.request("thread/goal/get", { threadId }, GOAL_RPC_REQUEST_OPTIONS);
    return {
      ...readGoalResponse(result),
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    const result = await this.request("thread/goal/set", {
      threadId,
      objective: input.objective,
      tokenBudget: input.tokenBudget ?? null,
    }, GOAL_RPC_REQUEST_OPTIONS);
    return {
      ...readGoalResponse(result),
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  /**
   * Sets a thread goal and then watches Codex's AUTONOMOUS pursuit of it: streams the
   * turn/item events to onEngineEvent (so a live run card can render the progress) and
   * resolves when the goal reaches a terminal status (complete / budgetLimited) or the
   * abort signal fires. No turn is started here — Codex self-drives once the goal is set.
   */
  async watchThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);

    let resolveTerminal!: (goal: CodexThreadGoal | null) => void;
    const terminal = new Promise<CodexThreadGoal | null>((resolve) => { resolveTerminal = resolve; });
    const watcher = { onEngineEvent: input.onEngineEvent, resolve: resolveTerminal, latestGoal: null as CodexThreadGoal | null };
    this.goalWatchers.set(threadId, watcher);

    const onAbort = () => resolveTerminal(watcher.latestGoal);
    if (input.abortSignal) {
      if (input.abortSignal.aborted) onAbort();
      else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // Clear any existing goal first. thread/goal/set on a thread that already holds a
      // COMPLETE goal keeps the stale "complete" status + old token/time usage, so the
      // watch would resolve instantly showing the PREVIOUS run's stats (e.g. a brand-new
      // "review the bugs" goal reporting 432937 tokens / 1430s as already done). Clearing
      // makes the new objective start fresh as "active" so Codex actually pursues it.
      await this.request("thread/goal/clear", { threadId }, GOAL_RPC_REQUEST_OPTIONS).catch(() => {});
      const setResult = await this.request("thread/goal/set", {
        threadId,
        objective: input.objective,
        tokenBudget: input.tokenBudget ?? null,
      }, GOAL_RPC_REQUEST_OPTIONS);
      const setGoal = readGoalResponse(setResult).goal;
      if (setGoal) {
        watcher.latestGoal = setGoal;
        if (isTerminalGoalStatus(setGoal.status)) {
          resolveTerminal(setGoal);
        }
      }
      // Poll fallback so the watch always resolves even if the live terminal
      // thread/goal/updated event is missed (otherwise the caller's active-run slot
      // leaks and the instance looks permanently busy — observed on a long goal).
      pollTimer = setInterval(() => {
        void this.request("thread/goal/get", { threadId }, GOAL_RPC_REQUEST_OPTIONS)
          .then((response) => {
            const goal = readGoalResponse(response).goal;
            if (goal) {
              watcher.latestGoal = goal;
              if (isTerminalGoalStatus(goal.status)) {
                resolveTerminal(goal);
              }
            }
          })
          .catch(() => {});
      }, GOAL_WATCH_POLL_MS);
      pollTimer.unref?.();
      const finalGoal = await terminal;
      return {
        goal: finalGoal ?? setGoal ?? watcher.latestGoal,
        sessionId: threadId !== sessionId ? threadId : undefined,
      };
    } finally {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      this.goalWatchers.delete(threadId);
      input.abortSignal?.removeEventListener("abort", onAbort);
      this.notifyIdleWaitersIfIdle();
    }
  }

  async clearThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<{ cleared: boolean; sessionId?: string }> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    const result = await this.request("thread/goal/clear", { threadId }, GOAL_RPC_REQUEST_OPTIONS);
    // End any live watcher for this thread so its run card finalizes instead of
    // hanging: clearing the goal stops Codex's autonomous pursuit but emits no
    // terminal thread/goal/updated for the watcher to key off.
    const watcher = this.goalWatchers.get(threadId);
    if (watcher) {
      watcher.resolve(watcher.latestGoal);
    }
    return {
      cleared: readClearedResponse(result),
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  async validateExternalSession(sessionId: string): Promise<void> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);

    if (isLogicalTelegramSessionId(sessionId)) {
      return;
    }

    await this.retryThreadReadAfterTimeout(() => this.ensureThreadLoaded(sessionId), runtimeOptions);
  }

  private async loadRuntimeOptions(): Promise<{
    approvalMode: ApprovalMode;
    effort?: string;
    model?: string;
    codexServiceTier?: "fast";
    initializeArgs: string[];
    initializeKey: string;
  }> {
    if (!this.configPath) {
      return {
        approvalMode: "normal",
        initializeArgs: ["app-server"],
        initializeKey: JSON.stringify({ approvalMode: "normal" }),
      };
    }

    const parsed = await readValidatedConfigFile(this.configPath);
    const approvalMode: ApprovalMode = normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
    const effort = typeof parsed.effort === "string" ? parsed.effort : undefined;
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
    const codexServiceTier = parsed.codexServiceTier === "fast" ? "fast" : undefined;
    const initializeArgs = ["app-server"];

    if (approvalMode === "bypass") {
      initializeArgs.push("-c", 'sandbox_mode="danger-full-access"');
    } else if (approvalMode === "full-auto") {
      initializeArgs.push("-c", 'sandbox_mode="workspace-write"');
    }

    if (effort) {
      initializeArgs.push("-c", `model_reasoning_effort="${effort}"`);
    }

    if (model) {
      initializeArgs.push("-c", `model="${model}"`);
    }

    if (codexServiceTier === "fast") {
      initializeArgs.push("--enable", "fast_mode", "-c", 'service_tier="fast"');
    }

    return {
      approvalMode,
      effort,
      model,
      codexServiceTier,
      initializeArgs,
      initializeKey: JSON.stringify({ approvalMode, effort, model, codexServiceTier }),
    };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.length <= MAX_INSTRUCTIONS_CHARS) {
        return trimmed;
      }

      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch {
      return null;
    }
  }

  private buildPrompt(input: CodexUserMessageInput, instructions: string | null): string {
    const parts: string[] = [];

    if (instructions) {
      parts.push(`[System Instructions]\n${instructions}\n[End Instructions]`);
    }

    parts.push(input.text);
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    return parts.join("\n");
  }

  private async ensureInitialized(runtimeOptions: {
    approvalMode: ApprovalMode;
    initializeArgs: string[];
    initializeKey: string;
  }): Promise<void> {
    let deferredConfigChange = false;
    if (this.initializeKey !== null && this.initializeKey !== runtimeOptions.initializeKey) {
      if (!this.isIdle() && this.initializePromise) {
        if (this.deferredConfigWarningKey !== runtimeOptions.initializeKey) {
          this.deferredConfigWarningKey = runtimeOptions.initializeKey;
          console.error(
            `Codex app-server config change deferred while busy; continuing on the old config until idle${
              this.goalWatchers.size > 0 ? "; a /goal pursuit is holding the session" : ""
            }`,
          );
        }
        deferredConfigChange = true;
      } else {
        try {
          await this.waitForIdle();
          if (this.initializeKey !== null && this.initializeKey !== runtimeOptions.initializeKey) {
            this.destroy();
          }
        } catch (error) {
          if (this.initializePromise) {
            if (this.deferredConfigWarningKey !== runtimeOptions.initializeKey) {
              this.deferredConfigWarningKey = runtimeOptions.initializeKey;
              console.error(
                `Codex app-server config change deferred while busy; continuing on the old config until idle${
                  this.goalWatchers.size > 0 ? "; a /goal pursuit is holding the session" : ""
                }): ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deferredConfigChange = true;
          }
        }
      }
    }
    // The pending change was applied (or there was nothing to defer): clear the
    // one-shot warning latch so a future deferral logs again.
    if (!deferredConfigChange) {
      this.deferredConfigWarningKey = null;
    }

    if (!this.initializePromise) {
      this.currentApprovalMode = runtimeOptions.approvalMode;
      this.initializeKey = runtimeOptions.initializeKey;
      this.initializePromise = this.startChildAndInitialize(runtimeOptions.initializeArgs);
    }

    return this.initializePromise;
  }

  private async startChildAndInitialize(appServerArgs: string[]): Promise<void> {
    const invocation = buildCommandInvocation(this.codexExecutable, appServerArgs);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.cwd,
      windowsHide: true,
    });

    this.child = child;
    const childGeneration = ++this.childGeneration;
    child.stdout?.on("data", (chunk) => {
      this.handleStdout(chunk.toString());
    });

    child.stderr?.on("data", (chunk) => {
      // App-server emits JSON-RPC over stdout. Keep a bounded stderr tail so
      // stalled-turn errors carry the underlying runtime context.
      this.appendDiagnostic("stderr", chunk.toString());
    });

    child.once("error", (error) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      this.failAllPending(this.withDiagnostics(error instanceof Error ? error.message : String(error)));
      this.resetChildState();
    });

    child.once("close", (code) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      this.failAllPending(this.withDiagnostics(`codex app-server exited with code ${code}`));
      this.resetChildState();
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "tarocub",
          title: "TaroCub",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      {
        timeoutMs: CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
        timeoutMessage: `Codex app-server initialize timed out after ${Math.max(1, Math.round(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS / 1000))} seconds`,
        destroyOnTimeout: true,
      },
    );
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk;

    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line.length > MAX_LINE_BUFFER_BYTES && !this.looksLikeJsonRpcLine(line)) {
        this.appendOversizedStdoutDiagnostic(line);
        continue;
      }
      this.handleMessage(line);
    }

    if (this.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      if (this.looksLikeJsonRpcLine(this.lineBuffer)) {
        if (this.lineBuffer.length > MAX_PROTOCOL_LINE_BUFFER_BYTES) {
          this.failAllPending(this.withDiagnostics("Codex app-server JSON-RPC output exceeded maximum buffer size"));
          this.terminateChild();
          this.resetChildState();
        }
        return;
      }
      this.appendOversizedStdoutDiagnostic(this.lineBuffer);
      this.lineBuffer = "";
    }
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.appendDiagnostic("stdout", line);
      return;
    }

    if ((typeof parsed.id === "number" || typeof parsed.id === "string") && typeof parsed.method === "string") {
      this.handleServerRequest(parsed as AppServerRequest);
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(parsed.id);
      this.lastResponseDiagnostic = {
        at: Date.now(),
        id: parsed.id,
        method: pending.method,
        threadId: pending.threadId ?? this.readThreadIdFromResult(parsed.result),
        childGeneration: pending.childGeneration,
        status: parsed.error ? "error" : "ok",
      };
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Unknown app-server error"));
      } else {
        pending.resolve(parsed.result);
      }
      this.notifyIdleWaitersIfIdle();
      return;
    }

    if (typeof parsed.method === "string") {
      this.recordNotificationDiagnostic(parsed.method, parsed.params);
      // Any thread-scoped notification proves the turn is alive (item starts,
      // command-output deltas, ...), not just the explicitly handled methods —
      // otherwise a quiet long tool execution trips the inactivity watchdog.
      const notificationThreadId = this.readString(parsed.params?.threadId);
      if (notificationThreadId) {
        this.noteTurnActivity(notificationThreadId, parsed.method);
      }
    }

    if (parsed.method === "turn/started") {
      // Capture the turn id so an abort/inactivity interrupt can address it.
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      if (pending && !pending.turnId) {
        const turn = parsed.params?.turn;
        if (typeof turn === "object" && turn !== null && typeof (turn as { id?: unknown }).id === "string") {
          pending.turnId = (turn as { id: string }).id;
        }
      }
      return;
    }

    if (parsed.method === "item/agentMessage/delta") {
      const threadId = this.readString(parsed.params?.threadId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && delta) {
        const pending = this.pendingTurns.get(threadId);
        if (pending) {
          pending.chunks.push(delta);
          pending.onProgress?.(pending.chunks.join(""));
        }
        this.emitEngineEvent(threadId, {
          type: "assistant_text",
          text: delta,
          delta: true,
          sessionId: threadId,
        });
      }
      return;
    }

    if (parsed.method === "item/reasoning/delta") {
      const threadId = this.readString(parsed.params?.threadId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && delta) {
        this.emitEngineEvent(threadId, {
          type: "thinking",
          text: delta,
          sessionId: threadId,
        });
      }
      return;
    }

    if (parsed.method === "turn/plan/updated") {
      // Codex's plan/checklist (the `update_plan` tool). Surface it the same way
      // as Claude's TodoWrite so the run card shows the live plan panel.
      const threadId = this.readString(parsed.params?.threadId);
      const todos = codexPlanTodos((parsed.params as Record<string, unknown> | undefined)?.plan);
      if (threadId && todos) {
        this.emitEngineEvent(threadId, {
          type: "tool_use",
          toolName: "TodoWrite",
          toolInput: { todos },
          sessionId: threadId,
        });
      }
      return;
    }

    if (parsed.method === "thread/goal/updated") {
      // Progress of a (possibly self-running) thread goal. Feed the goal watcher so a
      // live goal run card can show status/usage; a terminal status ends the watch.
      const threadId = this.readString(parsed.params?.threadId);
      if (threadId) {
        const watcher = this.goalWatchers.get(threadId);
        if (watcher) {
          const goal = readThreadGoal((parsed.params as { goal?: unknown } | undefined)?.goal);
          if (goal) {
            watcher.latestGoal = goal;
            if (isTerminalGoalStatus(goal.status)) {
              watcher.resolve(goal);
            }
          }
        }
      }
      return;
    }

    if (parsed.method === "item/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      const item = parsed.params?.item;
      if (pending && threadId) {
        const generatedImagePath = extractGeneratedImagePath(item);
        if (generatedImagePath) {
          this.addGeneratedImageTag(pending, threadId, generatedImagePath);
        }
      }
      if (
        pending &&
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type?: unknown }).type === "agentMessage" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        pending.finalText = (item as { text: string }).text;
      } else if (threadId) {
        const toolEvent = extractCodexToolItem(item);
        if (toolEvent) {
          // Codex app-server reports a completed tool item in one shot. Emit the
          // tool_use + tool_result pair so the Lark run card renders a finished
          // tool panel with output and status, matching the Claude path. Routed via
          // emitEngineEvent so a self-running goal's watcher receives it too.
          this.emitEngineEvent(threadId, {
            type: "tool_use",
            toolName: toolEvent.toolName,
            ...(toolEvent.toolInput === undefined ? {} : { toolInput: toolEvent.toolInput }),
            ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
            sessionId: threadId,
          });
          // A plan (TodoWrite) is meta-state shown as the plan panel, not a tool
          // block, so it needs no completion event. Skipping it also avoids an
          // id-less result wrongly finishing an unrelated running tool.
          if (toolEvent.toolName !== "TodoWrite") {
            this.emitEngineEvent(threadId, {
              type: "tool_result",
              ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
              toolName: toolEvent.toolName,
              ...(toolEvent.output !== undefined ? { output: toolEvent.output } : {}),
              isError: toolEvent.isError,
              sessionId: threadId,
            });
          }
        }
      }
      return;
    }

    if (parsed.method === "turn/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const turnId =
        typeof parsed.params?.turn === "object" &&
        parsed.params?.turn !== null &&
        "id" in parsed.params.turn &&
        typeof (parsed.params.turn as { id?: unknown }).id === "string"
          ? (parsed.params.turn as { id: string }).id
          : undefined;
      if (!threadId) {
        return;
      }

      const pending = this.pendingTurns.get(threadId);
      if (!pending) {
        return;
      }
      pending.usage = readTurnUsage(parsed.params?.turn) ?? readTurnUsage(parsed.params?.usage) ?? pending.usage;

      pending.inactivityTimeout && clearTimeout(pending.inactivityTimeout);
      pending.inactivityTimeout = undefined;
      this.pendingTurns.delete(threadId);
      const turnErrorMessage = this.readTurnErrorMessage(parsed.params?.turn);
      this.completingTurns += 1;
      if (turnErrorMessage) {
        pending.reject(this.withDiagnostics(turnErrorMessage, pending.stderrOffset));
        this.finishCompletingTurn();
        return;
      }

      void this.completeTurn(threadId, turnId, pending).catch((error) => {
        pending.reject(this.withDiagnostics(error instanceof Error ? error.message : String(error), pending.stderrOffset));
      }).finally(() => {
        this.finishCompletingTurn();
      });
      return;
    }

    if (parsed.method === "error") {
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      const errorMessage = this.readErrorMessage(parsed.params?.error);

      if (pending && errorMessage) {
        pending.errorMessage = errorMessage;
      }
      return;
    }
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private readErrorMessage(value: unknown): string | null {
    if (
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof (value as { message?: unknown }).message === "string"
    ) {
      const message = (value as { message: string }).message.trim();
      return message || null;
    }

    return null;
  }

  private readTurnErrorMessage(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const turn = value as {
      status?: unknown;
      error?: unknown;
    };
    const errorMessage = this.readErrorMessage(turn.error);
    if (errorMessage) {
      return errorMessage;
    }

    if (turn.status === "failed") {
      return "Codex turn failed.";
    }

    return null;
  }

  private readThreadIdFromResult(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const result = value as { thread?: unknown; threadId?: unknown };
    if (typeof result.threadId === "string") {
      return result.threadId;
    }
    if (typeof result.thread === "object" && result.thread !== null) {
      const thread = result.thread as { id?: unknown };
      if (typeof thread.id === "string") {
        return thread.id;
      }
    }
    return undefined;
  }

  private recordNotificationDiagnostic(method: string, params: Record<string, unknown> | undefined): void {
    this.lastNotificationDiagnostic = {
      at: Date.now(),
      method,
      threadId: this.readString(params?.threadId) ?? undefined,
      childGeneration: this.childGeneration,
    };
  }

  /**
   * Routes a normalized engine event to the thread's active turn, or — when the thread
   * is running a goal autonomously (no pendingTurn) — to its goal watcher, so a
   * self-running goal can drive a live run card.
   */
  private emitEngineEvent(threadId: string, event: EngineStreamEvent): void {
    const sink = this.pendingTurns.get(threadId)?.onEngineEvent ?? this.goalWatchers.get(threadId)?.onEngineEvent;
    if (sink) {
      void Promise.resolve(sink(event)).catch(() => {});
    }
  }

  private handleServerRequest(request: AppServerRequest): void {
    this.recordNotificationDiagnostic(request.method, request.params);
    const threadId = this.readString(request.params?.threadId);
    if (threadId) {
      this.noteTurnActivity(threadId, request.method);
    }

    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "execCommandApproval"
    ) {
      void this.handleApprovalServerRequest(request, "Codex command approval");
      return;
    }

    if (
      request.method === "item/fileChange/requestApproval" ||
      request.method === "applyPatchApproval"
    ) {
      void this.handleApprovalServerRequest(request, "Codex file change approval");
      return;
    }

    const message = `Unsupported Codex app-server request: ${request.method}`;
    this.rejectServerRequest(request.id, message);
    if (threadId) {
      this.failPendingTurn(threadId, message);
    }
  }

  private async handleApprovalServerRequest(request: AppServerRequest, toolName: string): Promise<void> {
    const params = request.params ?? {};
    const threadId = this.readString(params.threadId);
    const pending = threadId ? this.pendingTurns.get(threadId) : undefined;

    if (!threadId || !pending) {
      this.respondToServerRequest(request.id, { decision: "cancel" });
      return;
    }

    const toolInput = this.buildApprovalToolInput(request.method, params);
    void Promise.resolve(pending.onEngineEvent?.({
      type: "permission_request",
      toolName,
      toolInput,
      sessionId: threadId,
    })).catch(() => {});

    try {
      const decision = pending.onApprovalRequest
        ? await pending.onApprovalRequest({
          engine: "codex",
          toolName,
          toolInput,
          cwd: this.readString(params.cwd) ?? undefined,
          sessionId: threadId,
        })
        : { behavior: "deny" as const };

      this.respondToServerRequest(request.id, {
        decision: this.toAppServerApprovalDecision(decision),
      });
    } catch (error) {
      pending.errorMessage = error instanceof Error ? error.message : String(error);
      this.respondToServerRequest(request.id, { decision: "cancel" });
    }
  }

  private buildApprovalToolInput(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const toolInput: Record<string, unknown> = {
      method,
      raw: params,
    };
    for (const key of ["command", "reason", "itemId", "turnId", "cwd", "approvalId"]) {
      const value = this.readString(params[key]);
      if (value) {
        toolInput[key] = value;
      }
    }
    return toolInput;
  }

  private toAppServerApprovalDecision(decision: EngineApprovalDecision): "accept" | "acceptForSession" | "decline" {
    if (decision.behavior !== "allow") {
      return "decline";
    }
    return decision.scope === "session" ? "acceptForSession" : "accept";
  }

  private respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.writeJsonRpc({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private rejectServerRequest(id: JsonRpcId, message: string): void {
    this.writeJsonRpc({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message,
      },
    });
  }

  private writeJsonRpc(payload: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      // The existing turn timeout/error path will surface the closed child.
    }
  }

  private failPendingTurn(threadId: string, message: string): void {
    const pending = this.pendingTurns.get(threadId);
    if (!pending) {
      return;
    }

    // Thread-scoped: reject and evict only THIS thread. The child is shared by
    // every concurrent conversation, so we must NOT destroy() it for one
    // thread's fault (e.g. an unsupported server request) — that would tear down
    // unrelated healthy turns. Genuine child-level faults (close/error/oversized
    // protocol line) still failAllPending via their own handlers, and a wedged
    // child is caught by the next thread/resume|read timeout (destroyOnTimeout).
    this.pendingTurns.delete(threadId);
    this.loadedThreads.delete(threadId);
    pending.reject(this.withDiagnostics(this.withAppServerState(message, threadId, pending), pending.stderrOffset));
    this.notifyIdleWaitersIfIdle();
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options?: { idleBlocking?: boolean; timeoutMs?: number; timeoutMessage?: string; destroyOnTimeout?: boolean },
  ): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;

    if (!stdin) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const requestChildGeneration = this.childGeneration;
    const requestThreadId = this.readString(params.threadId) ?? undefined;
    const requestCreatedAt = Date.now();
    this.lastRequestDiagnostic = {
      at: requestCreatedAt,
      id,
      method,
      threadId: requestThreadId,
      childGeneration: requestChildGeneration,
    };
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const idleBlocking = options?.idleBlocking !== false;
      const resolveOnce = (value: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.nonBlockingRequestIds.delete(id);
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.pendingRequests.delete(id);
        this.nonBlockingRequestIds.delete(id);
        this.notifyIdleWaitersIfIdle();
        reject(error);
      };

      if (!idleBlocking) {
        this.nonBlockingRequestIds.add(id);
      }
      this.pendingRequests.set(id, {
        resolve: resolveOnce,
        reject: rejectOnce,
        method,
        threadId: requestThreadId,
        createdAt: requestCreatedAt,
        childGeneration: requestChildGeneration,
      });
      if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          rejectOnce(this.createRequestTimeoutError(
            method,
            options.timeoutMessage ?? `codex app-server ${method} timed out after ${options.timeoutMs}ms`,
            requestChildGeneration,
          ));
          if (options.destroyOnTimeout) {
            queueMicrotask(() => {
              this.destroy(requestChildGeneration);
            });
          }
        }, options.timeoutMs);
      }

      try {
        stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }) + "\n",
          (error) => {
            if (error) {
              rejectOnce(error);
            }
          },
        );
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async startThread(cwd: string = this.cwd): Promise<string> {
    const result = (await this.request(
      "thread/start",
      {
        cwd,
        approvalPolicy: "never",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
      {
        timeoutMs: this.threadReadTimeoutMs,
        timeoutMessage: `Codex app-server thread/start timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
        destroyOnTimeout: true,
      },
    )) as { thread?: { id?: string } };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }

    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async ensureThreadLoaded(threadId: string): Promise<string> {
    if (this.loadedThreads.has(threadId)) {
      return threadId;
    }

    const result = (await this.request(
      "thread/resume",
      {
        threadId,
        approvalPolicy: "never",
      },
      {
        timeoutMs: this.threadReadTimeoutMs,
        timeoutMessage: `Codex app-server thread/resume timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
        destroyOnTimeout: true,
      },
    )) as { thread?: { id?: string } };
    const resumedThreadId = result.thread?.id;

    if (!resumedThreadId) {
      throw new Error(`codex app-server could not resume thread ${threadId}`);
    }

    this.loadedThreads.add(resumedThreadId);
    return resumedThreadId;
  }

  private async resolveThreadForMessage(threadId: string, cwd: string = this.cwd): Promise<string> {
    try {
      return await this.ensureThreadLoaded(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/thread not found|no rollout found/i.test(message)) {
        return await this.startThread(cwd);
      }

      throw error;
    }
  }

  private async resolveThreadForMessageWithRetry(
    sessionId: string,
    runtimeOptions: Awaited<ReturnType<CodexAppServerAdapter["loadRuntimeOptions"]>>,
    cwd: string = this.cwd,
  ): Promise<string> {
    return this.retryThreadReadAfterTimeout(
      () => isLogicalTelegramSessionId(sessionId)
        ? this.startThread(cwd)
        : this.resolveThreadForMessage(sessionId, cwd),
      runtimeOptions,
    );
  }

  private async retryThreadReadAfterTimeout<T>(
    operation: () => Promise<T>,
    runtimeOptions: Awaited<ReturnType<CodexAppServerAdapter["loadRuntimeOptions"]>>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isThreadReadTimeoutError(error)) {
        throw error;
      }
      this.destroy(error.childGeneration);
      await this.ensureInitialized(runtimeOptions);
      return await operation();
    }
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    onProgress?: (partialText: string) => void,
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>,
    approvalMode: ApprovalMode = this.currentApprovalMode,
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>,
    abortSignal?: AbortSignal,
    timeoutMs: number | null = this.turnTimeoutMs,
  ): Promise<{ text: string; usage?: AdapterUsage }> {
    // Forward command approvals only in "normal" mode; in bypass/full-auto the user
    // opted out, so the turn runs with approvalPolicy "never" and Codex never asks
    // (mirrors the `approvalMode === "normal"` gate in the Claude/Antigravity/process
    // adapters). Without this, even a yolo/bypass instance prompted for e.g. rm -rf.
    const gatedApprovalRequest = approvalMode === "normal" ? onApprovalRequest : undefined;
    const pending = await new Promise<{ text: string; usage?: AdapterUsage }>((resolve, reject) => {
      const turnErrorPrefix = "Codex app-server turn";
      const rejectAndCleanup = (error: Error) => {
        pendingTurn.timeout && clearTimeout(pendingTurn.timeout);
        pendingTurn.timeout = undefined;
        pendingTurn.inactivityTimeout && clearTimeout(pendingTurn.inactivityTimeout);
        pendingTurn.inactivityTimeout = undefined;
        pendingTurn.abortCleanup?.();
        pendingTurn.abortCleanup = undefined;
        reject(error);
      };
      const resolveAndCleanup = (result: { text: string; usage?: AdapterUsage }) => {
        pendingTurn.timeout && clearTimeout(pendingTurn.timeout);
        pendingTurn.timeout = undefined;
        pendingTurn.inactivityTimeout && clearTimeout(pendingTurn.inactivityTimeout);
        pendingTurn.inactivityTimeout = undefined;
        pendingTurn.abortCleanup?.();
        pendingTurn.abortCleanup = undefined;
        resolve(result);
      };
      const pendingTurn: PendingTurn = {
        chunks: [],
        generatedImageTags: [],
        stderrOffset: this.stderrSeenChars,
        startedAt: Date.now(),
        onProgress,
        onEngineEvent,
        onApprovalRequest: gatedApprovalRequest,
        inactivityTimeoutDisabled: timeoutMs === null,
        resolve: resolveAndCleanup,
        reject: rejectAndCleanup,
      };
      // Thread-scoped abort: reject and evict only this turn's thread. Never
      // destroy() the shared child for one turn's timeout/abort — that would
      // kill other concurrent conversations. A truly wedged child is still
      // caught by the next thread/resume|thread/read request (destroyOnTimeout).
      // turn/interrupt tells the app-server to stop executing server-side too;
      // without it the engine kept running the turn after /stop.
      const abortTurn = (error: Error) => {
        const pendingTurnState = this.pendingTurns.get(threadId);
        if (pendingTurnState && pendingTurnState !== pendingTurn) {
          return;
        }

        if (pendingTurnState === pendingTurn) {
          this.pendingTurns.delete(threadId);
        }
        this.loadedThreads.delete(threadId);
        this.interruptTurn(threadId, pendingTurn.turnId);
        pendingTurn.reject(error);
        this.notifyIdleWaitersIfIdle();
      };

      if (timeoutMs !== null) {
        pendingTurn.timeout = setTimeout(() => {
          abortTurn(
            this.withDiagnostics(
              this.withAppServerState(
                `${turnErrorPrefix} timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
                threadId,
                pendingTurn,
              ),
              pendingTurn.stderrOffset,
            ),
          );
        }, timeoutMs);
      }

      this.pendingTurns.set(threadId, pendingTurn);
      this.scheduleTurnInactivityTimeout(
        threadId,
        pendingTurn,
        timeoutMs === null ? null : this.turnInactivityTimeoutMs,
      );

      if (abortSignal) {
        const onAbort = () => {
          abortTurn(new Error(`${turnErrorPrefix} aborted`));
        };
        pendingTurn.abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
      this.request("turn/start", {
        threadId,
        approvalPolicy: resolveTurnApprovalPolicy(gatedApprovalRequest),
        input: [
          {
            type: "text",
            text: prompt,
            text_elements: [],
          },
        ],
      }, {
        idleBlocking: false,
      }).then((result) => {
        // The turn/start response carries the turn id immediately (the turn
        // itself runs async); capture it so abort/inactivity can interrupt.
        if (this.pendingTurns.get(threadId) === pendingTurn && !pendingTurn.turnId) {
          const turn = (result as { turn?: { id?: unknown } } | null | undefined)?.turn;
          if (turn && typeof turn.id === "string") {
            pendingTurn.turnId = turn.id;
          }
        }
      }, (error) => {
        const pendingTurnState = this.pendingTurns.get(threadId);
        if (pendingTurnState !== pendingTurn) {
          this.notifyIdleWaitersIfIdle();
          return;
        }
        this.pendingTurns.delete(threadId);
        this.notifyIdleWaitersIfIdle();
        pendingTurn.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    return pending;
  }

  private noteTurnActivity(threadId: string, method: string): void {
    const pending = this.pendingTurns.get(threadId);
    if (!pending) {
      return;
    }

    const now = Date.now();
    pending.lastActivityAt = now;
    pending.lastActivityMethod = method;
    this.lastTurnActivityDiagnostic = {
      at: now,
      method,
      threadId,
      childGeneration: this.childGeneration,
    };
    this.scheduleTurnInactivityTimeout(
      threadId,
      pending,
      pending.inactivityTimeoutDisabled ? null : this.turnInactivityTimeoutMs,
    );
  }

  private scheduleTurnInactivityTimeout(
    threadId: string,
    pending: PendingTurn,
    timeoutMs: number | null,
  ): void {
    pending.inactivityTimeout && clearTimeout(pending.inactivityTimeout);
    pending.inactivityTimeout = undefined;

    if (timeoutMs === null) {
      return;
    }

    pending.inactivityTimeout = setTimeout(() => {
      pending.inactivityTimeout = undefined;
      const pendingTurnState = this.pendingTurns.get(threadId);
      if (pendingTurnState && pendingTurnState !== pending) {
        return;
      }

      if (pendingTurnState === pending) {
        pending.lastInactivityAt = Date.now();
        this.pendingTurns.delete(threadId);
        this.loadedThreads.delete(threadId);
        this.interruptTurn(threadId, pending.turnId);
        pending.reject(
          this.withDiagnostics(
            this.withAppServerState(
              `Codex app-server turn became inactive after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
              threadId,
              pending,
            ),
            pending.stderrOffset,
          ),
        );
        this.notifyIdleWaitersIfIdle();
        // Thread-scoped: do not destroy the shared child for one turn's
        // inactivity; other concurrent turns keep running. A wedged child is
        // caught by the next thread/resume|read timeout (destroyOnTimeout).
      }
    }, timeoutMs);
  }

  /**
   * Best-effort server-side stop for an aborted or inactive turn (verified
   * protocol method: turn/interrupt, requires threadId + turnId — codex 0.139
   * app-server JSON schema). Fire-and-forget: the local rejection already
   * happened; this only stops the engine from continuing to execute. turnId is
   * briefly unknown until the turn/start response arrives — in that window
   * there is no addressable turn to interrupt yet, so this is a no-op.
   */
  private interruptTurn(threadId: string, turnId: string | undefined): void {
    if (!turnId || !this.child?.stdin) {
      return;
    }
    void this.request("turn/interrupt", { threadId, turnId }, {
      idleBlocking: false,
      timeoutMs: CODEX_APP_SERVER_TURN_INTERRUPT_TIMEOUT_MS,
    }).catch(() => {});
  }

  /**
   * Inject additional user input into this session's currently running turn
   * (verified protocol method: turn/steer, requires threadId + expectedTurnId
   * + input — codex 0.139 app-server JSON schema). The engine folds the text
   * into the active turn as a new user message and course-corrects. Returns
   * false when there is no addressable turn (none running, turnId not yet
   * known, or expectedTurnId no longer matches because the turn just ended) —
   * callers fall back to a normal queued message so the input is never lost.
   * pendingTurns is keyed by threadId; a bound session's id IS its thread id,
   * so a brand-new chat whose first turn has not persisted a binding yet
   * simply misses here and queues normally.
   */
  async steerActiveTurn(sessionId: string, input: { text: string }): Promise<boolean> {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending?.turnId || !this.child?.stdin) {
      return false;
    }
    try {
      await this.request("turn/steer", {
        threadId: sessionId,
        expectedTurnId: pending.turnId,
        input: [{ type: "text", text: input.text }],
      }, {
        idleBlocking: false,
        timeoutMs: CODEX_APP_SERVER_TURN_STEER_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  private addGeneratedImageTag(pending: PendingTurn, threadId: string, filePath: string): void {
    const tag = sendImageTag(filePath);
    if (pending.generatedImageTags.includes(tag)) {
      return;
    }
    pending.generatedImageTags.push(tag);
    pending.finalText = appendUniqueSendImageTag(pending.finalText ?? pending.chunks.join(""), filePath);
    void Promise.resolve(pending.onEngineEvent?.({
      type: "assistant_text",
      text: tag,
      sessionId: threadId,
    })).catch(() => {});
  }

  private async completeTurn(threadId: string, turnId: string | undefined, pending: PendingTurn): Promise<void> {
    // A turn that received an `error` notification genuinely failed — surface it
    // (so classifyFailure/auth-retry sees the real cause) even if partial text
    // was already streamed, instead of reporting the partial output as success.
    if (pending.errorMessage) {
      pending.reject(new Error(pending.errorMessage));
      return;
    }

    let text = pending.finalText ?? pending.chunks.join("");
    for (const tag of pending.generatedImageTags) {
      if (!text.includes(tag)) {
        text = [text.trim(), tag].filter(Boolean).join("\n");
      }
    }

    if (!text) {
      const turnResult = await this.readTurnResult(threadId, turnId);
      if (turnResult.errorMessage) {
        pending.reject(new Error(turnResult.errorMessage));
        return;
      }

      text = turnResult.text;
      pending.usage = turnResult.usage ?? pending.usage;
    }

    if (!text.trim() && pending.errorMessage) {
      pending.reject(new Error(pending.errorMessage));
      return;
    }

    pending.resolve({ text, usage: pending.usage });
  }

  private async readTurnResult(
    threadId: string,
    turnId: string | undefined,
  ): Promise<{ text: string; usage?: AdapterUsage; errorMessage?: string }> {
    const result = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
    }, {
      timeoutMs: this.threadReadTimeoutMs,
      timeoutMessage: `Codex app-server thread/read timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
      destroyOnTimeout: true,
    })) as {
      thread?: {
        turns?: Array<{
          id?: string;
          status?: string;
          error?: {
            message?: string;
          } | null;
          items?: Array<{
            type?: string;
            text?: string;
          } & Record<string, unknown>>;
        }>;
      };
    };

    const turns = result.thread?.turns ?? [];
    const targetTurn =
      (turnId ? turns.find((turn) => turn.id === turnId) : undefined) ??
      turns.at(-1);

    const turnErrorMessage = this.readErrorMessage(targetTurn?.error);
    if (targetTurn?.status === "failed" && turnErrorMessage) {
      return {
        text: "",
        errorMessage: turnErrorMessage,
      };
    }

    const items = targetTurn?.items ?? [];
    const generatedImageTags: string[] = [];
    let agentText = "";
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      const generatedImagePath = extractGeneratedImagePath(item);
      if (generatedImagePath) {
        const tag = sendImageTag(generatedImagePath);
        if (!generatedImageTags.includes(tag)) {
          generatedImageTags.unshift(tag);
        }
      }
      if (!agentText && item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        agentText = item.text;
      }
    }

    let text = agentText.trim();
    for (const tag of generatedImageTags) {
      if (!text.includes(tag)) {
        text = [text, tag].filter(Boolean).join("\n");
      }
    }
    return { text, usage: readTurnUsage(targetTurn) };
  }

  destroy(expectedChildGeneration?: number): void {
    if (expectedChildGeneration !== undefined && expectedChildGeneration !== this.childGeneration) {
      return;
    }
    this.terminateChild();
    this.failAllPending(this.withDiagnostics("Adapter destroyed"));
    this.resetChildState();
  }

  /**
   * destroy() fires when the child is presumed wedged; a bare SIGTERM to the
   * direct child leaves its descendants (shells, MCP servers) running while a
   * replacement is spawned beside them — so kill the whole tree
   * (SIGTERM → grace → SIGKILL). Fakes without a pid fall back to kill().
   */
  private terminateChild(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    if (child.pid) {
      killProcessTree(child.pid);
    } else {
      child.kill?.();
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.nonBlockingRequestIds.clear();

    for (const pending of this.pendingTurns.values()) {
      pending.reject(error);
    }
    this.pendingTurns.clear();
    this.completingTurns = 0;
    for (const watcher of this.goalWatchers.values()) {
      watcher.resolve(watcher.latestGoal);
    }
    this.goalWatchers.clear();
    this.loadedThreads.clear();
    this.notifyIdleWaitersIfIdle();
  }

  private isIdle(): boolean {
    for (const requestId of this.pendingRequests.keys()) {
      if (!this.nonBlockingRequestIds.has(requestId)) {
        return false;
      }
    }
    return this.pendingTurns.size === 0 && this.completingTurns === 0 && this.goalWatchers.size === 0;
  }

  private async waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        reject(new Error(`Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`));
      }, CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      this.idleWaiters.add(waiter);
    });
  }

  private notifyIdleWaitersIfIdle(): void {
    if (!this.isIdle() || this.idleWaiters.size === 0) {
      return;
    }

    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private finishCompletingTurn(): void {
    this.completingTurns = Math.max(0, this.completingTurns - 1);
    this.notifyIdleWaitersIfIdle();
  }

  private resetChildState(): void {
    this.child = null;
    this.initializePromise = null;
    this.initializeKey = null;
    this.lineBuffer = "";
    this.stderrTail = "";
    this.stderrSeenChars = 0;
    this.stdoutDiagnosticTail = "";
    this.lastRequestDiagnostic = null;
    this.lastResponseDiagnostic = null;
    this.lastNotificationDiagnostic = null;
    this.lastTurnActivityDiagnostic = null;
  }

  private appendDiagnostic(channel: "stderr" | "stdout", chunk: string): void {
    const normalized = chunk.trim();
    if (!normalized) {
      return;
    }

    if (channel === "stderr") {
      this.stderrSeenChars += this.stderrTail ? normalized.length + 1 : normalized.length;
      this.stderrTail = this.appendTail(this.stderrTail, normalized);
      return;
    }

    this.stdoutDiagnosticTail = this.appendTail(this.stdoutDiagnosticTail, normalized);
  }

  private looksLikeJsonRpcLine(value: string): boolean {
    return /^\s*\{\s*(?:"jsonrpc"\s*:|"id"\s*:|"method"\s*:)/.test(value);
  }

  private appendOversizedStdoutDiagnostic(value: string): void {
    const suffix = value.slice(-MAX_DIAGNOSTIC_CHARS);
    this.appendDiagnostic(
      "stdout",
      `omitted oversized non-JSON stdout diagnostic (${value.length} chars):\n${suffix}`,
    );
  }

  private appendTail(existing: string, chunk: string): string {
    const next = existing ? `${existing}\n${chunk}` : chunk;
    return next.length > MAX_DIAGNOSTIC_CHARS
      ? next.slice(next.length - MAX_DIAGNOSTIC_CHARS)
      : next;
  }

  /** Stderr produced after the given stderrSeenChars offset (bounded by the
   * retained tail). Turn-scoped failures use this so stale pre-turn stderr
   * (e.g. an old "Reconnecting... 2/5" or 401 line) is not attributed to them. */
  private stderrTailSince(offset: number): string {
    const newChars = this.stderrSeenChars - offset;
    if (newChars <= 0) {
      return "";
    }
    return newChars >= this.stderrTail.length
      ? this.stderrTail
      : this.stderrTail.slice(this.stderrTail.length - newChars);
  }

  private withDiagnostics(message: string, stderrOffset?: number): Error {
    if (message.includes("[engine diagnostics]")) {
      return new Error(message);
    }

    const stderrTail = stderrOffset === undefined ? this.stderrTail : this.stderrTailSince(stderrOffset);
    const sections: string[] = [];
    if (stderrTail) {
      sections.push(`stderr:\n${stderrTail}`);
    }
    if (this.stdoutDiagnosticTail) {
      sections.push(`stdout:\n${this.stdoutDiagnosticTail}`);
    }

    if (sections.length === 0) {
      return new Error(message);
    }

    return new Error(`${message}\n\n[engine diagnostics]\n${sections.join("\n\n")}`);
  }

  private withAppServerState(message: string, threadId?: string, pending?: PendingTurn): string {
    if (message.includes("[app-server state]")) {
      return message;
    }

    return `${message}\n\n[app-server state]\n${this.renderAppServerState(threadId, pending)}`;
  }

  private renderAppServerState(threadId?: string, pending?: PendingTurn): string {
    const now = Date.now();
    const pendingRequests = [...this.pendingRequests.entries()]
      .map(([id, request]) => {
        const parts = [
          `id=${id}`,
          `method=${request.method}`,
          request.threadId ? `threadId=${request.threadId}` : null,
          `ageMs=${Math.max(0, now - request.createdAt)}`,
        ].filter(Boolean);
        return parts.join(" ");
      });

    return [
      pending && threadId
        ? `pending turn: threadId=${threadId} ageMs=${Math.max(0, now - pending.startedAt)} lastActivity=${pending.lastActivityAt ? `${new Date(pending.lastActivityAt).toISOString()} method=${pending.lastActivityMethod ?? "unknown"}` : "none"} lastInactivity=${pending.lastInactivityAt ? new Date(pending.lastInactivityAt).toISOString() : "none"}`
        : "pending turn: none",
      `last request: ${this.formatProtocolDiagnostic(this.lastRequestDiagnostic)}`,
      `last response: ${this.formatProtocolDiagnostic(this.lastResponseDiagnostic)}`,
      `last notification: ${this.formatProtocolDiagnostic(this.lastNotificationDiagnostic)}`,
      `last turn activity: ${this.formatProtocolDiagnostic(this.lastTurnActivityDiagnostic)}`,
      `pending requests: ${pendingRequests.length > 0 ? pendingRequests.join(", ") : "none"}`,
    ].join("\n");
  }

  private formatProtocolDiagnostic(entry: AppServerProtocolDiagnostic | null): string {
    if (!entry) {
      return "none";
    }

    const parts = [
      new Date(entry.at).toISOString(),
      typeof entry.id === "number" ? `id=${entry.id}` : null,
      `method=${entry.method}`,
      entry.threadId ? `threadId=${entry.threadId}` : null,
      entry.status ? `status=${entry.status}` : null,
      `childGeneration=${entry.childGeneration}`,
    ].filter(Boolean);
    return parts.join(" ");
  }

  private createRequestTimeoutError(method: string, message: string, childGeneration: number): Error {
    const withDiagnostics = this.withDiagnostics(this.withAppServerState(message)).message;
    if (method === "thread/start" || method === "thread/resume") {
      return new ThreadReadTimeoutError(withDiagnostics, childGeneration);
    }
    return new CodexAppServerRequestTimeoutError(withDiagnostics, childGeneration);
  }
}
