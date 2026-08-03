import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { createClaudeInstructionsFile, type ClaudeInstructionsFile } from "./claude-instructions-file.js";
import { ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS } from "./engine-timeouts.js";
// Use the shared kill helper (SIGTERM then grace + SIGKILL escalation) rather
// than a local SIGTERM-only copy, so a Claude CLI (and its MCP/sandbox children)
// that ignores SIGTERM is still force-killed — matching the other adapters.
import { killProcessTree } from "./process-tree.js";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
  CodexUserMessageInput,
} from "./adapter.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile } from "../telegram/instance-config.js";
import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on?(event: "error", listener: (error: Error) => void): void;
};

type ClaudeChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  api_error_status?: string | number | null;
  terminal_reason?: string;
  request_id?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  output_file?: string;
  origin?: {
    kind?: string;
  } | null;
  request?: {
    subtype?: string;
    tool_name?: string;
    toolName?: string;
    input?: unknown;
    tool_input?: unknown;
    toolInput?: unknown;
    cwd?: string;
    permission_suggestions?: unknown[];
    permissionSuggestions?: unknown[];
  };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      id?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
};

type PendingTurn = {
  turnId: number;
  assistantText: string;
  intermediateDeliveryText: string;
  resolve: (value: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  approvalAbortController: AbortController;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  /** Inactivity watchdog (see armTurnInactivityWatchdog); re-armed on every byte
   * the worker emits, so it only fires when the CLI has gone completely silent. */
  timeout?: ReturnType<typeof setTimeout>;
  /** `/timeout off` (input.disableRuntimeTimeout) — no watchdog for this turn. */
  inactivityTimeoutDisabled?: boolean;
  /** Tool calls started by this turn that have not reported a result yet. A turn
   * with outstanding tool work is still running, so the background-task settle
   * timer must not treat its silence as "finished". */
  outstandingToolUseIds: Set<string>;
  backgroundCompletionTimer?: ReturnType<typeof setTimeout>;
};

type ClaudeTaskNotificationMetadata = {
  taskId?: string;
  status?: string;
  summary?: string;
  outputFile?: string;
};

type ClaudeBackgroundTask = ClaudeTaskNotificationMetadata & {
  turnId?: number;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  lastSeenAt: number;
};

type ClaudeWorker = {
  child: ClaudeChildProcess;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  lineBuffer: string;
  stderrTail: string;
  currentSessionId: string | null;
  workspacePath: string | undefined;
  pendingTurn: PendingTurn | null;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  backgroundTasks: Map<string, ClaudeBackgroundTask>;
  pendingTaskNotification: ClaudeBackgroundTask | null;
  suppressNextTaskNotificationAssistant: boolean;
  lastActivityAt: number;
  instructions: string | null;
  instructionsFile: ClaudeInstructionsFile | null;
  approvalMode: ApprovalMode;
  engineOptionsKey: string;
  sessionApprovedKeys: Set<string>;
  pendingApprovalByKey: Map<string, Promise<EngineApprovalDecision>>;
};

const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
// A single stream-json event (e.g. a large tool_result from reading a big file)
// can legitimately exceed the 1 MiB line cap. Allow recognized stream-json lines
// to grow to this higher cap before aborting, matching the Codex adapters — only
// non-JSON runaway output hard-fails at MAX_LINE_BUFFER_BYTES.
const MAX_STRUCTURED_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_CHARS = 20_000;
// A cold Claude worker spawn costs ~5-7s before the first token (measured),
// which is the single biggest "bot feels slower than the CLI" factor — the
// operator's usage pattern is bursts separated by hours, so a 30min TTL made
// most comebacks pay the cold start. 2h keeps those warm while still bounding
// how long an idle worker's memory is held on a 16GB host.
const DEFAULT_IDLE_WORKER_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_BACKGROUND_TASK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const BACKGROUND_TASK_TURN_SETTLE_GRACE_MS = 1500;
// There is deliberately NO total-turn cap for Claude: long autonomous tasks
// (large refactors, image generation, /goal-style runs) are expected to run for
// hours and must not be cut off. The safety net is an INACTIVITY watchdog: a
// wedged CLI that emits nothing at all for this long is not working, and without
// it the turn never settles — holding the cross-process bridge session lock
// (stale only after 12h) and blocking every channel and cron turn on that
// session. `/timeout off` (disableRuntimeTimeout) disables it per turn.
export const CLAUDE_STREAM_INACTIVITY_TIMEOUT_MS = ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS;

function decodeProcessChunk(
  decoder: StringDecoder,
  chunk: Buffer | { toString(): string } | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();
}

let nextPendingTurnId = 0;

/** A plausible Claude stream-json event line (so a large-but-valid event isn't
 * hard-failed at the 1 MiB cap meant for non-JSON runaway output). */
function looksLikeClaudeStreamJsonLine(value: string): boolean {
  return /^\s*\{\s*"type"\s*:/.test(value);
}

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
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

function appendAssistantText(existing: string, next: string): string {
  if (!next) {
    return existing;
  }

  return existing ? `${existing}\n${next}` : next;
}

function renderBackgroundTaskTurnResult(metadata: ClaudeTaskNotificationMetadata, text?: string): string {
  const notificationText = text?.trim();
  if (notificationText) {
    return notificationText;
  }
  const summary = metadata.summary?.trim();
  if (summary) {
    return summary;
  }
  return `${renderBackgroundTaskHeader("en", metadata.status)}.`;
}

/**
 * Claude stream-json tool_result `content` is either a plain string or an array
 * of `{ type: "text", text }` (and occasionally other typed) blocks. Flatten it
 * into a single string so the Lark card can render the tool output.
 */
function flattenClaudeToolResultContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function extractDeliveryTags(text: string): string[] {
  return Array.from(text.matchAll(/\[send-(?:file|image):[^\]]+\]/g), (match) => match[0]);
}

function hasDeliveryTag(text: string): boolean {
  return /\[send-(?:file|image):[^\]]+\]/.test(text);
}

