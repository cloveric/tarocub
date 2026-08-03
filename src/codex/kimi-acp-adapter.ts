import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type Stream,
  type ToolCallContent,
} from "@agentclientprotocol/sdk";

import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
  ExternalSessionInfo,
} from "./adapter.js";
import {
  ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS,
  ENGINE_DEFAULT_TURN_TIMEOUT_MS,
} from "./engine-timeouts.js";
import { killProcessTree } from "./process-tree.js";
import { syncKimiWorkspaceInstructions } from "./kimi-workspace.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { DEFAULT_KIMI_EFFORT, readValidatedConfigFile } from "../telegram/instance-config.js";
import { resolveSearchMcpServerInvocation } from "../search/search-mcp-server.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type KimiReadable = NodeJS.ReadableStream & {
  on(event: "data", listener: (chunk: Uint8Array | { toString(): string } | string) => void): KimiReadable;
  on(event: "end", listener: () => void): KimiReadable;
  on(event: "error", listener: (error: Error) => void): KimiReadable;
};

type KimiWritable = NodeJS.WritableStream & {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end?(callback?: () => void): void;
  destroy?(error?: Error): void;
};

export type KimiChildProcess = {
  pid?: number;
  stdin?: KimiWritable;
  stdout?: KimiReadable;
  stderr?: KimiReadable;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
};

export type SpawnKimi = (command: string, args: string[], options: SpawnOptions) => KimiChildProcess;

type PendingKimiTurn = {
  assistantText: string;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  approvalAbortController: AbortController;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  totalTimeout?: ReturnType<typeof setTimeout>;
  inactivityTimeout?: ReturnType<typeof setTimeout>;
  cancelGraceTimeout?: ReturnType<typeof setTimeout>;
  timeoutsDisabled: boolean;
  stopError?: Error;
  failurePromise: Promise<never>;
  rejectFailure: (error: Error) => void;
  interruptionPromise: Promise<never>;
  rejectInterruption: (error: Error) => void;
  eventChain: Promise<void>;
};

type KimiToolState = {
  toolCallId: string;
  toolName: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  latestContentText?: string;
  emittedUse: boolean;
  emittedResult: boolean;
};

type KimiWorker = {
  child: KimiChildProcess;
  connection: ClientSideConnection;
  requestedSessionId: string;
  currentSessionId: string | null;
  workspacePath: string;
  settingsKey: string;
  stderrTail: string;
  pendingTurn: PendingKimiTurn | null;
  tools: Map<string, KimiToolState>;
  lastActivityAt: number;
  removed: boolean;
  failurePromise: Promise<never>;
  rejectFailure: (error: Error) => void;
};

type KimiSessionResult = NewSessionResponse | LoadSessionResponse;

type KimiRuntimeOptions = {
  model?: string;
  effort?: string;
  mode?: "default" | "yolo" | "auto";
};

export const KIMI_ACP_TURN_TIMEOUT_MS = ENGINE_DEFAULT_TURN_TIMEOUT_MS;
export const KIMI_ACP_INACTIVITY_TIMEOUT_MS = ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS;
export const KIMI_ACP_INITIALIZE_TIMEOUT_MS = 30_000;
export const KIMI_ACP_CANCEL_GRACE_MS = 5_000;

const DEFAULT_IDLE_WORKER_TTL_MS = 2 * 60 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
const MAX_ACP_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_CHARS = 20_000;
const MAX_ERROR_LINE_PREVIEW_CHARS = 240;
const MAX_INSTRUCTIONS_CHARS = 100_000;
const MAX_LISTED_SESSIONS = 200;

type SyncWorkspaceInstructions = (workspacePath: string, instructions: string | null) => Promise<string>;

function combineInstructions(agentInstructions: string | null, bridgeInstructions: string | null): string | null {
  const parts = [agentInstructions, bridgeInstructions]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function instructionFingerprint(instructions: string | null): string {
  return createHash("sha256").update(instructions ?? "").digest("hex");
}

function resolveDefaultKimiMcpServers(): McpServer[] {
  const invocation = resolveSearchMcpServerInvocation();
  return [{
    name: "cctb_search",
    command: invocation.command,
    args: invocation.args,
    env: [],
  }];
}

function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z0-9_-]+(?:(?::|\.)[A-Za-z0-9_.-]+)?(?:\s|$)/.test(text.trimStart());
}

function kimiModeForApprovalMode(mode: ApprovalMode): KimiRuntimeOptions["mode"] {
  if (mode === "full-auto") {
    return "yolo";
  }
  if (mode === "bypass") {
    return "auto";
  }
  return "default";
}

function configOptionValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") {
    return [];
  }
  const values: string[] = [];
  for (const item of option.options) {
    if ("value" in item) {
      values.push(item.value);
      continue;
    }
    for (const grouped of item.options) {
      values.push(grouped.value);
    }
  }
  return values;
}

function findConfigOption(
  options: SessionConfigOption[],
  category: "model" | "thought_level" | "mode",
  fallbackId: string,
): SessionConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.id === fallbackId);
}

function parseKimiDefaultModel(configToml: string): string | undefined {
  for (const line of configToml.split(/\r?\n/)) {
    const doubleQuoted = line.match(/^\s*default_model\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
    if (doubleQuoted) {
      try {
        const parsed = JSON.parse(doubleQuoted[1]) as unknown;
        if (typeof parsed === "string" && parsed.trim()) {
          return parsed.trim();
        }
      } catch {
        return undefined;
      }
    }
    const singleQuoted = line.match(/^\s*default_model\s*=\s*'([^']*)'\s*(?:#.*)?$/);
    if (singleQuoted?.[1]?.trim()) {
      return singleQuoted[1].trim();
    }
  }
  return undefined;
}

function isLogicalSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
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

function stringifyOutput(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolContentText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item.type !== "content") {
      continue;
    }
    const block = item.content;
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function maybeParseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeKimiQuestionInput(request: RequestPermissionRequest, toolInput: unknown): unknown {
  const firstQuestion = (() => {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return undefined;
    }
    const questions = (toolInput as { questions?: unknown }).questions;
    const first = Array.isArray(questions) ? questions[0] : undefined;
    return first && typeof first === "object" && !Array.isArray(first)
      ? first as { question?: unknown; header?: unknown; options?: unknown }
      : undefined;
  })();
  const question = typeof firstQuestion?.question === "string" && firstQuestion.question.trim()
    ? firstQuestion.question.trim()
    : toolContentText(request.toolCall.content)?.trim() || "Choose an option.";
  const header = typeof firstQuestion?.header === "string" && firstQuestion.header.trim()
    ? firstQuestion.header.trim()
    : "Choice";
  const descriptions = new Map<string, string>();
  if (Array.isArray(firstQuestion?.options)) {
    for (const option of firstQuestion.options) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        continue;
      }
      const label = (option as { label?: unknown }).label;
      const description = (option as { description?: unknown }).description;
      if (typeof label === "string" && typeof description === "string" && description.trim()) {
        descriptions.set(label.trim().toLocaleLowerCase(), description.trim());
      }
    }
  }
  const seen = new Set<string>();
  const options = request.options.flatMap((option) => {
    if (option.kind !== "allow_once" && option.kind !== "allow_always") {
      return [];
    }
    const label = option.name.trim();
    const key = label.toLocaleLowerCase();
    if (!label || key === "skip" || seen.has(key)) {
      return [];
    }
    seen.add(key);
    const description = descriptions.get(key);
    return [{ label, ...(description ? { description } : {}) }];
  });
  return {
    questions: [{
      question,
      header,
      multi_select: false,
      options,
    }],
  };
}

function requestToolName(request: RequestPermissionRequest, state?: KimiToolState): string {
  return state?.toolName || request.toolCall.title || "Unknown tool";
}

function optionForKind(request: RequestPermissionRequest, kind: string) {
  return request.options.find((option) => option.kind === kind);
}