function isTaskNotificationResult(event: ClaudeStreamEvent): boolean {
  return event.type === "result" && event.origin?.kind === "task-notification";
}

function toTaskNotificationMetadata(event: ClaudeStreamEvent): ClaudeTaskNotificationMetadata {
  return {
    taskId: typeof event.task_id === "string" ? event.task_id : undefined,
    status: typeof event.status === "string" ? event.status : undefined,
    summary: typeof event.summary === "string" ? event.summary : undefined,
    outputFile: typeof event.output_file === "string" ? event.output_file : undefined,
  };
}

function mergeIntermediateDeliveryText(finalResult: string, intermediateDeliveryText: string): string {
  if (!intermediateDeliveryText) {
    return finalResult;
  }

  if (!finalResult) {
    return intermediateDeliveryText;
  }

  if (finalResult.includes(intermediateDeliveryText)) {
    return finalResult;
  }

  if (intermediateDeliveryText.includes(finalResult)) {
    return intermediateDeliveryText;
  }

  const finalDeliveryTags = new Set(extractDeliveryTags(finalResult));
  const intermediateDeliveryTags = extractDeliveryTags(intermediateDeliveryText);
  if (
    intermediateDeliveryTags.length > 0 &&
    intermediateDeliveryTags.every((tag) => finalDeliveryTags.has(tag))
  ) {
    return finalResult;
  }

  return appendAssistantText(intermediateDeliveryText, finalResult);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function toApprovalInput(parsed: ClaudeStreamEvent, sessionId: string | null): EngineApprovalRequest {
  const request = parsed.request ?? {};
  const toolName = request.tool_name ?? request.toolName;
  const toolInput = request.input ?? request.tool_input ?? request.toolInput ?? {};
  return {
    engine: "claude",
    toolName: typeof toolName === "string" && toolName.trim() ? toolName : "Unknown tool",
    toolInput,
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    sessionId: sessionId ?? undefined,
    permissionSuggestions: request.permission_suggestions ?? request.permissionSuggestions,
  };
}

function sessionApprovalKey(request: EngineApprovalRequest): string {
  return `${request.toolName}:${canonicalJson(request.toolInput)}`;
}

function renderPermissionResponse(decision: EngineApprovalDecision, originalInput: unknown): Record<string, unknown> {
  if (decision.behavior === "deny") {
    return {
      behavior: "deny",
      message: "Denied by the user.",
    };
  }

  return {
    behavior: "allow",
    updatedInput: decision.updatedInput ?? originalInput ?? {},
  };
}

function isAskUserQuestionRequest(request: EngineApprovalRequest): boolean {
  return request.toolName === "AskUserQuestion";
}

function renderClaudeStreamError(parsed: ClaudeStreamEvent, stderrTail: string): string {
  const result = parsed.result?.trim();
  if (result) {
    return result;
  }

  const stderr = stderrTail.trim();
  if (stderr) {
    return stderr;
  }

  const details = [
    parsed.api_error_status ? `api_error_status=${parsed.api_error_status}` : undefined,
    parsed.subtype ? `subtype=${parsed.subtype}` : undefined,
    parsed.terminal_reason ? `terminal_reason=${parsed.terminal_reason}` : undefined,
  ].filter(Boolean);

  return details.length > 0
    ? `Claude reported an error (${details.join(", ")})`
    : "Claude reported an error";
}

function renderClaudeStreamExitError(code: number | null, stderrTail: string): string {
  const stderr = stderrTail.trim();
  if (stderr) {
    return stderr;
  }

  return `claude stream session exited with code ${code}`;
}

export class ClaudeStreamAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = false;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;
  private readonly idleWorkerTtlMs: number;
  private readonly turnInactivityTimeoutMs: number | null;
  private readonly backgroundTaskMaxAgeMs: number;
  private readonly disallowedTools: string[];
  private readonly idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly workers = new Map<string, ClaudeWorker>();

  constructor(
    private readonly claudeExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnClaude;
      instructionsPath?: string;
      configPath?: string;
      workspacePath?: string;
      engineHomePath?: string;
      idleWorkerTtlMs?: number;
      idleSweepIntervalMs?: number;
      turnInactivityTimeoutMs?: number | null;
      backgroundTaskMaxAgeMs?: number;
      disallowedTools?: string[];
    },
  ) {
    this.childEnv = options?.childEnv ?? (() => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (options?.engineHomePath) {
        env.CLAUDE_CONFIG_DIR = options.engineHomePath;
      }
      return env;
    })();

    this.spawnClaude = options?.spawnFn ?? (spawn as unknown as SpawnClaude);
    this.instructionsPath = options?.instructionsPath;
    this.configPath = options?.configPath;
    this.workspacePath = options?.workspacePath;
    this.idleWorkerTtlMs = options?.idleWorkerTtlMs ?? DEFAULT_IDLE_WORKER_TTL_MS;
    this.turnInactivityTimeoutMs = options?.turnInactivityTimeoutMs === undefined
      ? CLAUDE_STREAM_INACTIVITY_TIMEOUT_MS
      : options.turnInactivityTimeoutMs;
    this.backgroundTaskMaxAgeMs = options?.backgroundTaskMaxAgeMs ?? DEFAULT_BACKGROUND_TASK_MAX_AGE_MS;
    this.disallowedTools = options?.disallowedTools ?? [];

    const sweepIntervalMs = options?.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    if (this.idleWorkerTtlMs > 0 && sweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => {
        this.reapIdleWorkers();
      }, sweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
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

  private async loadApprovalMode(): Promise<ApprovalMode> {
    if (!this.configPath) {
      return "normal";
    }

    // The shared validated reader tolerates a missing/corrupt file (it returns
    // {}), so absent-file behavior still falls back to DEFAULT_APPROVAL_MODE.
    const parsed = await readValidatedConfigFile(this.configPath);
    return normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
  }

  private async loadEngineOptions(): Promise<{ effort?: string; model?: string }> {
    if (!this.configPath) {
      return {};
    }

    // Go through the shared validated reader (readValidatedConfigFile →
    // sanitizeConfigCompatibility) like the other adapters, so a stale
    // incompatible effort (e.g. `effort:"ultra"` beside `engine:"claude"`)
    // never reaches the CLI as a raw --effort flag.
    const parsed = await readValidatedConfigFile(this.configPath);
    return {
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const agentInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const bridgeInstructions = input.instructions ?? null;
    const approvalMode = this.configPath ? await this.loadApprovalMode() : "normal";
    const engineOptions = this.configPath ? await this.loadEngineOptions() : {};
    const prompt = this.buildPrompt(input);
    const effectiveWorkspace = input.workspaceOverride ?? this.workspacePath;
    const worker = await this.getOrCreateWorker(sessionId, agentInstructions, bridgeInstructions, approvalMode, effectiveWorkspace, engineOptions);
    worker.onEngineEvent = input.onEngineEvent;

    const response = await this.sendTurn(worker, prompt, input);
    const nextSessionId = response.sessionId;
    if (nextSessionId && nextSessionId !== sessionId) {
      this.workers.delete(sessionId);
      this.workers.set(nextSessionId, worker);
      // Drop any other alias keys still pointing at this worker (earlier
      // re-keys of the same process), so the map stays bounded to one live key
      // per worker. removeWorker/reapIdleWorkers tolerate aliases either way.
      for (const [key, candidate] of this.workers.entries()) {
        if (candidate === worker && key !== nextSessionId) {
          this.workers.delete(key);
        }
      }
    }

    return {
      text: response.text,
      sessionId: nextSessionId && nextSessionId !== sessionId ? nextSessionId : undefined,
      // Usage must ride the return: dropping it made every Claude turn invisible
      // to /usage, budget enforcement, and telemetry (they all read result.usage).
      usage: response.usage,
    };
  }

  private buildPrompt(input: CodexUserMessageInput): string {
    const parts: string[] = [];
    parts.push(input.text);
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    return parts.join("\n");
  }

  private async getOrCreateWorker(sessionId: string, agentInstructions: string | null, bridgeInstructions: string | null, approvalMode: ApprovalMode, workspacePath: string | undefined, engineOptions?: { effort?: string; model?: string }): Promise<ClaudeWorker> {
    const combinedKey = combineInstructions(agentInstructions, bridgeInstructions);
    const optionsKey = `${engineOptions?.effort ?? ""}:${engineOptions?.model ?? ""}`;
    const existing = this.workers.get(sessionId);
    if (existing) {
      if (
        existing.instructions === combinedKey &&
        existing.approvalMode === approvalMode &&
        existing.engineOptionsKey === optionsKey &&
        existing.workspacePath === workspacePath
      ) {
        return existing;
      }

      if (existing.pendingTurn) {
        throw new Error("Cannot reconfigure Claude session while a turn is in flight");
      }
      // Sweep first: a background task whose completion notification never arrived
      // lingers for backgroundTaskMaxAgeMs (6h by default) and would otherwise
      // hard-block every /model, /effort, /approval or workspace change for that
      // whole window — the idle sweeper only prunes workers it visits.
      this.pruneExpiredBackgroundTasks(existing, Date.now());
      if (existing.backgroundTasks.size > 0) {
        const count = existing.backgroundTasks.size;
        // Phrased so classifyFailure() returns "engine-busy" instead of the
        // "engine runtime failed, restart the instance" engine-cli message: this
        // is a transient busy state, not a crash.
        throw new Error(
          `Claude session has ${count} background task${count === 1 ? "" : "s"} still running, so the new engine settings cannot be applied yet. ` +
          `Retry once ${count === 1 ? "it finishes" : "they finish"}, or send /reset to start a fresh session.`,
        );
      }

      const resumedSessionId = existing.currentSessionId ?? sessionId;
      killProcessTree(existing.child.pid);
      this.removeWorker(existing);
      sessionId = resumedSessionId;
    }

    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ];
    for (const toolName of this.disallowedTools) {
      args.push("--disallowedTools", toolName);
    }
    if (!isLogicalTelegramSessionId(sessionId)) {
      args.push("-r", sessionId);
    }
    if (approvalMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (approvalMode === "full-auto") {
      args.push("--permission-mode", "bypassPermissions");
    }
    if (engineOptions?.effort) {
      args.push("--effort", engineOptions.effort);
    }
    if (engineOptions?.model) {
      args.push("--model", engineOptions.model);
    }
    if (workspacePath) {
      args.push("--add-dir", workspacePath);
    }

    const instructionsFile = combinedKey ? await createClaudeInstructionsFile(combinedKey) : null;
    if (instructionsFile) {
      args.push("--append-system-prompt-file", instructionsFile.path);
    }

    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    let child: ClaudeChildProcess;
    try {
      child = this.spawnClaude(invocation.command, invocation.args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
        env: this.childEnv,
        cwd: workspacePath,
        windowsHide: true,
      });
    } catch (error) {
      await instructionsFile?.cleanup().catch(() => {});
      throw error;
    }

    const worker: ClaudeWorker = {
      child,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      lineBuffer: "",
      stderrTail: "",
      currentSessionId: isLogicalTelegramSessionId(sessionId) ? null : sessionId,
      workspacePath,
      pendingTurn: null,
      onEngineEvent: undefined,
      backgroundTasks: new Map(),
      pendingTaskNotification: null,
      suppressNextTaskNotificationAssistant: false,
      lastActivityAt: Date.now(),
      instructions: combinedKey,
      instructionsFile,
      approvalMode,
      engineOptionsKey: optionsKey,
      sessionApprovedKeys: new Set(),
      pendingApprovalByKey: new Map(),
    };

    child.stdout?.on("data", (chunk) => {
      this.markWorkerActivity(worker);
      this.handleStdout(worker, decodeProcessChunk(worker.stdoutDecoder, chunk));
    });

    child.stderr?.on("data", (chunk) => {
      this.markWorkerActivity(worker);
      // Claude stream-json emits structured events on stdout; stderr is only used on hard failure.
      worker.stderrTail = `${worker.stderrTail}${decodeProcessChunk(worker.stderrDecoder, chunk)}`.slice(-MAX_STDERR_TAIL_CHARS);
    });

    child.stdin?.on?.("error", (error) => {
      this.failWorker(worker, error);
      killProcessTree(worker.child.pid);
      this.removeWorker(worker);
    });

    child.once("error", (error) => {
      this.failWorker(worker, error);
    });

    child.once("close", (code) => {
      const trailingStdout = worker.stdoutDecoder.end();
      // Force the residual JSONL record through even when the CLI exits
      // without writing a final newline.
      this.handleStdout(worker, `${trailingStdout}\n`);
      const trailingStderr = worker.stderrDecoder.end();
      if (trailingStderr) {
        worker.stderrTail = `${worker.stderrTail}${trailingStderr}`.slice(-MAX_STDERR_TAIL_CHARS);
      }
      this.failWorker(worker, new Error(renderClaudeStreamExitError(code, worker.stderrTail)));
      this.removeWorker(worker);
    });

    this.workers.set(sessionId, worker);
    return worker;
  }

  private handleStdout(worker: ClaudeWorker, chunk: string): void {
    worker.lineBuffer += chunk;

    const lines = worker.lineBuffer.split(/\r?\n/);
    worker.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line.length > MAX_LINE_BUFFER_BYTES && this.abortOnOversizedLine(worker, line)) {
        return;
      }
      this.handleMessage(worker, line);
    }

    // The residual (still-incomplete) line: a large but valid stream-json event
    // may not have its newline yet — let it keep accumulating up to the higher
    // structured cap. Only non-JSON runaway output hard-fails at the 1 MiB cap.
    if (worker.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      this.abortOnOversizedLine(worker, worker.lineBuffer);
    }
  }

  /** Returns true (and fails+kills the worker) if `line` is over the hard limit
   * for its kind: non-stream-json over 1 MiB, or stream-json over 64 MiB. */
  private abortOnOversizedLine(worker: ClaudeWorker, line: string): boolean {
    const isStructured = looksLikeClaudeStreamJsonLine(line);
    if (!isStructured || line.length > MAX_STRUCTURED_LINE_BUFFER_BYTES) {
      this.failWorker(worker, new Error(isStructured
        ? "Engine structured output exceeded maximum buffer size"
        : "Engine output exceeded maximum buffer size"));
      killProcessTree(worker.child.pid);
      return true;
    }
    return false;
  }

  private handleMessage(worker: ClaudeWorker, line: string): void {
    let parsed: ClaudeStreamEvent;
    try {
      parsed = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return;
    }

    if (parsed.session_id) {
      const owner = this.workers.get(parsed.session_id);
      if (owner && owner !== worker) {
        const error = new Error(`Claude session ${parsed.session_id} is already owned by another live worker`);
        this.failWorker(worker, error);
        killProcessTree(worker.child.pid);
        this.removeWorker(worker);
        return;
      }
      worker.currentSessionId = parsed.session_id;
      // Keep the logical alias until sendUserMessage returns, but publish the
      // real session id immediately. A second surface can now find this worker
      // during the first turn instead of spawning another CLI against the same
      // Claude session file.
      this.workers.set(parsed.session_id, worker);
    }
    const eventSeenAt = Date.now();

    if (parsed.type === "system" && parsed.subtype === "task_started") {
      const metadata = toTaskNotificationMetadata(parsed);
      if (metadata.taskId) {
        worker.backgroundTasks.set(metadata.taskId, {
          ...metadata,
          ...(worker.pendingTurn ? { turnId: worker.pendingTurn.turnId } : {}),
          onEngineEvent: worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent,
          lastSeenAt: eventSeenAt,
        });
        // Surface the start on the timeline: the deferred-restart busy guard
        // pairs this against the task_notification terminal event, so a
        // restart no longer fires while background work is still running.
        this.emitEngineEvent(worker, {
          type: "background_task_started",
          taskId: metadata.taskId,
          sessionId: worker.currentSessionId ?? undefined,
          ...(metadata.summary ? { description: metadata.summary } : {}),
        }, worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent);
      }
      return;
    }

    if (parsed.type === "system" && parsed.subtype === "task_notification") {
      const metadata = toTaskNotificationMetadata(parsed);
      const task = metadata.taskId ? worker.backgroundTasks.get(metadata.taskId) : undefined;
      worker.pendingTaskNotification = {
        ...task,
        ...metadata,
        onEngineEvent: task?.onEngineEvent ?? worker.onEngineEvent,
        lastSeenAt: eventSeenAt,
      };
      return;
    }

    if (isTaskNotificationResult(parsed)) {
      const resultMetadata = toTaskNotificationMetadata(parsed);
      const resultTask = resultMetadata.taskId ? worker.backgroundTasks.get(resultMetadata.taskId) : undefined;
      const taskId = resultMetadata.taskId ?? worker.pendingTaskNotification?.taskId ?? resultTask?.taskId;
      const metadata = {
        taskId,
        status: resultMetadata.status ?? worker.pendingTaskNotification?.status ?? resultTask?.status,
        summary: resultMetadata.summary ?? worker.pendingTaskNotification?.summary ?? resultTask?.summary,
        outputFile: resultMetadata.outputFile ?? worker.pendingTaskNotification?.outputFile ?? resultTask?.outputFile,
        turnId: worker.pendingTaskNotification?.turnId ?? resultTask?.turnId,
        onEngineEvent: worker.pendingTaskNotification?.onEngineEvent ?? resultTask?.onEngineEvent ?? worker.onEngineEvent,
        lastSeenAt: eventSeenAt,
      };
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
      if (taskId) {
        worker.backgroundTasks.delete(taskId);
      }
      const text = renderBackgroundTaskTurnResult(metadata, parsed.result);
      if (text) {
        const settlesCurrentTurn = metadata.turnId !== undefined && worker.pendingTurn?.turnId === metadata.turnId;
        this.emitEngineEvent(worker, {
          type: "task_notification",
          text,
          sessionId: worker.currentSessionId ?? undefined,
          taskId,
          status: metadata.status,
          summary: metadata.summary,
          outputFile: metadata.outputFile,
          ...(settlesCurrentTurn ? { settlesCurrentTurn: true } : {}),
        }, metadata.onEngineEvent);
        this.armBackgroundTaskTurnSettlement(worker, metadata, text);
      }
      return;
    }

    // Only arm task-notification suppression when NO real turn is in flight.
    // Otherwise a mid-turn re-init (e.g. /compact re-initializes the session)
    // would arm the flag and swallow the FIRST assistant chunk of the resumed
    // turn. The pendingTurn init handler below covers the in-turn re-init case.
    if (parsed.type === "system" && parsed.subtype === "init" && worker.pendingTaskNotification && !worker.pendingTurn) {
      worker.suppressNextTaskNotificationAssistant = true;
      return;
    }

    if (parsed.type === "system" && parsed.subtype === "init" && worker.pendingTurn) {
      this.emitEngineEvent(worker, {
        type: "session",
        sessionId: worker.currentSessionId ?? undefined,
      });
      return;
    }

    if (parsed.type === "assistant" && worker.suppressNextTaskNotificationAssistant) {
      worker.suppressNextTaskNotificationAssistant = false;
      return;
    }

    if (parsed.type === "assistant" && worker.pendingTurn) {
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      const textParts: string[] = [];
      for (const item of parsed.message?.content ?? []) {
        if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking) {
          this.emitEngineEvent(worker, {
            type: "thinking",
            text: item.thinking,
            sessionId: worker.currentSessionId ?? undefined,
          });
          continue;
        }

        if (item.type === "tool_use") {
          if (typeof item.id === "string" && item.id) {
            // Tracked so a long SILENT tool call is not mistaken for a finished
            // turn by the background-task settle timer.
            worker.pendingTurn.outstandingToolUseIds.add(item.id);
          }
          this.emitEngineEvent(worker, {
            type: "tool_use",
            toolName: typeof item.name === "string" && item.name ? item.name : "Unknown tool",
            toolInput: item.input,
            ...(typeof item.id === "string" && item.id ? { toolUseId: item.id } : {}),
            sessionId: worker.currentSessionId ?? undefined,
          });
          continue;
        }

        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        }
      }
      const text = textParts.join("");
      if (text) {
        worker.pendingTurn.assistantText = appendAssistantText(worker.pendingTurn.assistantText, text);
        if (hasDeliveryTag(text)) {
          worker.pendingTurn.intermediateDeliveryText = appendAssistantText(worker.pendingTurn.intermediateDeliveryText, text);
        }
        worker.pendingTurn.onProgress?.(worker.pendingTurn.assistantText);
        this.emitEngineEvent(worker, {
          type: "assistant_text",
          text,
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      return;
    }

    if (parsed.type === "user" && worker.pendingTurn) {
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      for (const item of parsed.message?.content ?? []) {
        if (item.type !== "tool_result") {
          continue;
        }
        if (typeof item.tool_use_id === "string" && item.tool_use_id) {
          worker.pendingTurn.outstandingToolUseIds.delete(item.tool_use_id);
        }
        this.emitEngineEvent(worker, {
          type: "tool_result",
          ...(typeof item.tool_use_id === "string" && item.tool_use_id ? { toolUseId: item.tool_use_id } : {}),
          output: flattenClaudeToolResultContent(item.content),
          isError: item.is_error === true,
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      return;
    }

    if (parsed.type === "control_request") {
      if (worker.pendingTurn) {
        this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      }
      void this.handleControlRequest(worker, parsed);
      return;
    }

    if (parsed.type === "control_cancel_request") {
      return;
    }

    if (parsed.type === "result" && worker.pendingTurn) {
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      worker.suppressNextTaskNotificationAssistant = false;
      const pending = worker.pendingTurn;
      if (parsed.is_error) {
        worker.pendingTurn = null;
        this.markWorkerActivity(worker);
        this.clearPendingTurnTimeout(pending);
        const detail = parsed.result?.trim() || pending.assistantText.trim() || renderClaudeStreamError(parsed, worker.stderrTail);
        pending.reject(new Error(detail));
        return;
      }
      const text = parsed.result
        ? mergeIntermediateDeliveryText(parsed.result, pending.intermediateDeliveryText)
        : pending.assistantText;
      this.emitEngineEvent(worker, {
        type: "result",
        text,
        sessionId: worker.currentSessionId ?? undefined,
      });
      worker.pendingTurn = null;
      this.markWorkerActivity(worker);
      this.clearPendingTurnTimeout(pending);
      pending.resolve({
        text: text.trim() || "Claude completed the request.",
        sessionId: worker.currentSessionId ?? undefined,
        usage: parsed.usage
          ? {
              inputTokens: parsed.usage.input_tokens ?? 0,
              outputTokens: parsed.usage.output_tokens ?? 0,
              cachedTokens: parsed.usage.cache_read_input_tokens,
              costUsd: parsed.total_cost_usd,
            }
          : undefined,
      });
      return;
    }

    if (parsed.type === "result") {
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
    }
  }

  private armBackgroundTaskTurnSettlement(
    worker: ClaudeWorker,
    metadata: ClaudeTaskNotificationMetadata & { turnId?: number },
    text?: string,
  ): void {
    const pending = worker.pendingTurn;
    if (!pending || metadata.turnId === undefined || metadata.turnId !== pending.turnId) {
      return;
    }
    this.clearBackgroundTaskTurnSettlement(pending);
    const resultText = renderBackgroundTaskTurnResult(metadata, text);
    pending.backgroundCompletionTimer = setTimeout(() => {
      if (worker.pendingTurn !== pending) {
        return;
      }
      // The turn is only "finished" if it has no tool call still running. Any
      // event clears this timer, so the dangerous case is a LONG SILENT tool call:
      // settling there would resolve the turn with the background task's text and
      // throw away the real answer (and its usage) that arrives seconds later.
      // A turn that produced no assistant text of its own has nothing to lose, so
      // the background task result is still its answer.
      if (pending.outstandingToolUseIds.size > 0 && pending.assistantText.trim()) {
        return;
      }
      worker.pendingTurn = null;
      this.markWorkerActivity(worker);
      this.clearPendingTurnTimeout(pending);
      this.emitEngineEvent(worker, {
        type: "result",
        text: resultText,
        sessionId: worker.currentSessionId ?? undefined,
      }, pending.onEngineEvent);
      pending.resolve({
        text: resultText,
        sessionId: worker.currentSessionId ?? undefined,
      });
    }, BACKGROUND_TASK_TURN_SETTLE_GRACE_MS);
    pending.backgroundCompletionTimer.unref?.();
  }

  private clearBackgroundTaskTurnSettlement(pending: PendingTurn | null | undefined): void {
    if (pending?.backgroundCompletionTimer) {
      clearTimeout(pending.backgroundCompletionTimer);
      pending.backgroundCompletionTimer = undefined;
    }
  }

  private async handleControlRequest(worker: ClaudeWorker, parsed: ClaudeStreamEvent): Promise<void> {
    const requestId = parsed.request_id;
    const pending = worker.pendingTurn;
    if (!requestId) {
      return;
    }

    const request = toApprovalInput(parsed, worker.currentSessionId);
    if (request.abortSignal === undefined && pending?.approvalAbortController) {
      request.abortSignal = pending.approvalAbortController.signal;
    }

    const toolInput = parsed.request?.input ?? parsed.request?.tool_input ?? parsed.request?.toolInput ?? {};
    this.emitEngineEvent(worker, {
      type: "permission_request",
      toolName: request.toolName,
      toolInput: request.toolInput,
      sessionId: worker.currentSessionId ?? undefined,
    });
    let decision: EngineApprovalDecision;
    if (isAskUserQuestionRequest(request)) {
      if (!pending?.onApprovalRequest) {
        decision = { behavior: "deny" };
      } else {
        try {
          decision = await pending.onApprovalRequest(request);
        } catch {
          decision = { behavior: "deny" };
        }
      }
    } else if (worker.approvalMode !== "normal") {
      decision = { behavior: "allow", scope: "session" };
    } else if (!pending?.onApprovalRequest) {
      decision = { behavior: "deny" };
    } else {
      const key = sessionApprovalKey(request);
      if (worker.sessionApprovedKeys.has(key)) {
        decision = { behavior: "allow", scope: "session" };
      } else {
        try {
          const inFlight = worker.pendingApprovalByKey.get(key);
          if (inFlight) {
            decision = await inFlight;
          } else {
            const decisionPromise = pending.onApprovalRequest(request);
            worker.pendingApprovalByKey.set(key, decisionPromise);
            try {
              decision = await decisionPromise;
            } finally {
              if (worker.pendingApprovalByKey.get(key) === decisionPromise) {
                worker.pendingApprovalByKey.delete(key);
              }
            }
          }
          if (decision.behavior === "allow" && decision.scope === "session") {
            worker.sessionApprovedKeys.add(key);
          }
        } catch {
          decision = { behavior: "deny" };
        }
      }
    }

    this.writeJson(worker, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: renderPermissionResponse(decision, toolInput),
      },
    });
  }

  private async sendTurn(worker: ClaudeWorker, prompt: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    if (worker.pendingTurn) {
      throw new Error("Claude session already has an in-flight turn");
    }

    return await new Promise<CodexAdapterResponse>((resolve, reject) => {
      this.markWorkerActivity(worker);
      const pendingTurn: PendingTurn = {
        turnId: ++nextPendingTurnId,
        assistantText: "",
        intermediateDeliveryText: "",
        onProgress: input.onProgress,
        onApprovalRequest: input.onApprovalRequest,
        onEngineEvent: input.onEngineEvent,
        approvalAbortController: new AbortController(),
        inactivityTimeoutDisabled: input.disableRuntimeTimeout === true,
        outstandingToolUseIds: new Set<string>(),
        resolve,
        reject,
      };
      worker.pendingTurn = pendingTurn;
      worker.stderrTail = "";
      // Start the inactivity watchdog now: a CLI that wedges before emitting its
      // first event must still settle the turn instead of holding the session lock.
      this.armTurnInactivityWatchdog(worker);

      if (input.abortSignal) {
        const onAbort = () => {
          killProcessTree(worker.child.pid);
          this.failWorker(worker, new Error("Task was stopped by user"));
          this.removeWorker(worker);
        };
        if (input.abortSignal.aborted) { onAbort(); return; }
        pendingTurn.abortSignal = input.abortSignal;
        pendingTurn.abortHandler = onAbort;
        input.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      worker.child.stdin?.write(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        }) + "\n",
        (error) => {
          if (error) {
            this.clearPendingTurnTimeout(worker.pendingTurn);
            worker.pendingTurn = null;
            // Kill before forgetting the worker — removeWorker only drops the map
            // entry, so without this a child orphaned by a broken stdin pipe is
            // untracked and never reaped.
            killProcessTree(worker.child.pid);
            this.removeWorker(worker);
            reject(error);
          }
        },
      );
    });
  }

  private writeJson(worker: ClaudeWorker, payload: unknown): void {
    this.markWorkerActivity(worker);
    worker.child.stdin?.write(JSON.stringify(payload) + "\n", (error) => {
      if (error) {
        this.failWorker(worker, error);
        killProcessTree(worker.child.pid);
        this.removeWorker(worker);
      }
    });
  }

  private emitEngineEvent(
    worker: ClaudeWorker,
    event: EngineStreamEvent,
    handlerOverride?: (event: EngineStreamEvent) => void | Promise<void>,
  ): void {
    const handler = handlerOverride ?? worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent;
    if (!handler) {
      return;
    }

    try {
      void Promise.resolve(handler(event)).catch(() => undefined);
    } catch {
      // Event delivery is best-effort; it must not break the engine turn.
    }
  }

  destroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    for (const worker of this.workers.values()) {
      killProcessTree(worker.child.pid);
      if (worker.pendingTurn) {
        this.clearPendingTurnTimeout(worker.pendingTurn);
        worker.pendingTurn.reject(new Error("Adapter destroyed"));
        worker.pendingTurn = null;
      }
    }
    this.workers.clear();
  }

  private markWorkerActivity(worker: ClaudeWorker): void {
    worker.lastActivityAt = Date.now();
    // Any byte from the worker (stdout event, stderr line, our own write) proves
    // the CLI is alive, so the inactivity watchdog restarts from zero.
    this.armTurnInactivityWatchdog(worker);
  }

  /**
   * (Re)arms the per-turn INACTIVITY watchdog. Fires only when the worker has been
   * completely silent for turnInactivityTimeoutMs, in which case the CLI is wedged:
   * kill it and reject the turn with a message the failure classifier maps to
   * `engine-timeout` ("turn became inactive after N minutes"), so the user is told
   * the turn stalled and how to lift the cap instead of "restart the instance".
   */
  private armTurnInactivityWatchdog(worker: ClaudeWorker): void {
    const pending = worker.pendingTurn;
    const timeoutMs = this.turnInactivityTimeoutMs;
    if (!pending || pending.inactivityTimeoutDisabled || timeoutMs === null || timeoutMs <= 0) {
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }

    pending.timeout = setTimeout(() => {
      pending.timeout = undefined;
      if (worker.pendingTurn !== pending) {
        return;
      }

      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      const error = new Error(
        `Claude turn became inactive after ${minutes} minutes with no engine output; the wedged CLI was stopped. Send /timeout off before a genuinely long silent task.`,
      );
      killProcessTree(worker.child.pid);
      this.failWorker(worker, error);
      this.removeWorker(worker);
    }, timeoutMs);
    pending.timeout.unref?.();
  }

  private reapIdleWorkers(): void {
    const now = Date.now();
    const seen = new Set<ClaudeWorker>();
    for (const worker of this.workers.values()) {
      if (seen.has(worker)) {
        continue;
      }
      seen.add(worker);
      this.pruneExpiredBackgroundTasks(worker, now);
      if (worker.pendingTurn || worker.backgroundTasks.size > 0) {
        continue;
      }
      if (now - worker.lastActivityAt < this.idleWorkerTtlMs) {
        continue;
      }
      killProcessTree(worker.child.pid);
      this.removeWorker(worker);
    }
  }

  private pruneExpiredBackgroundTasks(worker: ClaudeWorker, now: number): void {
    if (this.backgroundTaskMaxAgeMs <= 0) {
      return;
    }

    for (const [taskId, task] of worker.backgroundTasks.entries()) {
      if (now - task.lastSeenAt >= this.backgroundTaskMaxAgeMs) {
        worker.backgroundTasks.delete(taskId);
      }
    }

    if (
      worker.pendingTaskNotification?.taskId &&
      !worker.backgroundTasks.has(worker.pendingTaskNotification.taskId)
    ) {
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
    }
  }

  private failWorker(worker: ClaudeWorker, error: Error): void {
    if (worker.pendingTurn) {
      const pending = worker.pendingTurn;
      worker.pendingTurn = null;
      this.clearPendingTurnTimeout(pending);
      pending.reject(error);
    }
  }

  private clearPendingTurnTimeout(pending: PendingTurn | null | undefined): void {
    this.clearBackgroundTaskTurnSettlement(pending);
    pending?.approvalAbortController.abort();
    if (pending?.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
      pending.abortHandler = undefined;
    }
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
  }

  private removeWorker(worker: ClaudeWorker): void {
    for (const [key, candidate] of this.workers.entries()) {
      if (candidate === worker) {
        this.workers.delete(key);
      }
    }
    void worker.instructionsFile?.cleanup().catch(() => {});
  }
}