function firstAnswer(updatedInput: unknown): string | undefined {
  if (!updatedInput || typeof updatedInput !== "object" || Array.isArray(updatedInput)) {
    return undefined;
  }
  const answers = (updatedInput as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return undefined;
  }
  for (const value of Object.values(answers as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function renderPermissionResponse(
  request: RequestPermissionRequest,
  toolName: string,
  decision: EngineApprovalDecision,
): RequestPermissionResponse {
  if (decision.behavior === "allow") {
    if (toolName === "AskUserQuestion") {
      const answer = firstAnswer(decision.updatedInput);
      const selected = answer
        ? request.options.find((option) => option.name.trim().toLocaleLowerCase() === answer.toLocaleLowerCase())
        : undefined;
      if (selected) {
        return { outcome: { outcome: "selected", optionId: selected.optionId } };
      }
    } else {
      const selected = decision.scope === "session"
        ? optionForKind(request, "allow_always") ?? optionForKind(request, "allow_once")
        : optionForKind(request, "allow_once") ?? optionForKind(request, "allow_always");
      if (selected) {
        return { outcome: { outcome: "selected", optionId: selected.optionId } };
      }
    }
  }

  const rejected = optionForKind(request, "reject_once")
    ?? optionForKind(request, "reject_always")
    ?? request.options.find((option) => option.name.toLocaleLowerCase() === "skip");
  return rejected
    ? { outcome: { outcome: "selected", optionId: rejected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function usageFromPromptResult(result: PromptResponse): AdapterUsage | undefined {
  if (!result.usage) {
    return undefined;
  }
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(typeof result.usage.cachedReadTokens === "number"
      ? { cachedTokens: result.usage.cachedReadTokens }
      : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createBoundedAcpStream(
  stdout: KimiReadable,
  stdin: KimiWritable,
  onActivity: () => void,
): Stream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let settled = false;

  const readable = new ReadableStream<unknown>({
    start(controller) {
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          controller.error(error);
        }
      };
      const enqueueLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        if (Buffer.byteLength(trimmed, "utf8") > MAX_ACP_LINE_BYTES) {
          fail(new Error("Kimi ACP structured output exceeded maximum buffer size"));
          return;
        }
        try {
          controller.enqueue(JSON.parse(trimmed) as unknown);
        } catch {
          const preview = trimmed.slice(0, MAX_ERROR_LINE_PREVIEW_CHARS);
          fail(new Error(`Kimi ACP emitted invalid JSON: ${preview}`));
        }
      };

      stdout.on("data", (chunk) => {
        if (settled) {
          return;
        }
        onActivity();
        const bytes = typeof chunk === "string"
          ? encoder.encode(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : encoder.encode(chunk.toString());
        buffer += decoder.decode(bytes, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_ACP_LINE_BYTES) {
          fail(new Error("Kimi ACP structured output exceeded maximum buffer size"));
          return;
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          enqueueLine(line);
          if (settled) {
            return;
          }
        }
      });
      stdout.on("error", fail);
      stdout.on("end", () => {
        if (settled) {
          return;
        }
        const tail = buffer + decoder.decode();
        buffer = "";
        enqueueLine(tail);
        if (!settled) {
          settled = true;
          controller.close();
        }
      });
    },
  });

  const writable = new WritableStream<unknown>({
    write(message) {
      onActivity();
      return new Promise<void>((resolve, reject) => {
        stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    close() {
      stdin.end?.();
    },
    abort(reason) {
      stdin.destroy?.(reason instanceof Error ? reason : new Error(String(reason)));
    },
  });

  return { readable, writable } as Stream;
}

export class KimiAcpAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = false;

  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnKimi: SpawnKimi;
  private readonly workspacePath: string;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly engineHomePath: string | undefined;
  private readonly turnTimeoutMs: number | null;
  private readonly inactivityTimeoutMs: number | null;
  private readonly initializeTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly idleWorkerTtlMs: number;
  private readonly killProcessTreeFn: (pid: number | undefined) => void;
  private readonly mcpServers: McpServer[];
  private readonly syncWorkspaceInstructionsFn: SyncWorkspaceInstructions;
  private readonly workers = new Map<string, KimiWorker>();
  private readonly pendingWorkers = new Map<string, Promise<KimiWorker>>();
  private readonly idleSweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly kimiExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnKimi;
      workspacePath?: string;
      instructionsPath?: string;
      configPath?: string;
      engineHomePath?: string;
      turnTimeoutMs?: number | null;
      inactivityTimeoutMs?: number | null;
      initializeTimeoutMs?: number;
      cancelGraceMs?: number;
      idleWorkerTtlMs?: number;
      idleSweepIntervalMs?: number;
      killProcessTreeFn?: (pid: number | undefined) => void;
      mcpServers?: McpServer[];
      syncWorkspaceInstructionsFn?: SyncWorkspaceInstructions;
    },
  ) {
    this.childEnv = options?.childEnv ?? (() => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (options?.engineHomePath) {
        env.KIMI_CODE_HOME = options.engineHomePath;
      }
      return env;
    })();
    this.spawnKimi = options?.spawnFn ?? (spawn as unknown as SpawnKimi);
    this.workspacePath = path.resolve(options?.workspacePath ?? process.cwd());
    this.instructionsPath = options?.instructionsPath;
    this.configPath = options?.configPath;
    const homeDir = this.childEnv.HOME ?? this.childEnv.USERPROFILE;
    this.engineHomePath = options?.engineHomePath
      ?? this.childEnv.KIMI_CODE_HOME
      ?? (homeDir ? path.join(homeDir, ".kimi-code") : undefined);
    this.turnTimeoutMs = options?.turnTimeoutMs === undefined ? KIMI_ACP_TURN_TIMEOUT_MS : options.turnTimeoutMs;
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs === undefined
      ? KIMI_ACP_INACTIVITY_TIMEOUT_MS
      : options.inactivityTimeoutMs;
    this.initializeTimeoutMs = options?.initializeTimeoutMs ?? KIMI_ACP_INITIALIZE_TIMEOUT_MS;
    this.cancelGraceMs = options?.cancelGraceMs ?? KIMI_ACP_CANCEL_GRACE_MS;
    this.idleWorkerTtlMs = options?.idleWorkerTtlMs ?? DEFAULT_IDLE_WORKER_TTL_MS;
    this.killProcessTreeFn = options?.killProcessTreeFn ?? killProcessTree;
    this.mcpServers = options?.mcpServers ?? resolveDefaultKimiMcpServers();
    this.syncWorkspaceInstructionsFn = options?.syncWorkspaceInstructionsFn ?? syncKimiWorkspaceInstructions;

    const sweepIntervalMs = options?.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    if (this.idleWorkerTtlMs > 0 && sweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => this.reapIdleWorkers(), sweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async validateExternalSession(
    sessionId: string,
    input?: { workspaceOverride?: string },
  ): Promise<ExternalSessionInfo> {
    if (isLogicalSessionId(sessionId)) {
      throw new Error("A logical Kimi chat session cannot be resumed as an external session");
    }
    return await this.withControlConnection(async (connection, initialized) => {
      if (!initialized.agentCapabilities?.sessionCapabilities?.list) {
        throw new Error("This Kimi ACP version does not support session/list");
      }
      if (!initialized.agentCapabilities.loadSession) {
        throw new Error("This Kimi ACP version does not support session/load");
      }
      let cursor: string | null = null;
      let found: ExternalSessionInfo | undefined;
      do {
        const response = await connection.listSessions({ cwd: null, cursor });
        const matched = response.sessions.find((session) => session.sessionId === sessionId);
        if (matched) {
          found = {
            sessionId: matched.sessionId,
            cwd: matched.cwd,
            ...(matched.title ? { title: matched.title } : {}),
            ...(matched.updatedAt ? { updatedAt: matched.updatedAt } : {}),
          };
          break;
        }
        cursor = response.nextCursor ?? null;
      } while (cursor);
      if (!found) {
        throw new Error(`Kimi session not found: ${sessionId}`);
      }
      const workspacePath = path.resolve(input?.workspaceOverride ?? found.cwd);
      if (input?.workspaceOverride && path.resolve(found.cwd) !== workspacePath) {
        throw new Error(`Kimi session workspace mismatch: expected ${found.cwd}`);
      }
      await connection.loadSession({
        sessionId,
        cwd: workspacePath,
        mcpServers: [...this.mcpServers],
      });
      return found;
    });
  }

  async listExternalSessions(input?: { cwd?: string; limit?: number }): Promise<ExternalSessionInfo[]> {
    const requestedLimit = input?.limit;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit!), MAX_LISTED_SESSIONS))
      : MAX_LISTED_SESSIONS;
    return await this.withControlConnection(async (connection, initialized) => {
      if (!initialized.agentCapabilities?.sessionCapabilities?.list) {
        throw new Error("This Kimi ACP version does not support session/list");
      }
      const sessions: ExternalSessionInfo[] = [];
      let cursor: string | null = null;
      do {
        const response = await connection.listSessions({
          cwd: input?.cwd ? path.resolve(input.cwd) : null,
          cursor,
        });
        for (const session of response.sessions) {
          sessions.push({
            sessionId: session.sessionId,
            cwd: session.cwd,
            ...(session.title ? { title: session.title } : {}),
            ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
          });
          if (sessions.length >= limit) {
            return sessions;
          }
        }
        cursor = response.nextCursor ?? null;
      } while (cursor);
      return sessions;
    });
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const workspacePath = path.resolve(input.workspaceOverride ?? this.workspacePath);
    const agentInstructions = await this.loadInstructions();
    const instructions = combineInstructions(agentInstructions, input.instructions ?? null);
    const runtimeOptions = await this.loadRuntimeOptions();
    const preparedInstructions = await this.prepareInstructions(workspacePath, instructions);
    const worker = await this.getOrCreateWorker(
      sessionId,
      workspacePath,
      runtimeOptions,
      preparedInstructions.settingsKey,
    );
    if (worker.pendingTurn) {
      throw new Error("Kimi session already has an in-flight turn");
    }

    const actualSessionId = worker.currentSessionId;
    if (!actualSessionId) {
      throw new Error("Kimi ACP did not provide a session id");
    }
    const result = await this.runTurn(
      worker,
      actualSessionId,
      this.buildPrompt(input, preparedInstructions.promptInstructions),
      input,
    );
    this.rekeyWorker(worker, actualSessionId);
    return {
      text: result.text,
      ...(actualSessionId !== sessionId ? { sessionId: actualSessionId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  private buildPrompt(input: CodexUserMessageInput, instructions: string | null): string {
    const text = instructions && !isSlashCommand(input.text)
      ? [
          "[Bridge Instructions]",
          instructions,
          "[/Bridge Instructions]",
          "",
          "[User Message]",
          input.text,
        ].join("\n")
      : input.text;
    const parts = [text];
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    return parts.join("\n");
  }

  private async prepareInstructions(
    workspacePath: string,
    instructions: string | null,
  ): Promise<{ promptInstructions: string | null; settingsKey: string }> {
    if (workspacePath === this.workspacePath) {
      const synchronizedInstructions = await this.syncWorkspaceInstructionsFn(workspacePath, instructions);
      return {
        promptInstructions: null,
        settingsKey: `workspace-instructions:${instructionFingerprint(synchronizedInstructions)}`,
      };
    }
    return {
      promptInstructions: instructions,
      settingsKey: `prompt-instructions:${instructionFingerprint(instructions)}`,
    };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }
    try {
      const trimmed = (await readFile(this.instructionsPath, "utf8")).trim();
      if (!trimmed) {
        return null;
      }
      return trimmed.length <= MAX_INSTRUCTIONS_CHARS
        ? trimmed
        : `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch {
      return null;
    }
  }

  private async loadRuntimeOptions(): Promise<KimiRuntimeOptions> {
    if (!this.configPath) {
      return {};
    }
    const parsed = await readValidatedConfigFile(this.configPath);
    const approvalMode = normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
    return {
      model: typeof parsed.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : await this.loadDefaultModel(),
      effort: typeof parsed.effort === "string" ? parsed.effort : DEFAULT_KIMI_EFFORT,
      mode: kimiModeForApprovalMode(approvalMode),
    };
  }

  private async loadDefaultModel(): Promise<string | undefined> {
    if (!this.engineHomePath) {
      return undefined;
    }
    try {
      return parseKimiDefaultModel(await readFile(path.join(this.engineHomePath, "config.toml"), "utf8"));
    } catch {
      return undefined;
    }
  }

  private async getOrCreateWorker(
    sessionId: string,
    workspacePath: string,
    runtimeOptions: KimiRuntimeOptions,
    instructionSettingsKey = "",
  ): Promise<KimiWorker> {
    const settingsKey = JSON.stringify({ runtimeOptions, instructionSettingsKey });
    const existing = this.workers.get(sessionId);
    if (existing) {
      if (existing.workspacePath === workspacePath && existing.settingsKey === settingsKey) {
        return existing;
      }
      if (existing.pendingTurn) {
        throw new Error("Cannot reconfigure Kimi session while a turn is in flight");
      }
      const resumedSessionId = existing.currentSessionId ?? sessionId;
      this.killProcessTreeFn(existing.child.pid);
      this.removeWorker(existing);
      sessionId = resumedSessionId;
    }

    const pending = this.pendingWorkers.get(sessionId);
    if (pending) {
      return await pending;
    }

    const creation = this.createWorker(sessionId, workspacePath, runtimeOptions, settingsKey);
    this.pendingWorkers.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingWorkers.get(sessionId) === creation) {
        this.pendingWorkers.delete(sessionId);
      }
    }
  }

  private async createWorker(
    sessionId: string,
    workspacePath: string,
    runtimeOptions: KimiRuntimeOptions,
    settingsKey: string,
  ): Promise<KimiWorker> {
    const invocation = buildCommandInvocation(this.kimiExecutable, ["acp"]);
    const child = this.spawnKimi(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: workspacePath,
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      this.killProcessTreeFn(child.pid);
      throw new Error("Kimi ACP subprocess did not expose stdio pipes");
    }

    let rejectFailure!: (error: Error) => void;
    const failurePromise = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    void failurePromise.catch(() => undefined);

    let worker!: KimiWorker;
    const stream = createBoundedAcpStream(child.stdout, child.stdin, () => {
      if (worker) {
        this.markActivity(worker);
      }
    });
    const connection = new ClientSideConnection(() => ({
      requestPermission: async (request) => await this.handlePermissionRequest(worker, request),
      sessionUpdate: async (notification) => this.handleSessionUpdate(worker, notification),
    }), stream);
    worker = {
      child,
      connection,
      requestedSessionId: sessionId,
      currentSessionId: null,
      workspacePath,
      settingsKey,
      stderrTail: "",
      pendingTurn: null,
      tools: new Map(),
      lastActivityAt: Date.now(),
      removed: false,
      failurePromise,
      rejectFailure,
    };
    this.workers.set(sessionId, worker);

    child.stderr.on("data", (chunk) => {
      this.markActivity(worker);
      worker.stderrTail = `${worker.stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_TAIL_CHARS);
    });
    child.once("error", (error) => {
      this.failWorker(worker, this.withDiagnostics(worker, error));
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    });
    child.once("close", (code, signal) => {
      const suffix = signal ? ` (signal ${signal})` : "";
      this.failWorker(worker, this.withDiagnostics(worker, new Error(`Kimi ACP exited with code ${code}${suffix}`)));
      this.removeWorker(worker);
    });
    void connection.closed.then(() => {
      if (!worker.removed) {
        const reason = connection.signal.reason;
        const error = reason instanceof Error ? reason : new Error("Kimi ACP connection closed");
        if (worker.pendingTurn) {
          this.failWorker(worker, this.withDiagnostics(worker, error));
        }
        this.killProcessTreeFn(worker.child.pid);
        this.removeWorker(worker);
      }
    });

    try {
      const initialized = await withTimeout(
        Promise.race([
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "tarocub", version: "0.1.0" },
            clientCapabilities: {},
          }),
          worker.failurePromise,
        ]),
        this.initializeTimeoutMs,
        `Kimi ACP initialize timed out after ${this.initializeTimeoutMs}ms`,
      );
      this.validateInitializeResponse(initialized);

      let sessionResult: KimiSessionResult;
      if (isLogicalSessionId(sessionId)) {
        sessionResult = await withTimeout(
          Promise.race([
            connection.newSession({ cwd: workspacePath, mcpServers: [...this.mcpServers] }),
            worker.failurePromise,
          ]),
          this.initializeTimeoutMs,
          `Kimi ACP session/new timed out after ${this.initializeTimeoutMs}ms`,
        );
        worker.currentSessionId = (sessionResult as NewSessionResponse).sessionId;
      } else {
        if (initialized.agentCapabilities?.loadSession !== true) {
          throw new Error("This Kimi ACP version does not support session/load");
        }
        sessionResult = await withTimeout(
          Promise.race([
            connection.loadSession({ sessionId, cwd: workspacePath, mcpServers: [...this.mcpServers] }),
            worker.failurePromise,
          ]),
          this.initializeTimeoutMs,
          `Kimi ACP session/load timed out after ${this.initializeTimeoutMs}ms`,
        );
        worker.currentSessionId = sessionId;
      }
      if (!worker.currentSessionId) {
        throw new Error("Kimi ACP session/new returned no session id");
      }
      await this.applySessionConfigOptions(worker, sessionResult.configOptions ?? [], runtimeOptions);
      this.rekeyWorker(worker, worker.currentSessionId);
      return worker;
    } catch (error) {
      this.killProcessTreeFn(child.pid);
      this.removeWorker(worker);
      throw this.withDiagnostics(worker, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async withControlConnection<T>(
    operation: (connection: ClientSideConnection, initialized: InitializeResponse) => Promise<T>,
  ): Promise<T> {
    const invocation = buildCommandInvocation(this.kimiExecutable, ["acp"]);
    const child = this.spawnKimi(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.workspacePath,
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      this.killProcessTreeFn(child.pid);
      throw new Error("Kimi ACP subprocess did not expose stdio pipes");
    }

    let stderrTail = "";
    let rejectFailure!: (error: Error) => void;
    const failurePromise = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    void failurePromise.catch(() => undefined);
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_TAIL_CHARS);
    });
    child.once("error", (error) => rejectFailure(error));
    child.once("close", (code, signal) => {
      const suffix = signal ? ` (signal ${signal})` : "";
      rejectFailure(new Error(`Kimi ACP exited with code ${code}${suffix}`));
    });

    const stream = createBoundedAcpStream(child.stdout, child.stdin, () => undefined);
    const connection = new ClientSideConnection(() => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async () => undefined,
    }), stream);
    try {
      const initialized = await withTimeout(
        Promise.race([
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "tarocub", version: "0.1.0" },
            clientCapabilities: {},
          }),
          failurePromise,
        ]),
        this.initializeTimeoutMs,
        `Kimi ACP initialize timed out after ${this.initializeTimeoutMs}ms`,
      );
      this.validateInitializeResponse(initialized);
      return await withTimeout(
        Promise.race([operation(connection, initialized), failurePromise]),
        this.initializeTimeoutMs,
        `Kimi ACP control request timed out after ${this.initializeTimeoutMs}ms`,
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const stderr = stderrTail.trim();
      if (!stderr || normalized.message.includes(stderr)) {
        throw normalized;
      }
      throw new Error(`${normalized.message}\n\nKimi stderr:\n${stderr}`);
    } finally {
      this.killProcessTreeFn(child.pid);
    }
  }

  private async applySessionConfigOptions(
    worker: KimiWorker,
    initialOptions: SessionConfigOption[],
    requested: KimiRuntimeOptions,
  ): Promise<void> {
    const sessionId = worker.currentSessionId;
    if (!sessionId) {
      throw new Error("Kimi ACP did not provide a session id before configuration");
    }

    let options = initialOptions;
    const selections: Array<{
      label: string;
      category: "model" | "thought_level" | "mode";
      fallbackId: string;
      value: string | undefined;
    }> = [
      { label: "model", category: "model", fallbackId: "model", value: requested.model },
      { label: "effort", category: "thought_level", fallbackId: "thinking", value: requested.effort },
      { label: "approval mode", category: "mode", fallbackId: "mode", value: requested.mode },
    ];

    for (const selection of selections) {
      if (selection.value === undefined) {
        continue;
      }
      const option = findConfigOption(options, selection.category, selection.fallbackId);
      if (!option || option.type !== "select") {
        throw new Error(
          `Kimi ACP did not advertise a configurable ${selection.label}; update Kimi Code CLI or reset that override.`,
        );
      }
      const available = configOptionValues(option);
      if (!available.includes(selection.value)) {
        throw new Error(
          `Kimi does not advertise ${selection.label} ${selection.value}. Available values: ${available.join(", ") || "none"}.`,
        );
      }
      if (option.currentValue === selection.value) {
        continue;
      }
      const response = await withTimeout(
        Promise.race([
          worker.connection.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value: selection.value,
          }),
          worker.failurePromise,
        ]),
        this.initializeTimeoutMs,
        `Kimi ACP ${selection.label} configuration timed out after ${this.initializeTimeoutMs}ms`,
      );
      options = response.configOptions;
    }
  }

  private validateInitializeResponse(response: InitializeResponse): void {
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Kimi ACP negotiated unsupported protocol version ${String(response.protocolVersion)} (expected ${PROTOCOL_VERSION})`,
      );
    }
  }

  private async runTurn(
    worker: KimiWorker,
    sessionId: string,
    prompt: string,
    input: CodexUserMessageInput,
  ): Promise<{ text: string; usage?: AdapterUsage }> {
    let rejectFailure!: (error: Error) => void;
    const failurePromise = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    // A transport failure can race with the prompt's own rejection. Attach a
    // handler immediately so the losing branch never becomes unhandled.
    void failurePromise.catch(() => undefined);
    let rejectInterruption!: (error: Error) => void;
    const interruptionPromise = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    void interruptionPromise.catch(() => undefined);
    const pending: PendingKimiTurn = {
      assistantText: "",
      onProgress: input.onProgress,
      onApprovalRequest: input.onApprovalRequest,
      onEngineEvent: input.onEngineEvent,
      approvalAbortController: new AbortController(),
      timeoutsDisabled: input.disableRuntimeTimeout === true,
      failurePromise,
      rejectFailure,
      interruptionPromise,
      rejectInterruption,
      eventChain: Promise.resolve(),
    };
    // Synchronous re-check immediately before the assignment. The friendly
    // guard in sendUserMessage runs BEFORE an awaited engine event (Lark card
    // creation — a real network round-trip), and the bridge turn lock does not
    // fully close that window: during a chat's first turn the lock still keys
    // on the logical id while the kimi session id is already bound, so a
    // message arriving under the kimi-id key runs concurrently. Without this
    // check the second turn overwrites pendingTurn and the two turns' chunks
    // interleave on one ACP session.
    if (worker.pendingTurn) {
      throw new Error("Kimi session already has an in-flight turn");
    }
    worker.pendingTurn = pending;
    worker.tools.clear();
    worker.stderrTail = "";
    this.armTurnTimeouts(worker, pending);

    if (input.abortSignal) {
      const onAbort = () => this.requestStop(worker, pending, new Error("Task was stopped by user"));
      pending.abortSignal = input.abortSignal;
      pending.abortHandler = onAbort;
      if (input.abortSignal.aborted) {
        this.finishPendingTurn(worker, pending);
        throw new Error("Task was stopped by user");
      }
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      // Register the pending turn before delivering the session event. Lark may
      // perform network I/O in this callback; racing both failure channels
      // keeps /stop and runtime watchdogs effective even if that I/O wedges.
      await Promise.race([
        this.emitEngineEvent(pending.onEngineEvent, { type: "session", sessionId }),
        pending.failurePromise,
        pending.interruptionPromise,
      ]);
      const result = await Promise.race([
        worker.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        pending.failurePromise,
      ]);
      if (result.stopReason === "cancelled") {
        throw pending.stopError ?? new Error("Kimi ACP turn was cancelled");
      }
      if (result.stopReason !== "end_turn") {
        throw new Error(`Kimi ACP stopped the turn with reason ${result.stopReason}`);
      }
      // Raced against the failure promise: eventChain delivery is best-effort,
      // and with runtime timeouts disabled a hung onEngineEvent (e.g. a Lark
      // API call that never settles) would otherwise pin pendingTurn forever —
      // every later message then bounces off "already has an in-flight turn".
      await Promise.race([
        pending.eventChain,
        pending.failurePromise,
        pending.interruptionPromise,
      ]);
      const text = pending.assistantText.trim() || "Kimi completed the request.";
      await Promise.race([
        this.emitEngineEvent(pending.onEngineEvent, { type: "result", text, sessionId }),
        pending.failurePromise,
        pending.interruptionPromise,
      ]);
      return { text, usage: usageFromPromptResult(result) };
    } catch (error) {
      const effectiveError = pending.stopError ?? (error instanceof Error ? error : new Error(String(error)));
      throw this.withDiagnostics(worker, effectiveError);
    } finally {
      this.finishPendingTurn(worker, pending);
    }
  }

  private handleSessionUpdate(worker: KimiWorker, notification: SessionNotification): void {
    this.markActivity(worker);
    // Replayed history (session/load) arrives while no turn is pending — the
    // null check drops it. session/load only ever runs during worker creation
    // or pre-binding validation, both of which hold no pending turn; a separate
    // replayingHistory flag existed but was unreachable defense the tests could
    // not exercise, so it was removed rather than kept untestable.
    if (!worker.pendingTurn) {
      return;
    }
    const pending = worker.pendingTurn;
    const update = notification.update;
    const sessionId = worker.currentSessionId ?? notification.sessionId;

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text" || !update.content.text) {
        return;
      }
      pending.assistantText += update.content.text;
      pending.onProgress?.(pending.assistantText);
      this.queueEngineEvent(pending, {
        type: "assistant_text",
        text: update.content.text,
        delta: true,
        sessionId,
      });
      return;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.queueEngineEvent(pending, {
          type: "thinking",
          text: update.content.text,
          sessionId,
        });
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      const state: KimiToolState = {
        toolCallId: update.toolCallId,
        toolName: update.title || "Unknown tool",
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        latestContentText: toolContentText(update.content),
        emittedUse: false,
        emittedResult: false,
      };
      worker.tools.set(update.toolCallId, state);
      this.maybeEmitToolUse(worker, state);
      if (update.status === "completed" || update.status === "failed") {
        this.emitToolResult(worker, state, update.status === "failed");
      }
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      const state = worker.tools.get(update.toolCallId) ?? {
        toolCallId: update.toolCallId,
        toolName: update.title || "Unknown tool",
        emittedUse: false,
        emittedResult: false,
      };
      if (update.title) {
        state.toolName = state.toolName === "Unknown tool" ? update.title : state.toolName;
      }
      if (update.rawInput !== undefined) {
        state.rawInput = update.rawInput;
      }
      if (update.rawOutput !== undefined) {
        state.rawOutput = update.rawOutput;
      }
      const contentText = toolContentText(update.content);
      if (contentText !== undefined) {
        state.latestContentText = contentText;
      }
      worker.tools.set(update.toolCallId, state);
      this.maybeEmitToolUse(worker, state);
      if (update.status === "completed" || update.status === "failed") {
        this.emitToolResult(worker, state, update.status === "failed");
      }
    }
  }

  private maybeEmitToolUse(worker: KimiWorker, state: KimiToolState): void {
    if (state.emittedUse) {
      return;
    }
    if (state.rawInput === undefined) {
      state.rawInput = maybeParseJson(state.latestContentText);
    }
    if (state.rawInput === undefined) {
      return;
    }
    state.emittedUse = true;
    const pending = worker.pendingTurn;
    if (!pending) {
      return;
    }
    this.queueEngineEvent(pending, {
      type: "tool_use",
      toolName: state.toolName,
      toolInput: state.rawInput,
      toolUseId: state.toolCallId,
      sessionId: worker.currentSessionId ?? undefined,
    });
  }

  private emitToolResult(worker: KimiWorker, state: KimiToolState, isError: boolean): void {
    if (state.emittedResult) {
      return;
    }
    this.maybeEmitToolUse(worker, state);
    state.emittedResult = true;
    const pending = worker.pendingTurn;
    if (!pending) {
      return;
    }
    this.queueEngineEvent(pending, {
      type: "tool_result",
      toolUseId: state.toolCallId,
      toolName: state.toolName,
      output: stringifyOutput(state.rawOutput) ?? state.latestContentText,
      isError,
      sessionId: worker.currentSessionId ?? undefined,
    });
  }

  private async handlePermissionRequest(
    worker: KimiWorker,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.markActivity(worker);
    const pending = worker.pendingTurn;
    if (!pending) {
      return { outcome: { outcome: "cancelled" } };
    }
    const state = worker.tools.get(request.toolCall.toolCallId);
    if (state) {
      this.maybeEmitToolUse(worker, state);
    }
    // Both awaits below race the failure promise: an unanswered ACP
    // session/request_permission wedges the CLI, so eviction (stop/timeout/
    // destroy) must be able to unblock this handler and let it answer.
    await Promise.race([
      pending.eventChain,
      pending.failurePromise.catch(() => undefined),
      pending.interruptionPromise.catch(() => undefined),
    ]);
    const toolName = requestToolName(request, state);
    const rawToolInput = state?.rawInput ?? maybeParseJson(state?.latestContentText) ?? {};
    const toolInput = toolName === "AskUserQuestion"
      ? normalizeKimiQuestionInput(request, rawToolInput)
      : rawToolInput;
    this.queueEngineEvent(pending, {
      type: "permission_request",
      toolName,
      toolInput,
      sessionId: worker.currentSessionId ?? request.sessionId,
    });
    await Promise.race([
      pending.eventChain,
      pending.failurePromise.catch(() => undefined),
      pending.interruptionPromise.catch(() => undefined),
    ]);

    const approvalRequest: EngineApprovalRequest = {
      engine: "kimi",
      toolName,
      toolInput,
      cwd: worker.workspacePath,
      sessionId: worker.currentSessionId ?? request.sessionId,
      abortSignal: pending.approvalAbortController.signal,
      permissionSuggestions: request.options,
    };
    let decision: EngineApprovalDecision = { behavior: "deny" };
    if (pending.onApprovalRequest) {
      const denyOnFailure = (): EngineApprovalDecision => ({ behavior: "deny" });
      decision = await Promise.race([
        pending.onApprovalRequest(approvalRequest).catch(denyOnFailure),
        pending.failurePromise.catch(denyOnFailure),
        pending.interruptionPromise.catch(denyOnFailure),
      ]);
    }
    return renderPermissionResponse(request, toolName, decision);
  }

  private armTurnTimeouts(worker: KimiWorker, pending: PendingKimiTurn): void {
    if (pending.timeoutsDisabled) {
      return;
    }
    if (this.turnTimeoutMs !== null && this.turnTimeoutMs > 0) {
      pending.totalTimeout = setTimeout(() => {
        const minutes = Math.max(1, Math.round(this.turnTimeoutMs! / 60_000));
        this.requestStop(worker, pending, new Error(`Kimi ACP turn timed out after ${minutes} minutes`));
      }, this.turnTimeoutMs);
      pending.totalTimeout.unref?.();
    }
    this.armInactivityTimeout(worker, pending);
  }

  private armInactivityTimeout(worker: KimiWorker, pending: PendingKimiTurn): void {
    if (
      pending.stopError
      || pending.timeoutsDisabled
      || this.inactivityTimeoutMs === null
      || this.inactivityTimeoutMs <= 0
    ) {
      return;
    }
    if (pending.inactivityTimeout) {
      clearTimeout(pending.inactivityTimeout);
    }
    pending.inactivityTimeout = setTimeout(() => {
      const minutes = Math.max(1, Math.round(this.inactivityTimeoutMs! / 60_000));
      this.requestStop(
        worker,
        pending,
        new Error(
          `Kimi ACP turn became inactive after ${minutes} minutes with no engine output; `
          + "the stalled turn was stopped. Send /timeout off before a genuinely long silent task.",
        ),
      );
    }, this.inactivityTimeoutMs);
    pending.inactivityTimeout.unref?.();
  }

  private requestStop(worker: KimiWorker, pending: PendingKimiTurn, error: Error): void {
    if (worker.pendingTurn !== pending || pending.stopError) {
      return;
    }
    pending.stopError = error;
    pending.rejectInterruption(error);
    pending.approvalAbortController.abort(error);
    const sessionId = worker.currentSessionId;
    if (!sessionId) {
      this.hardStopWorker(worker, pending, error);
      return;
    }
    void worker.connection.cancel({ sessionId }).catch(() => {
      this.hardStopWorker(worker, pending, error);
    });
    pending.cancelGraceTimeout = setTimeout(() => {
      this.hardStopWorker(worker, pending, error);
    }, this.cancelGraceMs);
    pending.cancelGraceTimeout.unref?.();
  }

  private hardStopWorker(worker: KimiWorker, pending: PendingKimiTurn, error: Error): void {
    if (worker.pendingTurn !== pending) {
      return;
    }
    pending.stopError = error;
    pending.rejectFailure(error);
    worker.rejectFailure(error);
    this.killProcessTreeFn(worker.child.pid);
    this.finishPendingTurn(worker, pending);
    this.removeWorker(worker);
  }

  private markActivity(worker: KimiWorker): void {
    worker.lastActivityAt = Date.now();
    if (worker.pendingTurn) {
      this.armInactivityTimeout(worker, worker.pendingTurn);
    }
  }

  private finishPendingTurn(worker: KimiWorker, pending: PendingKimiTurn): void {
    if (worker.pendingTurn === pending) {
      worker.pendingTurn = null;
    }
    pending.approvalAbortController.abort();
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
    }
    if (pending.totalTimeout) {
      clearTimeout(pending.totalTimeout);
    }
    if (pending.inactivityTimeout) {
      clearTimeout(pending.inactivityTimeout);
    }
    if (pending.cancelGraceTimeout) {
      clearTimeout(pending.cancelGraceTimeout);
    }
  }

  private failWorker(worker: KimiWorker, error: Error): void {
    worker.rejectFailure(error);
    const pending = worker.pendingTurn;
    if (!pending) {
      return;
    }
    pending.stopError = pending.stopError ?? error;
    pending.rejectFailure(pending.stopError);
    this.finishPendingTurn(worker, pending);
  }

  private withDiagnostics(worker: KimiWorker, error: Error): Error {
    const stderr = worker.stderrTail.trim();
    if (!stderr || error.message.includes(stderr)) {
      return error;
    }
    return new Error(`${error.message}\n\nKimi stderr:\n${stderr}`);
  }

  private async emitEngineEvent(
    handler: ((event: EngineStreamEvent) => void | Promise<void>) | undefined,
    event: EngineStreamEvent,
  ): Promise<void> {
    if (!handler) {
      return;
    }
    try {
      await handler(event);
    } catch {
      // Engine event rendering is best-effort and must not break the turn.
    }
  }

  private queueEngineEvent(pending: PendingKimiTurn, event: EngineStreamEvent): void {
    pending.eventChain = pending.eventChain.then(async () => {
      await this.emitEngineEvent(pending.onEngineEvent, event);
    });
  }

  private rekeyWorker(worker: KimiWorker, sessionId: string): void {
    for (const [key, candidate] of this.workers.entries()) {
      if (candidate === worker && key !== sessionId) {
        this.workers.delete(key);
      }
    }
    this.workers.set(sessionId, worker);
  }

  private reapIdleWorkers(): void {
    const now = Date.now();
    const seen = new Set<KimiWorker>();
    for (const worker of this.workers.values()) {
      if (seen.has(worker)) {
        continue;
      }
      seen.add(worker);
      if (worker.pendingTurn || now - worker.lastActivityAt < this.idleWorkerTtlMs) {
        continue;
      }
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    }
  }

  private removeWorker(worker: KimiWorker): void {
    worker.removed = true;
    for (const [key, candidate] of this.workers.entries()) {
      if (candidate === worker) {
        this.workers.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    const seen = new Set<KimiWorker>();
    for (const worker of this.workers.values()) {
      if (seen.has(worker)) {
        continue;
      }
      seen.add(worker);
      const pending = worker.pendingTurn;
      if (pending) {
        pending.stopError = new Error("Adapter destroyed");
        pending.rejectFailure(pending.stopError);
        this.finishPendingTurn(worker, pending);
      }
      worker.rejectFailure(pending?.stopError ?? new Error("Adapter destroyed"));
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    }
    this.workers.clear();
    this.pendingWorkers.clear();
  }
}
