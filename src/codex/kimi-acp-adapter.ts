import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type Stream,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCallContent,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
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
import { appendSavedArtifactDeliveryTags } from "./generated-files.js";
import {
  isKimiHookRelayVersionSupported,
  KIMI_HOOK_RELAY_URL_ENV,
  startKimiHookRelay,
  type KimiHookEvent,
  type KimiHookRelayRuntime,
} from "./kimi-hook-relay.js";
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
  turnId: number;
  assistantText: string;
  assistantBoundaryPending: boolean;
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

type KimiTaskNotification = Extract<KimiHookEvent, { hookEventName: "Notification" }>;

type KimiBackgroundTask = {
  taskId: string;
  workflowId: string;
  sessionId?: string;
  description?: string;
  kind?: string;
  status?: string;
  ownerAgentId?: string;
  subagentId?: string;
  subagentName?: string;
  subagentResponse?: string;
  ownerTurnId?: number;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  continuationTaskId?: string;
  internalContinuationStage?: boolean;
  suppressUserDelivery?: boolean;
  startEmitted: boolean;
  lastSeenAt: number;
  pendingNotification?: KimiTaskNotification;
  notificationTimer?: ReturnType<typeof setTimeout>;
  terminalObserved?: boolean;
};

type KimiBackgroundContinuation = {
  taskId: string;
  workflowId: string;
  sessionId?: string;
  status?: string;
  summary?: string;
  rawText?: string;
  lastSeenAt: number;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  approvalAbortController: AbortController;
  assistantText: string;
  assistantBoundaryPending: boolean;
  activeTurnId?: string;
  reviewTurnId?: string;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  terminalTimer?: ReturnType<typeof setTimeout>;
  pendingTerminal?: KimiHookTerminal;
  taskOriginReviewStarted?: boolean;
  lateAfterFallback?: boolean;
  suppressUserDelivery?: boolean;
};

type KimiHookTurn = {
  turnId: string;
  originKind: string;
  continuationTaskId?: string;
};

type IgnoredKimiHookTurn = {
  turnId: string;
  startedAt: number;
};

type KimiHookTerminal = {
  status: "completed" | "failed";
  errorText?: string;
  safetyExpiry?: boolean;
};

type PendingKimiHookTerminal = {
  terminal: KimiHookTerminal;
  receivedAt: number;
};

type KimiTerminalBackgroundTask = {
  terminalAt: number;
  workflowId: string;
  sessionId?: string;
  status?: string;
  summary?: string;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  taskOriginReviewStarted: boolean;
  suppressUserDelivery?: boolean;
};

type KimiDeferredSettingsNotice = {
  taskCount: number;
};

type KimiAcpTerminalExitStatus = {
  exitCode?: number | null;
  signal?: string | null;
};

type KimiAcpTerminal = {
  terminalId: string;
  sessionId: string;
  child: ChildProcess;
  outputChunks: Array<{ text: string; byteLength: number }>;
  outputByteLength: number;
  outputByteLimit: number;
  truncated: boolean;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  exitStatus?: KimiAcpTerminalExitStatus;
  exitPromise: Promise<KimiAcpTerminalExitStatus>;
  resolveExit: (status: KimiAcpTerminalExitStatus) => void;
};

type KimiBackgroundContinuationWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
};

type KimiWorker = {
  child: KimiChildProcess;
  connection: ClientSideConnection;
  requestedSessionId: string;
  currentSessionId: string | null;
  workspacePath: string;
  settingsKey: string;
  runtimeMode: NonNullable<KimiRuntimeOptions["mode"]>;
  deferredSettingsKey?: string;
  /** Set when a settings change was deferred; rendered in the request locale
   *  and appended once after a successful turn. */
  deferredSettingsNotice?: KimiDeferredSettingsNotice;
  hookRelayActive: boolean;
  stderrDecoder: TextDecoder;
  stderrTail: string;
  pendingTurn: PendingKimiTurn | null;
  sessionUpdateChain: Promise<void>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  tools: Map<string, KimiToolState>;
  backgroundTasks: Map<string, KimiBackgroundTask>;
  backgroundContinuations: Map<string, KimiBackgroundContinuation>;
  backgroundContinuationWaiters: Set<KimiBackgroundContinuationWaiter>;
  terminalBackgroundTasks: Map<string, KimiTerminalBackgroundTask>;
  terminals: Map<string, KimiAcpTerminal>;
  activeHookTurn?: KimiHookTurn;
  ignoredHookTurn?: IgnoredKimiHookTurn;
  pendingHookTerminal?: PendingKimiHookTerminal;
  ignoredHookTerminalStarts: number[];
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
const DEFAULT_BACKGROUND_TASK_MAX_AGE_MS = 6 * 60 * 60_000;
const DEFAULT_BACKGROUND_TASK_TOMBSTONE_TTL_MS = 6 * 60 * 60_000;
const MAX_BACKGROUND_TASK_OUTPUT_BYTES = 64 * 1024;
const MAX_KIMI_WIRE_TAIL_BYTES = 256 * 1024;
const DEFAULT_ACP_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ACP_TERMINAL_OUTPUT_BYTES = 64 * 1024 * 1024;
const SUBAGENT_NOTIFICATION_GRACE_MS = 250;

function renderDeferredSettingsNotice(
  notice: KimiDeferredSettingsNotice,
  locale: NonNullable<CodexUserMessageInput["locale"]>,
): string {
  if (locale === "zh") {
    return `⏳ 新的引擎设置已记录，但本会话还有 ${notice.taskCount} 个后台任务在跑，会在它们结束后的下一轮生效（本轮仍用当前设置）。想立刻生效可发 /reset 开新会话。`;
  }
  const taskLabel = notice.taskCount === 1 ? "background task" : "background tasks";
  return `⏳ New engine settings were saved, but this session still has ${notice.taskCount} ${taskLabel} running. They will take effect on the next turn after the background work finishes (this turn still uses the current settings). Send /reset to start a new session if you want them to take effect immediately.`;
}
const DEFAULT_BACKGROUND_CONTINUATION_GRACE_MS = 10_000;
const DEFAULT_HOOK_TERMINAL_GRACE_MS = 250;
const HOOK_RELAY_DRAIN_TIMEOUT_MS = 5_000;
const SESSION_UPDATE_HOOK_DRAIN_TIMEOUT_MS = 2_000;
const PENDING_HOOK_TERMINAL_TTL_MS = 5_000;
const KIMI_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_ACP_ERROR_DETAILS_CHARS = 2_000;
const KIMI_ACP_STDIO_RUNTIME_IDENTITY_ERROR =
  /^ACP stdio MCP server .+ does not declare a runtime identity$/;

type SyncWorkspaceInstructions = (workspacePath: string, instructions: string | null) => Promise<string>;
type StartKimiHookRelay = typeof startKimiHookRelay;
type ReadKimiBackgroundTaskOutput = typeof readKimiBackgroundTaskOutput;
type ReadKimiBackgroundTaskOwnership = typeof readKimiBackgroundTaskOwnership;
type ResolveKimiTaskOrigin = typeof resolveKimiTaskOriginFromWire;
type ReadKimiTaskReviewText = typeof readKimiTaskReviewTextFromWire;

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

function readAcpErrorDetails(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const data = error.data;
  if (typeof data !== "object" || data === null || !("details" in data) || typeof data.details !== "string") {
    return undefined;
  }
  const details = data.details.trim();
  return details ? details.slice(0, MAX_ACP_ERROR_DETAILS_CHARS) : undefined;
}

function normalizeKimiAcpError(error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const details = readAcpErrorDetails(error);
  if (!details || normalized.message.includes(details)) {
    return normalized;
  }
  const enriched = new Error(`${normalized.message}: ${details}`, { cause: normalized });
  enriched.name = normalized.name;
  return enriched;
}

function isAcpStdioMcpServer(server: McpServer): boolean {
  return !("type" in server);
}

function isKimiAcpStdioRuntimeIdentityError(error: unknown): boolean {
  const details = readAcpErrorDetails(error);
  return details !== undefined && KIMI_ACP_STDIO_RUNTIME_IDENTITY_ERROR.test(details);
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

async function probeKimiHookRelayCompatibility(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const invocation = buildCommandInvocation(command, ["--version"]);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: invocation.shell,
      env,
      windowsHide: true,
    });
    const finish = (supported: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(supported);
    };
    const append = (chunk: Uint8Array | string): void => {
      output = `${output}${typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")}`.slice(-4_096);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => finish(false));
    child.once("close", () => finish(isKimiHookRelayVersionSupported(output)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, KIMI_VERSION_PROBE_TIMEOUT_MS);
    timeout.unref?.();
  });
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

function parseKimiTaskOutputFields(output: string | undefined): Map<string, string> {
  const fields = new Map<string, string>();
  if (!output) {
    return fields;
  }
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined) {
      fields.set(match[1], match[2].trim());
    }
  }
  return fields;
}

function parseKimiBackgroundTaskOutput(output: string | undefined): {
  taskId: string;
  description?: string;
  subagentId?: string;
  subagentName?: string;
} | null {
  const fields = parseKimiTaskOutputFields(output);
  const taskId = fields.get("task_id");
  if (!taskId || fields.get("automatic_notification") !== "true") {
    return null;
  }
  const description = fields.get("description") || undefined;
  const subagentId = fields.get("agent_id") || undefined;
  const subagentName = fields.get("actual_subagent_type") || undefined;
  return { taskId, description, subagentId, subagentName };
}

function parseKimiStoppedTaskOutput(toolName: string, output: string | undefined): {
  taskId: string;
  reason?: string;
} | null {
  if (toolName.replace(/[\s_-]+/g, "").toLowerCase() !== "taskstop") {
    return null;
  }
  const fields = parseKimiTaskOutputFields(output);
  const taskId = fields.get("task_id");
  const status = fields.get("status")?.toLowerCase();
  if (!taskId || !status || !["killed", "stopped", "cancelled", "canceled"].includes(status)) {
    return null;
  }
  return {
    taskId,
    ...(fields.get("reason") ? { reason: fields.get("reason") } : {}),
  };
}

type KimiWaitForTerminalTask = {
  taskId: string;
  status: string;
  description?: string;
  source: "finished" | "completed_during_wait";
};

const KIMI_WAIT_FOR_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "lost",
  "timed_out",
  "cancelled",
  "canceled",
  "stopped",
]);

function parseKimiWaitForFields(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined) {
      fields.set(match[1].replace(/_/g, "").toLowerCase(), match[2].trim());
    }
  }
  return fields;
}

type KimiWaitForSection = {
  name: string;
  start: number;
  contentStart: number;
};

function kimiWaitForSections(output: string, from = 0): KimiWaitForSection[] {
  const sections: KimiWaitForSection[] = [];
  const markerPattern = /^\[([a-z_]+)\]\r?$/gm;
  markerPattern.lastIndex = from;
  for (let match = markerPattern.exec(output); match; match = markerPattern.exec(output)) {
    let contentStart = match.index + match[0].length;
    if (output[contentStart] === "\n") {
      contentStart += 1;
    }
    sections.push({
      name: match[1],
      start: match.index,
      contentStart,
    });
  }
  return sections;
}

function parseKimiWaitForTaskBlock(
  block: string,
  source: KimiWaitForTerminalTask["source"],
): KimiWaitForTerminalTask | null {
  const fields = parseKimiWaitForFields(block);
  const taskId = fields.get("taskid");
  const status = (fields.get("status") ?? "").toLowerCase();
  if (!taskId || !KIMI_WAIT_FOR_TERMINAL_STATUSES.has(status)) {
    return null;
  }
  const description = fields.get("description");
  return {
    taskId,
    status,
    ...(description ? { description } : {}),
    source,
  };
}

function sliceAfterKimiWaitForOutput(
  output: string,
  outputSection: KimiWaitForSection,
  finishedFields: Map<string, string>,
): string | undefined {
  const rawPreviewBytes = finishedFields.get("outputpreviewbytes");
  if (!rawPreviewBytes || !/^\d+$/.test(rawPreviewBytes)) {
    return undefined;
  }
  const previewBytes = Number(rawPreviewBytes);
  if (!Number.isSafeInteger(previewBytes)) {
    return undefined;
  }

  let unconsumed = output.slice(outputSection.contentStart);
  if (previewBytes === 0 && unconsumed.startsWith("[no output available]")) {
    unconsumed = unconsumed.slice("[no output available]".length);
  } else {
    const bytes = Buffer.from(unconsumed, "utf8");
    if (bytes.length < previewBytes) {
      return undefined;
    }
    const preview = bytes.subarray(0, previewBytes).toString("utf8");
    if (Buffer.byteLength(preview, "utf8") !== previewBytes) {
      return undefined;
    }
    unconsumed = unconsumed.slice(preview.length);
  }
  if (unconsumed && !/^\r?\n/.test(unconsumed)) {
    return undefined;
  }
  return unconsumed.replace(/^(?:\r?\n)+/, "");
}

function parseKimiWaitForExtraTasks(output: string): KimiWaitForTerminalTask[] {
  const sections = kimiWaitForSections(output);
  const extrasIndex = sections.findIndex((section) => section.name === "completed_during_wait");
  if (extrasIndex < 0) {
    return [];
  }
  const extras = sections[extrasIndex];
  const next = sections[extrasIndex + 1];
  const block = output.slice(extras.contentStart, next?.start ?? output.length).trim();
  return block.split(/\r?\n---\r?\n/).flatMap((entry) => {
    const parsed = parseKimiWaitForTaskBlock(entry, "completed_during_wait");
    return parsed ? [parsed] : [];
  });
}

function parseKimiWaitForOutput(
  toolName: string,
  output: string | undefined,
): KimiWaitForTerminalTask[] | null {
  if (toolName.replace(/[\s_-]+/g, "").toLowerCase() !== "waitfor" || !output) {
    return null;
  }
  const sections = kimiWaitForSections(output);
  const firstSection = sections[0];
  const header = parseKimiWaitForFields(output.slice(0, firstSection?.start ?? output.length));
  if (header.get("waitstatus")?.toLowerCase() !== "completed") {
    return [];
  }
  const headerTaskId = header.get("taskid");
  if (!headerTaskId || firstSection?.name !== "finished") {
    return [];
  }

  const sectionAfterFinished = sections[1];
  const finishedEnd = sectionAfterFinished?.start ?? output.length;
  const finishedBlock = output.slice(firstSection.contentStart, finishedEnd).trim();
  const finished = parseKimiWaitForTaskBlock(finishedBlock, "finished");
  if (!finished || finished.taskId !== headerTaskId) {
    return [];
  }

  const tasks = new Map<string, KimiWaitForTerminalTask>([[finished.taskId, finished]]);
  let authenticatedTail: string | undefined;
  if (sectionAfterFinished?.name === "output") {
    authenticatedTail = sliceAfterKimiWaitForOutput(
      output,
      sectionAfterFinished,
      parseKimiWaitForFields(finishedBlock),
    );
  } else if (sectionAfterFinished) {
    authenticatedTail = output.slice(sectionAfterFinished.start);
  }
  if (authenticatedTail !== undefined) {
    for (const extra of parseKimiWaitForExtraTasks(authenticatedTail)) {
      if (!tasks.has(extra.taskId)) {
        tasks.set(extra.taskId, extra);
      }
    }
  }
  return [...tasks.values()];
}

function parseKimiTaskTurnPrompt(prompt: string | undefined): {
  taskId?: string;
  status?: string;
} {
  if (!prompt) {
    return {};
  }
  const sourceMatch = prompt.match(/\bsource_id=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
  const notificationMatch = prompt.match(/\bid=(?:"|')task:([^:"']+):([^"']+)(?:"|')/);
  const taskId = sourceMatch?.[1] ?? sourceMatch?.[2] ?? sourceMatch?.[3] ?? notificationMatch?.[1];
  const typeMatch = prompt.match(/\btype=(?:"|')task\.([^"']+)(?:"|')/);
  const status = typeMatch?.[1] ?? notificationMatch?.[2];
  return {
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
  };
}

function isSafeKimiPathSegment(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

async function listKimiSessionWirePaths(
  engineHomePath: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!engineHomePath || !isSafeKimiPathSegment(sessionId)) {
    return [];
  }

  const sessionsRoot = path.join(engineHomePath, "sessions");
  let realSessionsRoot: string;
  let sessionParents: string[];
  try {
    realSessionsRoot = await realpath(sessionsRoot);
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    sessionParents = [sessionsRoot, ...entries
      .filter((entry) => entry.isDirectory() && isSafeKimiPathSegment(entry.name))
      .map((entry) => path.join(sessionsRoot, entry.name))];
  } catch {
    return [];
  }

  const sessionDirName = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  const wirePaths: string[] = [];
  for (const parent of sessionParents) {
    const agentsDir = path.join(parent, sessionDirName, "agents");
    const agents = await readdir(agentsDir, { withFileTypes: true }).catch(() => null);
    if (!agents) {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() || !isSafeKimiPathSegment(agent.name)) {
        continue;
      }
      try {
        const resolved = await realpath(path.join(agentsDir, agent.name, "wire.jsonl"));
        const relative = path.relative(realSessionsRoot, resolved);
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
          continue;
        }
        wirePaths.push(resolved);
      } catch {
        // Kimi may rotate or replace a wire while a task-origin turn runs.
      }
    }
  }
  return wirePaths;
}

async function readKimiWireTailLines(wirePath: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(wirePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0) {
      return [];
    }
    const bytesToRead = Math.min(stats.size, MAX_KIMI_WIRE_TAIL_BYTES);
    const start = stats.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let tail = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = tail.indexOf("\n");
      tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
    }
    return tail.split("\n");
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseKimiWireRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveKimiTaskOriginFromWire(
  engineHomePath: string | undefined,
  sessionId: string,
  candidateTaskIds: readonly string[],
): Promise<string | undefined> {
  if (!engineHomePath || !isSafeKimiPathSegment(sessionId)) {
    return undefined;
  }
  const candidates = new Set(candidateTaskIds.filter(isSafeKimiPathSegment));
  if (candidates.size === 0) {
    return undefined;
  }

  let latest: { taskId: string; time: number } | undefined;
  const wirePaths = await listKimiSessionWirePaths(engineHomePath, sessionId);
  for (const wirePath of wirePaths) {
    const lines = await readKimiWireTailLines(wirePath);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      const record = parseKimiWireRecord(line);
      if (!record || record.type !== "turn.prompt") {
        continue;
      }
      const origin = typeof record.origin === "object" && record.origin !== null && !Array.isArray(record.origin)
        ? record.origin as Record<string, unknown>
        : undefined;
      const taskId = typeof origin?.taskId === "string" ? origin.taskId : undefined;
      if (origin?.kind !== "task" || !taskId || !candidates.has(taskId)) {
        continue;
      }
      const time = typeof record.time === "number" && Number.isFinite(record.time) ? record.time : 0;
      if (!latest || time >= latest.time) {
        latest = { taskId, time };
      }
      break;
    }
  }
  return latest?.taskId;
}

async function readKimiTaskReviewTextFromWire(
  engineHomePath: string | undefined,
  sessionId: string,
  taskId: string,
  turnId: string,
): Promise<string | undefined> {
  if (
    !engineHomePath
    || !isSafeKimiPathSegment(sessionId)
    || !isSafeKimiPathSegment(taskId)
    || !isSafeKimiPathSegment(turnId)
  ) {
    return undefined;
  }

  let latest: { text: string; time: number } | undefined;
  const wirePaths = await listKimiSessionWirePaths(engineHomePath, sessionId);
  for (const wirePath of wirePaths) {
    const lines = await readKimiWireTailLines(wirePath);
    let pendingOriginTaskId: string | undefined;
    let originCompatible = true;
    let sawTargetTurn = false;
    let completed = false;
    let latestTime = 0;
    let textParts: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const record = parseKimiWireRecord(line);
      if (!record) {
        continue;
      }
      if (record.type === "turn.prompt") {
        const origin = typeof record.origin === "object" && record.origin !== null && !Array.isArray(record.origin)
          ? record.origin as Record<string, unknown>
          : undefined;
        pendingOriginTaskId = origin?.kind === "task" && typeof origin.taskId === "string"
          ? origin.taskId
          : undefined;
        continue;
      }
      if (record.type === "turn.ended") {
        if (String(record.turnId ?? "") === turnId && originCompatible) {
          sawTargetTurn = true;
          completed = true;
          latestTime = typeof record.time === "number" && Number.isFinite(record.time)
            ? record.time
            : latestTime;
        }
        continue;
      }
      if (record.type !== "context.append_loop_event") {
        continue;
      }
      const event = typeof record.event === "object" && record.event !== null && !Array.isArray(record.event)
        ? record.event as Record<string, unknown>
        : undefined;
      if (!event || String(event.turnId ?? "") !== turnId) {
        continue;
      }
      if (!sawTargetTurn) {
        originCompatible = pendingOriginTaskId === undefined || pendingOriginTaskId === taskId;
      }
      sawTargetTurn = true;
      if (!originCompatible) {
        continue;
      }
      latestTime = typeof record.time === "number" && Number.isFinite(record.time)
        ? record.time
        : latestTime;

      if (event.type === "tool.call") {
        textParts = [];
        completed = false;
        continue;
      }
      if (event.type === "content.part") {
        const part = typeof event.part === "object" && event.part !== null && !Array.isArray(event.part)
          ? event.part as Record<string, unknown>
          : undefined;
        if (part?.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
        continue;
      }
      if (event.type === "step.end") {
        completed = event.finishReason === "end_turn";
        if (!completed) {
          textParts = [];
        }
      }
    }

    const text = textParts.join("").trim();
    // An empty completed turn is still a useful lifecycle signal. Callers can
    // fall back to the captured task result while using `undefined` to mean the
    // wire has not proved that this review ended yet.
    if (sawTargetTurn && completed && !text.includes("\0") && (!latest || latestTime >= latest.time)) {
      latest = { text, time: latestTime };
    }
  }
  return latest?.text;
}

async function resolveKimiBackgroundTaskOutputPath(
  engineHomePath: string,
  sessionId: string,
  taskId: string,
): Promise<string | undefined> {
  if (!isSafeKimiPathSegment(sessionId) || !isSafeKimiPathSegment(taskId)) {
    return undefined;
  }
  const sessionsRoot = path.join(engineHomePath, "sessions");
  let realSessionsRoot: string;
  let sessionParents: string[];
  try {
    realSessionsRoot = await realpath(sessionsRoot);
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    sessionParents = [sessionsRoot, ...entries
      .filter((entry) => entry.isDirectory() && isSafeKimiPathSegment(entry.name))
      .map((entry) => path.join(sessionsRoot, entry.name))];
  } catch {
    return undefined;
  }

  const sessionDirName = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  for (const parent of sessionParents) {
    const agentsDir = path.join(parent, sessionDirName, "agents");
    const agents = await readdir(agentsDir, { withFileTypes: true }).catch(() => null);
    if (!agents) {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() || !isSafeKimiPathSegment(agent.name)) {
        continue;
      }
      const candidate = path.join(agentsDir, agent.name, "tasks", taskId, "output.log");
      try {
        const resolved = await realpath(candidate);
        const relative = path.relative(realSessionsRoot, resolved);
        if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
          return resolved;
        }
      } catch {
        // The task may belong to a different agent directory.
      }
    }
  }
  return undefined;
}

type KimiBackgroundTaskOwnership = {
  ownerAgentId?: string;
  subagentId?: string;
};

async function readKimiBackgroundTaskOwnership(
  engineHomePath: string | undefined,
  sessionId: string | undefined,
  taskId: string,
): Promise<KimiBackgroundTaskOwnership | undefined> {
  if (
    !engineHomePath
    || !sessionId
    || !isSafeKimiPathSegment(sessionId)
    || !isSafeKimiPathSegment(taskId)
  ) {
    return undefined;
  }

  const sessionsRoot = path.join(engineHomePath, "sessions");
  let realSessionsRoot: string;
  let sessionParents: string[];
  try {
    realSessionsRoot = await realpath(sessionsRoot);
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    sessionParents = [sessionsRoot, ...entries
      .filter((entry) => entry.isDirectory() && isSafeKimiPathSegment(entry.name))
      .map((entry) => path.join(sessionsRoot, entry.name))];
  } catch {
    return undefined;
  }

  const sessionDirName = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  for (const parent of sessionParents) {
    const agentsDir = path.join(parent, sessionDirName, "agents");
    const agents = await readdir(agentsDir, { withFileTypes: true }).catch(() => null);
    if (!agents) {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() || !isSafeKimiPathSegment(agent.name)) {
        continue;
      }
      const tasksDir = path.join(agentsDir, agent.name, "tasks");
      const metadataPath = path.join(tasksDir, `${taskId}.json`);
      const taskDir = path.join(tasksDir, taskId);
      let resolvedTaskPath: string | undefined;
      for (const candidate of [metadataPath, taskDir]) {
        try {
          const resolved = await realpath(candidate);
          const relative = path.relative(realSessionsRoot, resolved);
          if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
            resolvedTaskPath = resolved;
            break;
          }
        } catch {
          // The task may belong to a different agent directory.
        }
      }
      if (!resolvedTaskPath) {
        continue;
      }

      let subagentId: string | undefined;
      try {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
          const agentId = (metadata as { agentId?: unknown }).agentId;
          if (typeof agentId === "string" && isSafeKimiPathSegment(agentId)) {
            subagentId = agentId;
          }
        }
      } catch {
        // The task directory alone still proves which Kimi agent owns it.
      }
      return {
        ownerAgentId: agent.name,
        ...(subagentId ? { subagentId } : {}),
      };
    }
  }
  return undefined;
}

async function readKimiBackgroundTaskOutput(
  engineHomePath: string | undefined,
  sessionId: string | undefined,
  taskId: string,
): Promise<string | undefined> {
  if (!engineHomePath || !sessionId) {
    return undefined;
  }
  const outputPath = await resolveKimiBackgroundTaskOutputPath(engineHomePath, sessionId, taskId);
  if (!outputPath) {
    return undefined;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(outputPath, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0) {
      return undefined;
    }
    const bytesToRead = Math.min(stats.size, MAX_BACKGROUND_TASK_OUTPUT_BYTES);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFFFD/, "").trim();
    if (!text || text.includes("\0")) {
      return undefined;
    }
    if (start > 0) {
      text = `[Earlier output omitted; showing the last ${MAX_BACKGROUND_TASK_OUTPUT_BYTES} bytes.]\n${text}`;
    }
    return text;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function taskStatusFromNotificationType(notificationType: string): string {
  const status = notificationType.startsWith("task.")
    ? notificationType.slice("task.".length)
    : notificationType;
  return status.trim() || "completed";
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
  private readonly backgroundTaskMaxAgeMs: number;
  private readonly backgroundContinuationGraceMs: number;
  private readonly hookTerminalGraceMs: number;
  private readonly killProcessTreeFn: (pid: number | undefined) => void;
  private readonly mcpServers: McpServer[];
  private readonly syncWorkspaceInstructionsFn: SyncWorkspaceInstructions;
  private readonly hookRelayEnabled: boolean;
  private readonly hookRelayVersionProbeRequired: boolean;
  private readonly startHookRelayFn: StartKimiHookRelay;
  private readonly readBackgroundTaskOutputFn: ReadKimiBackgroundTaskOutput;
  private readonly readBackgroundTaskOwnershipFn: ReadKimiBackgroundTaskOwnership;
  private readonly resolveTaskOriginFn: ResolveKimiTaskOrigin;
  private readonly readTaskReviewTextFn: ReadKimiTaskReviewText;
  private readonly workers = new Map<string, KimiWorker>();
  private readonly pendingWorkers = new Map<string, Promise<KimiWorker>>();
  private readonly idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  private hookRelayPromise: Promise<KimiHookRelayRuntime | null> | undefined;
  private hookRelayRuntime: KimiHookRelayRuntime | undefined;
  private hookRelayCompatibilityPromise: Promise<boolean> | undefined;
  private omitAcpStdioMcpServers = false;
  private destroyPromise: Promise<void> | undefined;
  private nextTurnId = 1;
  private destroyed = false;

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
      backgroundTaskMaxAgeMs?: number;
      backgroundContinuationGraceMs?: number;
      hookTerminalGraceMs?: number;
      killProcessTreeFn?: (pid: number | undefined) => void;
      mcpServers?: McpServer[];
      syncWorkspaceInstructionsFn?: SyncWorkspaceInstructions;
      hookRelayEnabled?: boolean;
      startHookRelayFn?: StartKimiHookRelay;
      readBackgroundTaskOutputFn?: ReadKimiBackgroundTaskOutput;
      readBackgroundTaskOwnershipFn?: ReadKimiBackgroundTaskOwnership;
      resolveTaskOriginFn?: ResolveKimiTaskOrigin;
      readTaskReviewTextFn?: ReadKimiTaskReviewText;
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
    this.backgroundTaskMaxAgeMs = options?.backgroundTaskMaxAgeMs ?? DEFAULT_BACKGROUND_TASK_MAX_AGE_MS;
    this.backgroundContinuationGraceMs = options?.backgroundContinuationGraceMs
      ?? DEFAULT_BACKGROUND_CONTINUATION_GRACE_MS;
    this.hookTerminalGraceMs = options?.hookTerminalGraceMs ?? DEFAULT_HOOK_TERMINAL_GRACE_MS;
    this.killProcessTreeFn = options?.killProcessTreeFn ?? killProcessTree;
    this.mcpServers = options?.mcpServers ?? resolveDefaultKimiMcpServers();
    this.syncWorkspaceInstructionsFn = options?.syncWorkspaceInstructionsFn ?? syncKimiWorkspaceInstructions;
    // Unit/fake spawners stay hermetic unless a test explicitly opts in. Real
    // service adapters enable the Kimi 0.32+ hook relay by default.
    this.hookRelayEnabled = options?.hookRelayEnabled ?? options?.spawnFn === undefined;
    this.hookRelayVersionProbeRequired = options?.hookRelayEnabled === undefined;
    this.startHookRelayFn = options?.startHookRelayFn ?? startKimiHookRelay;
    this.readBackgroundTaskOutputFn = options?.readBackgroundTaskOutputFn ?? readKimiBackgroundTaskOutput;
    this.readBackgroundTaskOwnershipFn = options?.readBackgroundTaskOwnershipFn
      ?? readKimiBackgroundTaskOwnership;
    this.resolveTaskOriginFn = options?.resolveTaskOriginFn ?? resolveKimiTaskOriginFromWire;
    this.readTaskReviewTextFn = options?.readTaskReviewTextFn ?? readKimiTaskReviewTextFromWire;

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
      await this.requestSessionWithMcpFallback((mcpServers) => connection.loadSession({
        sessionId,
        cwd: workspacePath,
        mcpServers,
      }));
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
    if (this.destroyed) {
      throw new Error("Adapter destroyed");
    }
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
    if (this.destroyed) {
      throw new Error("Adapter destroyed");
    }
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
    const deferredNotice = worker.deferredSettingsNotice;
    worker.deferredSettingsNotice = undefined;
    return {
      text: deferredNotice
        ? [
            result.text.trim(),
            renderDeferredSettingsNotice(deferredNotice, input.locale ?? "en"),
          ].filter(Boolean).join("\n\n")
        : result.text,
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

  private async resolveWorkerChildEnv(): Promise<NodeJS.ProcessEnv> {
    if (!this.hookRelayEnabled || !this.engineHomePath) {
      return this.childEnv;
    }
    if (this.hookRelayVersionProbeRequired) {
      this.hookRelayCompatibilityPromise ??= probeKimiHookRelayCompatibility(
        this.kimiExecutable,
        this.childEnv,
      ).then((compatible) => {
        if (!compatible) {
          console.error(
            "Kimi background-task hooks require Kimi Code 0.32 or newer; continuing with ACP only.",
          );
        }
        return compatible;
      });
      if (!await this.hookRelayCompatibilityPromise) {
        return this.childEnv;
      }
    }
    this.hookRelayPromise ??= this.startHookRelayFn({
      engineHomePath: this.engineHomePath,
      onEvent: async (event) => await this.handleKimiHookEvent(event),
    }).then(async (runtime) => {
      if (this.destroyed) {
        await runtime.close().catch(() => undefined);
        return null;
      }
      this.hookRelayRuntime = runtime;
      return runtime;
    }).catch((error: unknown) => {
      console.error(
        "Kimi background-task hook relay is unavailable; continuing without out-of-band task notifications:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
    const runtime = await this.hookRelayPromise;
    return runtime ? { ...this.childEnv, ...runtime.env } : this.childEnv;
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
        existing.deferredSettingsKey = undefined;
        existing.deferredSettingsNotice = undefined;
        return existing;
      }
      if (existing.pendingTurn) {
        throw new Error("Cannot reconfigure Kimi session while a turn is in flight");
      }
      // The relay replies 202 before its async event handler finishes. A late
      // task-origin TurnStarted can therefore be accepted while ownership is
      // still being recovered from wire/tombstone state and before it appears
      // in either background map. Killing the worker in that window orphans the
      // review and lets its ACP text leak into the replacement worker's turn.
      if (existing.hookRelayActive && this.hookRelayRuntime) {
        await withTimeout(
          this.hookRelayRuntime.drainAcceptedEvents(),
          HOOK_RELAY_DRAIN_TIMEOUT_MS,
          "Kimi Hook relay did not settle before reconfiguring the session",
        );
        const refreshed = this.workers.get(sessionId);
        if (existing.removed || (refreshed && refreshed !== existing)) {
          return await this.getOrCreateWorker(
            sessionId,
            workspacePath,
            runtimeOptions,
            instructionSettingsKey,
          );
        }
      }
      const now = Date.now();
      this.pruneExpiredBackgroundTasks(existing, now);
      const count = new Set([
        ...existing.backgroundTasks.keys(),
        ...existing.backgroundContinuations.keys(),
      ]).size;
      if (count > 0) {
        if (existing.workspacePath !== workspacePath) {
          throw new Error(
            `Kimi session has ${count} background task${count === 1 ? "" : "s"} still running or being reviewed, so its workspace cannot be changed yet. `
            + `Retry once ${count === 1 ? "it finishes" : "they finish"}, or send /reset to start a fresh session.`,
          );
        }
        const requestedMode = runtimeOptions.mode ?? "default";
        if (existing.runtimeMode !== requestedMode) {
          throw new Error(
            `Kimi session has ${count} background task${count === 1 ? "" : "s"} still running or being reviewed, so its approval mode cannot be changed yet. `
            + `Retry once ${count === 1 ? "it finishes" : "they finish"}, or send /reset to start a fresh session.`,
          );
        }
        if (existing.deferredSettingsKey !== settingsKey) {
          existing.deferredSettingsKey = settingsKey;
          console.warn(
            `Deferring Kimi engine settings for session ${existing.currentSessionId ?? sessionId} until ${count} background task${count === 1 ? "" : "s"} finish.`,
          );
          // Deferring keeps the session usable (the previous behavior failed
          // every later turn), but a silent defer reads as "my /model did
          // nothing". Tell the operator once, on the reply they are already
          // waiting for.
          existing.deferredSettingsNotice = { taskCount: count };
        }
        return existing;
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

  private async requestSessionWithMcpFallback<T>(
    request: (mcpServers: McpServer[]) => Promise<T>,
  ): Promise<T> {
    const initialServers = this.omitAcpStdioMcpServers
      ? this.mcpServers.filter((server) => !isAcpStdioMcpServer(server))
      : [...this.mcpServers];
    try {
      return await request(initialServers);
    } catch (error) {
      if (!initialServers.some(isAcpStdioMcpServer) || !isKimiAcpStdioRuntimeIdentityError(error)) {
        throw error;
      }
      // Kimi Code 0.37.2 contradicts the ACP schema: it rejects stdio entries
      // without a type discriminator, while the SDK strips the unsupported
      // `type: "stdio"` field. Retry only this exact upstream regression and
      // keep remote MCP transports intact. A process restart probes again, so
      // a future Kimi fix restores stdio MCPs automatically.
      this.omitAcpStdioMcpServers = true;
      const omittedNames = initialServers
        .filter(isAcpStdioMcpServer)
        .map((server) => server.name)
        .join(", ");
      console.warn(
        `[kimi-acp] Kimi rejected stdio MCP runtime identities; disabling ACP stdio MCP servers for this adapter process${omittedNames ? ` (${omittedNames})` : ""}. Remote MCP servers remain enabled; restart to probe compatibility again.`,
      );
      return await request(this.mcpServers.filter((server) => !isAcpStdioMcpServer(server)));
    }
  }

  private async createWorker(
    sessionId: string,
    workspacePath: string,
    runtimeOptions: KimiRuntimeOptions,
    settingsKey: string,
  ): Promise<KimiWorker> {
    const childEnv = await this.resolveWorkerChildEnv();
    if (this.destroyed) {
      throw new Error("Adapter destroyed");
    }
    const invocation = buildCommandInvocation(this.kimiExecutable, ["acp"]);
    const child = this.spawnKimi(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: childEnv,
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
      sessionUpdate: (notification) => this.queueKimiSessionUpdate(worker, notification),
      createTerminal: async (request) => this.createAcpTerminal(worker, request),
      terminalOutput: async (request) => this.readAcpTerminal(worker, request),
      waitForTerminalExit: async (request) => await this.waitForAcpTerminal(worker, request),
      killTerminal: async (request) => this.killAcpTerminal(worker, request),
      releaseTerminal: async (request) => this.releaseAcpTerminal(worker, request),
    }), stream);
    worker = {
      child,
      connection,
      requestedSessionId: sessionId,
      currentSessionId: null,
      workspacePath,
      settingsKey,
      runtimeMode: runtimeOptions.mode ?? "default",
      hookRelayActive: Boolean(childEnv[KIMI_HOOK_RELAY_URL_ENV]),
      stderrDecoder: new TextDecoder(),
      stderrTail: "",
      pendingTurn: null,
      sessionUpdateChain: Promise.resolve(),
      onEngineEvent: undefined,
      tools: new Map(),
      backgroundTasks: new Map(),
      backgroundContinuations: new Map(),
      backgroundContinuationWaiters: new Set(),
      terminalBackgroundTasks: new Map(),
      terminals: new Map(),
      ignoredHookTerminalStarts: [],
      lastActivityAt: Date.now(),
      removed: false,
      failurePromise,
      rejectFailure,
    };
    this.workers.set(sessionId, worker);

    child.stderr.on("data", (chunk) => {
      this.markActivity(worker);
      const bytes = typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : new TextEncoder().encode(chunk.toString());
      worker.stderrTail = `${worker.stderrTail}${worker.stderrDecoder.decode(bytes, { stream: true })}`.slice(-MAX_STDERR_TAIL_CHARS);
    });
    if (typeof child.stdin.on === "function") {
      child.stdin.on("error", (error) => {
        this.failWorker(worker, this.withDiagnostics(worker, error));
        this.killProcessTreeFn(worker.child.pid);
        this.removeWorker(worker);
      });
    }
    child.once("error", (error) => {
      this.failWorker(worker, this.withDiagnostics(worker, error));
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    });
    child.once("close", (code, signal) => {
      worker.stderrTail = `${worker.stderrTail}${worker.stderrDecoder.decode()}`.slice(-MAX_STDERR_TAIL_CHARS);
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
            clientCapabilities: { terminal: true },
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
          this.requestSessionWithMcpFallback((mcpServers) => Promise.race([
            connection.newSession({ cwd: workspacePath, mcpServers }),
            worker.failurePromise,
          ])),
          this.initializeTimeoutMs,
          `Kimi ACP session/new timed out after ${this.initializeTimeoutMs}ms`,
        );
        worker.currentSessionId = (sessionResult as NewSessionResponse).sessionId;
      } else {
        if (initialized.agentCapabilities?.loadSession !== true) {
          throw new Error("This Kimi ACP version does not support session/load");
        }
        sessionResult = await withTimeout(
          this.requestSessionWithMcpFallback((mcpServers) => Promise.race([
            connection.loadSession({ sessionId, cwd: workspacePath, mcpServers }),
            worker.failurePromise,
          ])),
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
      throw this.withDiagnostics(worker, normalizeKimiAcpError(error));
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
      const normalized = normalizeKimiAcpError(error);
      const stderr = stderrTail.trim();
      if (!stderr || normalized.message.includes(stderr)) {
        throw normalized;
      }
      throw new Error(`${normalized.message}\n\nKimi stderr:\n${stderr}`);
    } finally {
      this.killProcessTreeFn(child.pid);
    }
  }

  private createAcpTerminal(
    worker: KimiWorker,
    request: CreateTerminalRequest,
  ): CreateTerminalResponse {
    this.assertAcpTerminalSession(worker, request.sessionId);
    const cwd = request.cwd ?? worker.workspacePath;
    if (!path.isAbsolute(cwd)) {
      throw new Error(`ACP terminal cwd must be absolute: ${cwd}`);
    }
    const outputByteLimit = Math.min(
      MAX_ACP_TERMINAL_OUTPUT_BYTES,
      Math.max(0, Math.floor(request.outputByteLimit ?? DEFAULT_ACP_TERMINAL_OUTPUT_BYTES)),
    );
    const env = { ...this.childEnv };
    for (const variable of request.env ?? []) {
      env[variable.name] = variable.value;
    }

    const child = spawn(request.command, request.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.stdout || !child.stderr) {
      this.killProcessTreeFn(child.pid);
      throw new Error("ACP terminal subprocess did not expose output pipes");
    }

    let resolveExit!: (status: KimiAcpTerminalExitStatus) => void;
    const exitPromise = new Promise<KimiAcpTerminalExitStatus>((resolve) => {
      resolveExit = resolve;
    });
    const terminal: KimiAcpTerminal = {
      terminalId: randomUUID(),
      sessionId: request.sessionId,
      child,
      outputChunks: [],
      outputByteLength: 0,
      outputByteLimit,
      truncated: false,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      exitPromise,
      resolveExit,
    };
    worker.terminals.set(terminal.terminalId, terminal);

    child.stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.appendAcpTerminalOutput(
        terminal,
        terminal.stdoutDecoder.write(Buffer.from(chunk)),
      );
    });
    child.stderr.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.appendAcpTerminalOutput(
        terminal,
        terminal.stderrDecoder.write(Buffer.from(chunk)),
      );
    });
    child.once("error", (error) => {
      const lastChunk = terminal.outputChunks.at(-1)?.text ?? "";
      const separator = terminal.outputByteLength > 0 && !lastChunk.endsWith("\n") ? "\n" : "";
      this.appendAcpTerminalOutput(terminal, `${separator}${error.message}`);
    });
    child.once("close", (code, signal) => {
      this.appendAcpTerminalOutput(terminal, terminal.stdoutDecoder.end());
      this.appendAcpTerminalOutput(terminal, terminal.stderrDecoder.end());
      if (terminal.exitStatus) {
        return;
      }
      const exitStatus: KimiAcpTerminalExitStatus = {};
      if (code !== null) {
        exitStatus.exitCode = code;
      }
      if (signal) {
        exitStatus.signal = signal;
      }
      terminal.exitStatus = exitStatus;
      terminal.resolveExit(exitStatus);
      if (!worker.removed) {
        this.markActivity(worker);
      }
    });
    this.markActivity(worker);
    return { terminalId: terminal.terminalId };
  }

  private appendAcpTerminalOutput(
    terminal: KimiAcpTerminal,
    text: string,
  ): void {
    if (!text) {
      return;
    }
    const byteLength = Buffer.byteLength(text, "utf8");
    terminal.outputChunks.push({ text, byteLength });
    terminal.outputByteLength += byteLength;
    if (terminal.outputByteLength > terminal.outputByteLimit) {
      terminal.truncated = true;
    }
    while (terminal.outputByteLength > terminal.outputByteLimit) {
      const first = terminal.outputChunks[0];
      if (!first) {
        terminal.outputByteLength = 0;
        break;
      }
      const excess = terminal.outputByteLength - terminal.outputByteLimit;
      if (first.byteLength <= excess) {
        terminal.outputChunks.shift();
        terminal.outputByteLength -= first.byteLength;
        continue;
      }
      const bytes = Buffer.from(first.text, "utf8");
      let start = excess;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
        start += 1;
      }
      first.text = bytes.subarray(start).toString("utf8");
      first.byteLength = bytes.length - start;
      terminal.outputByteLength -= start;
      break;
    }
  }

  private assertAcpTerminalSession(worker: KimiWorker, sessionId: string): void {
    if (!worker.currentSessionId || worker.currentSessionId !== sessionId) {
      throw new Error(`ACP terminal request does not belong to active session ${worker.currentSessionId ?? "unknown"}`);
    }
  }

  private getAcpTerminal(
    worker: KimiWorker,
    request: TerminalOutputRequest | WaitForTerminalExitRequest | KillTerminalRequest | ReleaseTerminalRequest,
  ): KimiAcpTerminal {
    this.assertAcpTerminalSession(worker, request.sessionId);
    const terminal = worker.terminals.get(request.terminalId);
    if (!terminal || terminal.sessionId !== request.sessionId) {
      throw new Error(`Unknown ACP terminal ${request.terminalId}`);
    }
    return terminal;
  }

  private readAcpTerminal(
    worker: KimiWorker,
    request: TerminalOutputRequest,
  ): TerminalOutputResponse {
    const terminal = this.getAcpTerminal(worker, request);
    this.markActivity(worker);
    return {
      output: terminal.outputChunks.map((chunk) => chunk.text).join(""),
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  private async waitForAcpTerminal(
    worker: KimiWorker,
    request: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getAcpTerminal(worker, request);
    this.markActivity(worker);
    const status = await terminal.exitPromise;
    if (!worker.removed) {
      this.markActivity(worker);
    }
    return status;
  }

  private killAcpTerminal(
    worker: KimiWorker,
    request: KillTerminalRequest,
  ): KillTerminalResponse {
    const terminal = this.getAcpTerminal(worker, request);
    if (!terminal.exitStatus) {
      this.killProcessTreeFn(terminal.child.pid);
    }
    this.markActivity(worker);
    return {};
  }

  private releaseAcpTerminal(
    worker: KimiWorker,
    request: ReleaseTerminalRequest,
  ): ReleaseTerminalResponse {
    const terminal = this.getAcpTerminal(worker, request);
    if (!terminal.exitStatus) {
      this.killProcessTreeFn(terminal.child.pid);
    }
    worker.terminals.delete(terminal.terminalId);
    this.markActivity(worker);
    return {};
  }

  private releaseAllAcpTerminals(worker: KimiWorker): void {
    for (const terminal of worker.terminals.values()) {
      if (!terminal.exitStatus) {
        this.killProcessTreeFn(terminal.child.pid);
      }
    }
    worker.terminals.clear();
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
    if (worker.hookRelayActive && this.hookRelayRuntime) {
      await withTimeout(
        this.hookRelayRuntime.drainAcceptedEvents(),
        HOOK_RELAY_DRAIN_TIMEOUT_MS,
        "Kimi Hook relay did not settle before the foreground turn",
      );
    }
    // Kimi can start a synthetic task-origin review independently of ACP
    // prompt calls. Sending a foreground prompt while that continuation exists
    // makes both turns share one update stream, so one answer can consume the
    // other's text. Re-check after every wake-up because another review can
    // start in the same relay batch that completed the previous one.
    while (this.backgroundContinuationTurnBusy(worker)) {
      await this.waitForBackgroundContinuation(worker, input.abortSignal);
    }
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
      turnId: this.nextTurnId++,
      assistantText: "",
      assistantBoundaryPending: false,
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
    const autonomousTurnActive = Boolean(this.backgroundContinuationForUpdate(worker));
    worker.pendingTurn = pending;
    worker.onEngineEvent = input.onEngineEvent;
    if (!autonomousTurnActive) {
      worker.tools.clear();
    }
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
      await Promise.race([
        this.drainKimiSessionUpdates(worker),
        pending.failurePromise,
        pending.interruptionPromise,
      ]);
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

  private queueKimiSessionUpdate(worker: KimiWorker, notification: SessionNotification): Promise<void> {
    const delivery = worker.sessionUpdateChain.then(async () => {
      await this.handleSessionUpdate(worker, notification);
    });
    worker.sessionUpdateChain = delivery.catch((error: unknown) => {
      console.error(`Kimi ACP session update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return delivery;
  }

  private async drainKimiSessionUpdates(worker: KimiWorker): Promise<void> {
    while (true) {
      const acceptedThrough = worker.sessionUpdateChain;
      await acceptedThrough;
      if (acceptedThrough === worker.sessionUpdateChain) {
        return;
      }
    }
  }

  private async handleSessionUpdate(worker: KimiWorker, notification: SessionNotification): Promise<void> {
    this.markActivity(worker);
    if (worker.hookRelayActive && this.hookRelayRuntime) {
      await withTimeout(
        this.hookRelayRuntime.drainAcceptedEvents(),
        SESSION_UPDATE_HOOK_DRAIN_TIMEOUT_MS,
        "Kimi Hook relay drain before ACP update timed out",
      ).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }
    if (worker.removed) {
      return;
    }
    if (this.isIgnoredKimiHookTurnActive(worker, Date.now())) {
      return;
    }
    const continuation = this.backgroundContinuationForUpdate(worker);
    if (continuation) {
      continuation.lastSeenAt = Date.now();
    }
    const pending = continuation ? null : worker.pendingTurn;
    // Replayed history arrives with neither a foreground turn nor a retained
    // task-origin continuation, so it remains ignored. Kimi 0.33 can start a
    // synthetic task-origin turn after the foreground ACP prompt has returned;
    // those updates must be captured by the continuation instead of dropped.
    if (!pending && !continuation) {
      return;
    }
    const update = notification.update;
    const sessionId = worker.currentSessionId ?? notification.sessionId;

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text" || !update.content.text) {
        return;
      }
      let text = update.content.text;
      if (continuation) {
        if (continuation.assistantBoundaryPending) {
          continuation.assistantBoundaryPending = false;
          const trailingNewlines = continuation.assistantText.match(/\n*$/)?.[0].length ?? 0;
          const normalizedText = text.startsWith(" ") ? text.slice(1) : text;
          text = `${"\n".repeat(Math.max(0, 2 - trailingNewlines))}${normalizedText}`;
        }
        continuation.assistantText += text;
        return;
      }
      if (!pending) {
        return;
      }
      if (pending.assistantBoundaryPending) {
        pending.assistantBoundaryPending = false;
        const trailingNewlines = pending.assistantText.match(/\n*$/)?.[0].length ?? 0;
        const normalizedText = text.startsWith(" ") ? text.slice(1) : text;
        text = `${"\n".repeat(Math.max(0, 2 - trailingNewlines))}${normalizedText}`;
      }
      pending.assistantText += text;
      pending.onProgress?.(pending.assistantText);
      this.queueEngineEvent(pending, {
        type: "assistant_text",
        text,
        delta: true,
        sessionId,
      });
      return;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      if (pending && update.content.type === "text" && update.content.text) {
        this.queueEngineEvent(pending, {
          type: "thinking",
          text: update.content.text,
          sessionId,
        });
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      if (continuation?.assistantText) {
        continuation.assistantBoundaryPending = true;
      } else if (pending?.assistantText) {
        pending.assistantBoundaryPending = true;
      }
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
        await this.emitToolResult(worker, state, update.status === "failed");
      }
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      if (continuation?.assistantText) {
        continuation.assistantBoundaryPending = true;
      } else if (pending?.assistantText) {
        pending.assistantBoundaryPending = true;
      }
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
        await this.emitToolResult(worker, state, update.status === "failed");
      }
    }
  }

  private backgroundContinuationForUpdate(worker: KimiWorker): KimiBackgroundContinuation | undefined {
    const activeTaskId = worker.activeHookTurn?.originKind === "task"
      ? worker.activeHookTurn.continuationTaskId
      : undefined;
    if (activeTaskId) {
      return worker.backgroundContinuations.get(activeTaskId);
    }
    if (worker.pendingTurn) {
      return undefined;
    }
    const candidates = [...worker.backgroundContinuations.values()].filter((entry) => !entry.activeTurnId);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private nestedTasksForContinuation(worker: KimiWorker, continuationTaskId: string): KimiBackgroundTask[] {
    return [...worker.backgroundTasks.values()].filter((task) => (
      task.taskId !== continuationTaskId && task.continuationTaskId === continuationTaskId
    ));
  }

  private hasInternalStageForContinuation(worker: KimiWorker, continuationTaskId: string): boolean {
    const nestedTasks = this.nestedTasksForContinuation(worker, continuationTaskId);
    return nestedTasks.length === 1 && nestedTasks[0]?.internalContinuationStage === true;
  }

  private attachNestedTaskToContinuation(
    worker: KimiWorker,
    task: KimiBackgroundTask,
    continuation: KimiBackgroundContinuation,
  ): void {
    if (task.taskId === continuation.taskId) {
      return;
    }
    const newlyAttached = task.continuationTaskId !== continuation.taskId;
    task.continuationTaskId = continuation.taskId;
    const nestedTasks = this.nestedTasksForContinuation(worker, continuation.taskId);
    if (!nestedTasks.includes(task)) {
      nestedTasks.push(task);
    }
    const wasInternalStage = task.internalContinuationStage === true;
    const isInternalStage = continuation.status === "completed" && nestedTasks.length === 1;
    if (isInternalStage) {
      task.internalContinuationStage = true;
      task.suppressUserDelivery = true;
    } else {
      // Failed-task retries and fan-out branches replace the current review;
      // they need their own later review and must not inherit internal-stage
      // suppression from the first child observed.
      for (const candidate of nestedTasks) {
        if (!candidate.internalContinuationStage) {
          continue;
        }
        candidate.internalContinuationStage = false;
        if (!candidate.ownerAgentId || candidate.ownerAgentId === "main") {
          candidate.suppressUserDelivery = undefined;
        }
      }
    }
    continuation.lastSeenAt = Date.now();

    // Text emitted before a nested detached stage is an intermediate status,
    // not the reviewed result that should eventually reach the user.
    if ((newlyAttached || !wasInternalStage) && isInternalStage) {
      continuation.assistantText = "";
      continuation.assistantBoundaryPending = false;
    }

    // A Stop hook can race the TaskStarted hook. Once a nested stage is known,
    // cancel only a successful terminal candidate; failures remain terminal.
    if (isInternalStage && continuation.pendingTerminal?.status === "completed") {
      continuation.pendingTerminal = undefined;
      if (continuation.terminalTimer) {
        clearTimeout(continuation.terminalTimer);
        continuation.terminalTimer = undefined;
      }
      const active = worker.activeHookTurn;
      if (active?.originKind === "task" && active.continuationTaskId === continuation.taskId) {
        continuation.activeTurnId = active.turnId;
      }
    }
    this.armKimiContinuationFallback(worker, continuation);
  }

  private backgroundContinuationTurnBusy(worker: KimiWorker): boolean {
    return worker.backgroundContinuations.size > 0;
  }

  private async waitForBackgroundContinuation(worker: KimiWorker, abortSignal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const waiter: KimiBackgroundContinuationWaiter = { resolve, reject, abortSignal };
      if (abortSignal) {
        waiter.abortHandler = () => {
          worker.backgroundContinuationWaiters.delete(waiter);
          abortSignal.removeEventListener("abort", waiter.abortHandler!);
          reject(new Error("Task was stopped by user"));
        };
        if (abortSignal.aborted) {
          waiter.abortHandler();
          return;
        }
        abortSignal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      worker.backgroundContinuationWaiters.add(waiter);
      this.resolveBackgroundContinuationWaiters(worker);
    });
  }

  private resolveBackgroundContinuationWaiters(worker: KimiWorker): void {
    if (this.backgroundContinuationTurnBusy(worker)) {
      return;
    }
    for (const waiter of worker.backgroundContinuationWaiters) {
      if (waiter.abortSignal && waiter.abortHandler) {
        waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.resolve();
    }
    worker.backgroundContinuationWaiters.clear();
  }

  private rejectBackgroundContinuationWaiters(worker: KimiWorker, error: Error): void {
    for (const waiter of worker.backgroundContinuationWaiters) {
      if (waiter.abortSignal && waiter.abortHandler) {
        waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.reject(error);
    }
    worker.backgroundContinuationWaiters.clear();
  }

  private adoptKimiWorkflow(worker: KimiWorker, currentWorkflowId: string, workflowId: string): void {
    if (currentWorkflowId === workflowId) {
      return;
    }
    for (const task of worker.backgroundTasks.values()) {
      if (task.workflowId === currentWorkflowId) {
        task.workflowId = workflowId;
      }
    }
    for (const continuation of worker.backgroundContinuations.values()) {
      if (continuation.workflowId === currentWorkflowId) {
        continuation.workflowId = workflowId;
      }
    }
    for (const terminal of worker.terminalBackgroundTasks.values()) {
      if (terminal.workflowId === currentWorkflowId) {
        terminal.workflowId = workflowId;
      }
    }
  }

  private async hydrateKimiTaskOwnership(task: KimiBackgroundTask): Promise<void> {
    const ownership = await this.readBackgroundTaskOwnershipFn(
      this.engineHomePath,
      task.sessionId,
      task.taskId,
    ).catch(() => undefined);
    task.ownerAgentId ??= ownership?.ownerAgentId;
    task.subagentId ??= ownership?.subagentId;
  }

  private async promoteNestedMainTaskReview(
    task: KimiBackgroundTask,
    continuation?: KimiBackgroundContinuation,
  ): Promise<void> {
    if (!task.internalContinuationStage) {
      return;
    }
    await this.hydrateKimiTaskOwnership(task);
    if (task.ownerAgentId && task.ownerAgentId !== "main") {
      return;
    }

    // A nested process becomes the workflow successor when Kimi gives it its
    // own task-origin review. It must no longer inherit the parent's internal
    // delivery suppression.
    task.internalContinuationStage = false;
    task.continuationTaskId = undefined;
    task.suppressUserDelivery = undefined;
    if (continuation) {
      continuation.suppressUserDelivery = undefined;
    }
  }

  private async adoptNestedKimiTaskWorkflow(worker: KimiWorker, task: KimiBackgroundTask): Promise<void> {
    if (task.kind !== "process" && !task.taskId.startsWith("bash-")) {
      return;
    }
    await this.hydrateKimiTaskOwnership(task);
    if (!task.ownerAgentId || task.ownerAgentId === "main") {
      return;
    }

    // Process tasks spawned inside a subagent are implementation stages. The
    // owning agent's reviewed response is the user-facing result, regardless
    // of whether that agent itself runs in the foreground or background.
    task.suppressUserDelivery = true;

    const parentCandidates = [...worker.backgroundTasks.values()].filter((candidate) => (
      candidate !== task && candidate.kind === "agent"
    ));
    for (const candidate of parentCandidates) {
      if (!candidate.subagentId) {
        await this.hydrateKimiTaskOwnership(candidate);
      }
    }
    const parent = parentCandidates.find((candidate) => candidate.subagentId === task.ownerAgentId);
    if (!parent) {
      return;
    }

    this.adoptKimiWorkflow(worker, task.workflowId, parent.workflowId);
    task.workflowId = parent.workflowId;
    task.ownerTurnId = parent.ownerTurnId;
    task.onEngineEvent = parent.onEngineEvent ?? task.onEngineEvent;
    task.onApprovalRequest = parent.onApprovalRequest ?? task.onApprovalRequest;
    task.continuationTaskId = parent.continuationTaskId;
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
    if (this.backgroundContinuationForUpdate(worker)) {
      return;
    }
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

  private async emitToolResult(worker: KimiWorker, state: KimiToolState, isError: boolean): Promise<void> {
    if (state.emittedResult) {
      return;
    }
    this.maybeEmitToolUse(worker, state);
    state.emittedResult = true;
    const output = stringifyOutput(state.rawOutput) ?? state.latestContentText;
    await this.captureBackgroundTaskToolOutput(worker, state.toolName, output, isError);
    if (this.backgroundContinuationForUpdate(worker)) {
      return;
    }
    const pending = worker.pendingTurn;
    if (!pending) {
      return;
    }
    this.queueEngineEvent(pending, {
      type: "tool_result",
      toolUseId: state.toolCallId,
      toolName: state.toolName,
      output,
      isError,
      sessionId: worker.currentSessionId ?? undefined,
    });
  }

  private async captureBackgroundTaskToolOutput(
    worker: KimiWorker,
    toolName: string,
    output: string | undefined,
    isError = false,
  ): Promise<void> {
    // TaskStop and a successful WaitFor are authoritative terminal signals.
    // Other tool output is only a start fallback and still relies on the hook
    // relay for completion.
    if (!worker.hookRelayActive) {
      return;
    }
    const waitedTasks = isError ? null : parseKimiWaitForOutput(toolName, output);
    if (waitedTasks) {
      for (const waitedTask of waitedTasks) {
        await this.settleWaitForBackgroundTask(worker, waitedTask);
      }
      return;
    }
    const stopped = parseKimiStoppedTaskOutput(toolName, output);
    if (stopped) {
      await this.settleStoppedBackgroundTask(worker, stopped);
      return;
    }
    const metadata = parseKimiBackgroundTaskOutput(output);
    if (!metadata) {
      return;
    }
    const now = Date.now();
    if (this.isTerminalBackgroundTask(worker, metadata.taskId, now)) {
      return;
    }
    const continuation = this.backgroundContinuationForUpdate(worker);
    if (continuation) {
      continuation.lastSeenAt = now;
    }
    const existing = worker.backgroundTasks.get(metadata.taskId);
    if (existing?.terminalObserved) {
      return;
    }
    const task: KimiBackgroundTask = existing ?? {
      taskId: metadata.taskId,
      workflowId: continuation?.workflowId ?? metadata.taskId,
      sessionId: worker.currentSessionId ?? undefined,
      ownerTurnId: worker.pendingTurn?.turnId,
      onEngineEvent: continuation?.onEngineEvent ?? worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent,
      onApprovalRequest: continuation?.onApprovalRequest ?? worker.pendingTurn?.onApprovalRequest,
      startEmitted: false,
      lastSeenAt: now,
    };
    if (continuation) {
      this.adoptKimiWorkflow(worker, task.workflowId, continuation.workflowId);
    }
    task.description = metadata.description ?? task.description;
    task.subagentId = metadata.subagentId ?? task.subagentId;
    task.subagentName = metadata.subagentName ?? task.subagentName;
    task.kind = metadata.subagentName ? "agent" : task.kind;
    task.status = "running";
    task.lastSeenAt = now;
    task.onEngineEvent ??= continuation?.onEngineEvent ?? worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent;
    task.onApprovalRequest ??= continuation?.onApprovalRequest ?? worker.pendingTurn?.onApprovalRequest;
    task.workflowId = continuation?.workflowId ?? task.workflowId;
    task.ownerTurnId ??= worker.pendingTurn?.turnId;
    if (continuation) {
      this.attachNestedTaskToContinuation(worker, task, continuation);
    }
    worker.backgroundTasks.set(task.taskId, task);
    this.emitBackgroundTaskStarted(worker, task);
  }

  private async settleWaitForBackgroundTask(
    worker: KimiWorker,
    waitedTask: KimiWaitForTerminalTask,
  ): Promise<void> {
    const now = Date.now();
    const active = worker.activeHookTurn;
    if (active?.originKind === "task" && active.continuationTaskId === waitedTask.taskId) {
      const activeTask = worker.backgroundTasks.get(waitedTask.taskId);
      const activeContinuation = worker.backgroundContinuations.get(waitedTask.taskId);
      if (activeTask || activeContinuation) {
        if (activeTask) {
          activeTask.status = waitedTask.status;
          activeTask.description ??= waitedTask.description;
          activeTask.lastSeenAt = now;
        }
        if (activeContinuation) {
          activeContinuation.status = waitedTask.status;
          activeContinuation.summary ??= waitedTask.description;
          activeContinuation.lastSeenAt = now;
          this.armKimiContinuationFallback(worker, activeContinuation);
        }
        return;
      }
    }
    const existingTerminal = this.getTerminalBackgroundTask(worker, waitedTask.taskId, now);
    if (existingTerminal) {
      this.rememberTerminalBackgroundTask(worker, waitedTask.taskId, {
        workflowId: existingTerminal.workflowId,
        sessionId: existingTerminal.sessionId,
        status: waitedTask.status,
        summary: waitedTask.description ?? existingTerminal.summary,
        onEngineEvent: existingTerminal.onEngineEvent,
        onApprovalRequest: existingTerminal.onApprovalRequest,
        taskOriginReviewStarted: true,
        suppressUserDelivery: true,
      });
      return;
    }
    const task = worker.backgroundTasks.get(waitedTask.taskId);
    const continuation = worker.backgroundContinuations.get(waitedTask.taskId);
    if (waitedTask.source === "completed_during_wait" && !task && !continuation) {
      return;
    }
    if (task?.notificationTimer) {
      clearTimeout(task.notificationTimer);
    }
    if (continuation?.fallbackTimer) {
      clearTimeout(continuation.fallbackTimer);
    }
    if (continuation?.terminalTimer) {
      clearTimeout(continuation.terminalTimer);
    }
    continuation?.approvalAbortController.abort();
    worker.backgroundTasks.delete(waitedTask.taskId);
    worker.backgroundContinuations.delete(waitedTask.taskId);
    if (active?.originKind === "task" && active.continuationTaskId === waitedTask.taskId) {
      this.markIgnoredKimiHookTurn(worker, active.turnId, now);
      worker.activeHookTurn = undefined;
    }
    this.resolveBackgroundContinuationWaiters(worker);

    const sessionId = continuation?.sessionId ?? task?.sessionId ?? worker.currentSessionId ?? undefined;
    const summary = waitedTask.description ?? continuation?.summary ?? task?.description;
    const handler = continuation?.onEngineEvent
      ?? task?.onEngineEvent
      ?? worker.pendingTurn?.onEngineEvent
      ?? worker.onEngineEvent;
    const approvalHandler = continuation?.onApprovalRequest
      ?? task?.onApprovalRequest
      ?? worker.pendingTurn?.onApprovalRequest;
    this.rememberTerminalBackgroundTask(worker, waitedTask.taskId, {
      workflowId: continuation?.workflowId ?? task?.workflowId ?? waitedTask.taskId,
      sessionId,
      status: waitedTask.status,
      summary,
      onEngineEvent: handler,
      onApprovalRequest: approvalHandler,
      // WaitFor already delivered the terminal result to the active model turn;
      // a late synthetic task-origin turn would duplicate that delivery.
      taskOriginReviewStarted: true,
      suppressUserDelivery: true,
    });
    await this.emitEngineEvent(handler, {
      type: "task_notification",
      text: `${summary ?? "Kimi background task"}: ${waitedTask.status}; result collected by WaitFor in the active turn.`,
      sessionId,
      taskId: waitedTask.taskId,
      status: waitedTask.status,
      ...(summary ? { summary } : {}),
      suppressUserDelivery: true,
    });
  }

  private async settleStoppedBackgroundTask(
    worker: KimiWorker,
    stopped: { taskId: string; reason?: string },
  ): Promise<void> {
    const task = worker.backgroundTasks.get(stopped.taskId);
    const continuation = worker.backgroundContinuations.get(stopped.taskId);
    if (
      !task
      && !continuation
      && this.isTerminalBackgroundTask(worker, stopped.taskId, Date.now())
    ) {
      return;
    }
    if (task?.notificationTimer) {
      clearTimeout(task.notificationTimer);
    }
    if (continuation?.fallbackTimer) {
      clearTimeout(continuation.fallbackTimer);
    }
    if (continuation?.terminalTimer) {
      clearTimeout(continuation.terminalTimer);
    }
    continuation?.approvalAbortController.abort();
    worker.backgroundTasks.delete(stopped.taskId);
    worker.backgroundContinuations.delete(stopped.taskId);
    if (worker.activeHookTurn?.continuationTaskId === stopped.taskId) {
      worker.activeHookTurn = undefined;
    }
    this.resolveBackgroundContinuationWaiters(worker);

    const sessionId = continuation?.sessionId ?? task?.sessionId ?? worker.currentSessionId ?? undefined;
    const summary = continuation?.summary ?? task?.description;
    const handler = continuation?.onEngineEvent ?? task?.onEngineEvent ?? worker.onEngineEvent;
    const approvalHandler = continuation?.onApprovalRequest ?? task?.onApprovalRequest;
    this.rememberTerminalBackgroundTask(worker, stopped.taskId, {
      workflowId: continuation?.workflowId ?? task?.workflowId ?? stopped.taskId,
      sessionId,
      status: "cancelled",
      summary,
      onEngineEvent: handler,
      onApprovalRequest: approvalHandler,
      taskOriginReviewStarted: continuation?.taskOriginReviewStarted === true,
      suppressUserDelivery: continuation?.suppressUserDelivery ?? task?.suppressUserDelivery,
    });
    await this.emitEngineEvent(handler, {
      type: "task_notification",
      text: stopped.reason
        ? `${summary ?? "Kimi background task"} was stopped: ${stopped.reason}`
        : `${summary ?? "Kimi background task"} was stopped.`,
      sessionId,
      taskId: stopped.taskId,
      status: "cancelled",
      ...(summary ? { summary } : {}),
      suppressUserDelivery: true,
    });
  }

  private findWorkerForHook(sessionId: string): KimiWorker | undefined {
    const direct = this.workers.get(sessionId);
    if (direct?.currentSessionId === sessionId && !direct.removed) {
      return direct;
    }
    const seen = new Set<KimiWorker>();
    for (const worker of this.workers.values()) {
      if (seen.has(worker)) {
        continue;
      }
      seen.add(worker);
      if (!worker.removed && worker.currentSessionId === sessionId) {
        return worker;
      }
    }
    return undefined;
  }

  private async handleKimiTurnStarted(
    worker: KimiWorker,
    event: Extract<KimiHookEvent, { hookEventName: "TurnStarted" }>,
  ): Promise<void> {
    if (event.originKind !== "task") {
      worker.ignoredHookTurn = undefined;
      if (worker.activeHookTurn?.originKind === "task") {
        const previous = worker.activeHookTurn.continuationTaskId
          ? worker.backgroundContinuations.get(worker.activeHookTurn.continuationTaskId)
          : undefined;
        if (previous) {
          await this.finishKimiBackgroundContinuation(worker, previous, { status: "completed" });
        }
      }
      const terminalAlreadyArrived = Boolean(this.takePendingKimiHookTerminal(worker));
      worker.activeHookTurn = terminalAlreadyArrived
        ? undefined
        : { turnId: event.turnId, originKind: event.originKind };
      worker.tools.clear();
      return;
    }

    const promptMetadata = parseKimiTaskTurnPrompt(event.prompt);
    const explicitTaskIds = [...new Set(
      [promptMetadata.taskId, event.originTaskId, event.originName].filter((id): id is string => Boolean(id)),
    )];
    const unmatchedContinuations = [...worker.backgroundContinuations.values()]
      .filter((entry) => !entry.activeTurnId);
    const matchedOriginName = event.originName && (
      worker.backgroundTasks.has(event.originName)
      || worker.backgroundContinuations.has(event.originName)
    ) ? event.originName : undefined;
    const wireCandidateIds = [...new Set([
      ...worker.backgroundTasks.keys(),
      ...worker.backgroundContinuations.keys(),
      ...worker.terminalBackgroundTasks.keys(),
    ])];
    const recoveredTaskId = promptMetadata.taskId || event.originTaskId || matchedOriginName
      ? undefined
      : await this.resolveTaskOriginFn(this.engineHomePath, event.sessionId, wireCandidateIds)
        .catch(() => undefined);
    const unmatchedTasks = [...worker.backgroundTasks.values()].filter((entry) => (
      !worker.backgroundContinuations.has(entry.taskId)
    ));
    const taskId = promptMetadata.taskId
      ?? event.originTaskId
      ?? matchedOriginName
      ?? recoveredTaskId
      ?? (unmatchedContinuations.length === 1 ? unmatchedContinuations[0].taskId : undefined)
      ?? (unmatchedTasks.length === 1 ? unmatchedTasks[0].taskId : undefined)
      ?? `kimi-task-turn-${event.turnId}`;
    const now = Date.now();
    const resurrectionProbe = [...new Set([...explicitTaskIds, taskId])];
    const lateTerminal = resurrectionProbe
      .map((id) => ({ id, terminal: this.getTerminalBackgroundTask(worker, id, now) }))
      .find(({ id, terminal }) => terminal && !worker.backgroundContinuations.has(id));
    if (lateTerminal?.terminal) {
      const activeTaskId = worker.activeHookTurn?.originKind === "task"
        ? worker.activeHookTurn.continuationTaskId
        : undefined;
      if (
        lateTerminal.terminal.status === "cancelled"
        || lateTerminal.terminal.taskOriginReviewStarted
        || (activeTaskId && activeTaskId !== lateTerminal.id)
      ) {
        this.markIgnoredKimiHookTurn(worker, event.turnId, now);
        return;
      }

      // The raw Notification fallback may have already been delivered, but a
      // later synthetic review still owns its ACP text. Restore only the
      // continuation route (not the completed task entry), so the final review
      // is delivered as a follow-up without emitting another start event.
      lateTerminal.terminal.taskOriginReviewStarted = true;
      lateTerminal.terminal.terminalAt = now;
      const continuation: KimiBackgroundContinuation = {
        taskId: lateTerminal.id,
        workflowId: lateTerminal.terminal.workflowId,
        sessionId: event.sessionId ?? lateTerminal.terminal.sessionId,
        status: promptMetadata.status ?? lateTerminal.terminal.status,
        summary: lateTerminal.terminal.summary,
        lastSeenAt: now,
        onEngineEvent: lateTerminal.terminal.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: lateTerminal.terminal.onApprovalRequest,
        approvalAbortController: new AbortController(),
        assistantText: "",
        assistantBoundaryPending: false,
        activeTurnId: event.turnId,
        reviewTurnId: event.turnId,
        taskOriginReviewStarted: true,
        lateAfterFallback: true,
        suppressUserDelivery: lateTerminal.terminal.suppressUserDelivery,
      };
      worker.backgroundContinuations.set(lateTerminal.id, continuation);
      worker.ignoredHookTurn = undefined;
      worker.activeHookTurn = {
        turnId: event.turnId,
        originKind: event.originKind,
        continuationTaskId: lateTerminal.id,
      };
      worker.tools.clear();
      const pendingTerminal = this.takePendingKimiHookTerminal(worker);
      if (pendingTerminal) {
        this.scheduleKimiContinuationFinish(worker, continuation, pendingTerminal);
      } else {
        this.armKimiContinuationFallback(worker, continuation);
      }
      return;
    }

    const existingContinuation = worker.backgroundContinuations.get(taskId);
    if (worker.activeHookTurn?.originKind === "task") {
      const activeTaskId = worker.activeHookTurn.continuationTaskId;
      const previous = activeTaskId
        ? worker.backgroundContinuations.get(activeTaskId)
        : undefined;
      if (worker.activeHookTurn.turnId === event.turnId || (previous && activeTaskId === taskId)) {
        if (previous) {
          previous.lastSeenAt = now;
          this.armKimiContinuationFallback(worker, previous);
        }
        return;
      }
      if (previous) {
        await this.finishKimiBackgroundContinuation(worker, previous, { status: "completed" });
      }
    }
    const sourceTask = worker.backgroundTasks.get(taskId) ?? {
      taskId,
      workflowId: taskId,
      sessionId: event.sessionId,
      onEngineEvent: worker.onEngineEvent,
      startEmitted: false,
      lastSeenAt: Date.now(),
    };
    sourceTask.sessionId ??= event.sessionId;
    sourceTask.status = promptMetadata.status ?? sourceTask.status;
    sourceTask.lastSeenAt = Date.now();
    sourceTask.onEngineEvent ??= worker.onEngineEvent;
    worker.backgroundTasks.set(taskId, sourceTask);
    this.emitBackgroundTaskStarted(worker, sourceTask);
    await this.promoteNestedMainTaskReview(sourceTask, existingContinuation);

    const continuation = existingContinuation ?? worker.backgroundContinuations.get(taskId) ?? {
      taskId,
      workflowId: sourceTask.workflowId,
      sessionId: event.sessionId,
      status: promptMetadata.status,
      summary: sourceTask.description,
      lastSeenAt: Date.now(),
      onEngineEvent: sourceTask.onEngineEvent ?? worker.onEngineEvent,
      onApprovalRequest: sourceTask.onApprovalRequest,
      approvalAbortController: new AbortController(),
      assistantText: "",
      assistantBoundaryPending: false,
    };
    this.adoptKimiWorkflow(worker, continuation.workflowId, sourceTask.workflowId);
    continuation.workflowId = sourceTask.workflowId;
    continuation.sessionId ??= event.sessionId;
    continuation.status ??= promptMetadata.status;
    continuation.summary ??= sourceTask.description;
    continuation.lastSeenAt = Date.now();
    continuation.onEngineEvent ??= sourceTask.onEngineEvent ?? worker.onEngineEvent;
    continuation.onApprovalRequest ??= sourceTask.onApprovalRequest;
    continuation.activeTurnId = event.turnId;
    continuation.reviewTurnId = event.turnId;
    continuation.taskOriginReviewStarted = true;
    continuation.suppressUserDelivery ||= sourceTask.suppressUserDelivery;
    if (continuation.fallbackTimer) {
      clearTimeout(continuation.fallbackTimer);
      continuation.fallbackTimer = undefined;
    }
    worker.backgroundContinuations.set(taskId, continuation);
    worker.ignoredHookTurn = undefined;
    worker.activeHookTurn = {
      turnId: event.turnId,
      originKind: event.originKind,
      continuationTaskId: taskId,
    };
    worker.tools.clear();

    const pendingTerminal = this.takePendingKimiHookTerminal(worker);
    if (pendingTerminal) {
      this.scheduleKimiContinuationFinish(worker, continuation, pendingTerminal);
    } else {
      this.armKimiContinuationFallback(worker, continuation);
    }
  }

  private takePendingKimiHookTerminal(worker: KimiWorker): KimiHookTerminal | undefined {
    const pending = worker.pendingHookTerminal;
    worker.pendingHookTerminal = undefined;
    if (!pending || Date.now() - pending.receivedAt > PENDING_HOOK_TERMINAL_TTL_MS) {
      return undefined;
    }
    return pending.terminal;
  }

  private pruneIgnoredKimiHookTerminals(worker: KimiWorker, now: number): void {
    while (
      worker.ignoredHookTerminalStarts.length > 0
      && now - worker.ignoredHookTerminalStarts[0] > PENDING_HOOK_TERMINAL_TTL_MS
    ) {
      worker.ignoredHookTerminalStarts.shift();
    }
  }

  private markIgnoredKimiHookTurn(worker: KimiWorker, turnId: string, now: number): void {
    this.pruneIgnoredKimiHookTerminals(worker, now);
    worker.ignoredHookTurn = { turnId, startedAt: now };
    // Stop/StopFailure can arrive before TurnStarted. If one is already
    // buffered, it belongs to this ignored tombstoned turn and must not be
    // inherited by the next live continuation.
    if (this.takePendingKimiHookTerminal(worker)) {
      return;
    }
    worker.ignoredHookTerminalStarts.push(now);
  }

  private consumeIgnoredKimiHookTerminal(worker: KimiWorker): boolean {
    this.pruneIgnoredKimiHookTerminals(worker, Date.now());
    if (worker.ignoredHookTerminalStarts.length === 0) {
      return false;
    }
    worker.ignoredHookTerminalStarts.shift();
    if (worker.ignoredHookTerminalStarts.length === 0) {
      worker.ignoredHookTurn = undefined;
    }
    return true;
  }

  private isIgnoredKimiHookTurnActive(worker: KimiWorker, now: number): boolean {
    const ignored = worker.ignoredHookTurn;
    if (!ignored) {
      return false;
    }
    if (now - ignored.startedAt > PENDING_HOOK_TERMINAL_TTL_MS) {
      worker.ignoredHookTurn = undefined;
      return false;
    }
    return true;
  }

  private async handleKimiHookTerminal(worker: KimiWorker, terminal: KimiHookTerminal): Promise<void> {
    if (this.consumeIgnoredKimiHookTerminal(worker)) {
      return;
    }
    const active = worker.activeHookTurn;
    if (!active) {
      worker.pendingHookTerminal = { terminal, receivedAt: Date.now() };
      return;
    }
    if (active.originKind !== "task" || !active.continuationTaskId) {
      worker.activeHookTurn = undefined;
      return;
    }
    const continuation = worker.backgroundContinuations.get(active.continuationTaskId);
    if (continuation) {
      if (terminal.status === "completed" && this.hasInternalStageForContinuation(worker, continuation.taskId)) {
        continuation.lastSeenAt = Date.now();
        continuation.activeTurnId = active.turnId;
        this.armKimiContinuationFallback(worker, continuation);
        return;
      }
      this.scheduleKimiContinuationFinish(worker, continuation, terminal);
    } else {
      worker.activeHookTurn = undefined;
    }
  }

  private scheduleKimiContinuationFinish(
    worker: KimiWorker,
    continuation: KimiBackgroundContinuation,
    terminal: KimiHookTerminal,
  ): void {
    continuation.activeTurnId = undefined;
    continuation.lastSeenAt = Date.now();
    continuation.pendingTerminal = terminal;
    if (continuation.terminalTimer) {
      clearTimeout(continuation.terminalTimer);
    }
    if (this.hookTerminalGraceMs <= 0) {
      continuation.terminalTimer = undefined;
      this.finishKimiContinuationAfterSessionUpdates(worker, continuation, terminal);
      return;
    }
    continuation.terminalTimer = setTimeout(() => {
      continuation.terminalTimer = undefined;
      const pendingTerminal = continuation.pendingTerminal;
      if (!pendingTerminal) {
        return;
      }
      this.finishKimiContinuationAfterSessionUpdates(worker, continuation, pendingTerminal);
    }, this.hookTerminalGraceMs);
    continuation.terminalTimer.unref?.();
  }

  private finishKimiContinuationAfterSessionUpdates(
    worker: KimiWorker,
    continuation: KimiBackgroundContinuation,
    terminal: KimiHookTerminal,
  ): void {
    // ACP text and the independent Stop Hook can arrive in either order. Queue
    // terminal delivery behind every accepted ACP update so finishing cannot
    // clear the continuation route while its final text is being dispatched.
    void this.drainKimiSessionUpdates(worker).then(async () => {
      if (
        worker.backgroundContinuations.get(continuation.taskId) !== continuation
        || continuation.pendingTerminal !== terminal
      ) {
        return;
      }
      continuation.pendingTerminal = undefined;
      await this.finishKimiBackgroundContinuation(worker, continuation, terminal);
    }).catch((error: unknown) => {
      console.error(`Kimi continuation drain failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private armKimiContinuationFallback(worker: KimiWorker, continuation: KimiBackgroundContinuation): void {
    if (continuation.fallbackTimer || this.backgroundContinuationGraceMs <= 0) {
      return;
    }
    continuation.fallbackTimer = setTimeout(() => {
      continuation.fallbackTimer = undefined;
      void this.finishKimiContinuationAfterRelayDrain(worker, continuation);
    }, this.backgroundContinuationGraceMs);
    continuation.fallbackTimer.unref?.();
  }

  private async finishKimiContinuationAfterRelayDrain(
    worker: KimiWorker,
    continuation: KimiBackgroundContinuation,
  ): Promise<void> {
    if (this.hookRelayRuntime) {
      await withTimeout(
        this.hookRelayRuntime.drainAcceptedEvents(),
        HOOK_RELAY_DRAIN_TIMEOUT_MS,
        "Kimi Hook relay drain timed out",
      ).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }
    if (!worker.backgroundContinuations.has(continuation.taskId)) {
      return;
    }
    if (worker.pendingTurn) {
      this.armKimiContinuationFallback(worker, continuation);
      return;
    }
    const activeHookTurn = worker.activeHookTurn;
    if (activeHookTurn) {
      const ownsActiveReview = activeHookTurn.originKind === "task"
        && activeHookTurn.continuationTaskId === continuation.taskId;
      if (!ownsActiveReview) {
        this.armKimiContinuationFallback(worker, continuation);
        return;
      }
      if (this.hasInternalStageForContinuation(worker, continuation.taskId)) {
        this.armKimiContinuationFallback(worker, continuation);
        return;
      }

      const reviewSessionId = continuation.sessionId ?? worker.currentSessionId;
      const reviewTurnId = continuation.reviewTurnId ?? continuation.activeTurnId;
      const recoveredReview = reviewSessionId && reviewTurnId
        ? await this.readTaskReviewTextFn(
            this.engineHomePath,
            reviewSessionId,
            continuation.taskId,
            reviewTurnId,
          ).catch(() => undefined)
        : undefined;
      if (recoveredReview === undefined) {
        // The review may be in a long silent tool call. Keep waiting until the
        // wire itself records turn.ended; elapsed time alone is not terminal.
        this.armKimiContinuationFallback(worker, continuation);
        return;
      }
      if (!continuation.assistantText.trim() && recoveredReview.trim()) {
        continuation.assistantText = recoveredReview;
      }
      await this.finishKimiBackgroundContinuation(worker, continuation, {
        status: continuation.status === "failed" ? "failed" : "completed",
      });
      return;
    }
    const pendingTerminal = this.takePendingKimiHookTerminal(worker);
    await this.finishKimiBackgroundContinuation(worker, continuation, pendingTerminal ?? {
      status: continuation.status === "failed" ? "failed" : "completed",
    });
  }

  private async finishKimiBackgroundContinuation(
    worker: KimiWorker,
    continuation: KimiBackgroundContinuation,
    terminal: KimiHookTerminal,
  ): Promise<void> {
    if (worker.backgroundContinuations.get(continuation.taskId) !== continuation) {
      return;
    }
    if (continuation.fallbackTimer) {
      clearTimeout(continuation.fallbackTimer);
      continuation.fallbackTimer = undefined;
    }
    if (continuation.terminalTimer) {
      clearTimeout(continuation.terminalTimer);
      continuation.terminalTimer = undefined;
    }
    continuation.pendingTerminal = undefined;
    continuation.approvalAbortController.abort();
    worker.backgroundContinuations.delete(continuation.taskId);
    if (worker.activeHookTurn?.continuationTaskId === continuation.taskId) {
      worker.activeHookTurn = undefined;
    }
    this.resolveBackgroundContinuationWaiters(worker);

    const sourceTask = worker.backgroundTasks.get(continuation.taskId);
    if (sourceTask?.notificationTimer) {
      clearTimeout(sourceTask.notificationTimer);
    }
    worker.backgroundTasks.delete(continuation.taskId);

    const intermediate = [...worker.backgroundTasks.values()].some((task) => (
      task.workflowId === continuation.workflowId
    )) || [...worker.backgroundContinuations.values()].some((candidate) => (
      candidate.workflowId === continuation.workflowId
    ));
    // The underlying task's own completion survives a failed or timed-out
    // REVIEW turn: the result was already captured (continuation.rawText), so
    // a lost Stop hook or the safety timeout degrades to "deliver what we
    // have, with a note" — never to "failed" with the real output dropped.
    const finalStatus = continuation.status === "failed"
      ? "failed"
      : terminal.status === "failed" && !(terminal.safetyExpiry && continuation.status === "completed")
        ? "failed"
        : "completed";
    const streamedAssistantText = continuation.assistantText.trim();
    const capturedText = continuation.rawText?.trim() || "";
    const deliverySessionId = continuation.sessionId ?? sourceTask?.sessionId ?? worker.currentSessionId ?? undefined;
    const deliveryHandler = continuation.onEngineEvent ?? sourceTask?.onEngineEvent ?? worker.onEngineEvent;
    const deliveryApprovalHandler = continuation.onApprovalRequest ?? sourceTask?.onApprovalRequest;
    const deliverySummary = continuation.summary ?? sourceTask?.description;
    const suppressUserDelivery = continuation.suppressUserDelivery || sourceTask?.suppressUserDelivery;
    this.rememberTerminalBackgroundTask(worker, continuation.taskId, {
      workflowId: continuation.workflowId,
      sessionId: deliverySessionId,
      status: finalStatus,
      summary: deliverySummary,
      onEngineEvent: deliveryHandler,
      onApprovalRequest: deliveryApprovalHandler,
      taskOriginReviewStarted: continuation.taskOriginReviewStarted === true,
      suppressUserDelivery,
    });
    const recoveredAssistantText = continuation.taskOriginReviewStarted
      && deliverySessionId
      && continuation.reviewTurnId
      ? await this.readTaskReviewTextFn(
        this.engineHomePath,
        deliverySessionId,
        continuation.taskId,
        continuation.reviewTurnId,
      ).catch(() => undefined)
      : undefined;
    const assistantText = recoveredAssistantText?.trim() || streamedAssistantText;
    if (continuation.lateAfterFallback && !assistantText && !capturedText && !terminal.errorText?.trim()) {
      return;
    }
    const bodyText = terminal.status === "failed"
      ? [...new Set([capturedText, assistantText].filter(Boolean))].join("\n\n")
      : assistantText || capturedText;
    const rawText = [bodyText, terminal.errorText?.trim()]
      .filter(Boolean)
      .join("\n\n")
      || `${continuation.summary ?? "Kimi background task"} ${finalStatus}.`;
    const text = finalStatus === "completed"
      ? await appendSavedArtifactDeliveryTags(rawText, worker.workspacePath)
      : rawText;
    await this.emitEngineEvent(deliveryHandler, {
      type: "task_notification",
      text,
      sessionId: deliverySessionId,
      taskId: continuation.taskId,
      status: finalStatus,
      ...(deliverySummary ? { summary: deliverySummary } : {}),
      ...(intermediate || suppressUserDelivery ? { suppressUserDelivery: true } : {}),
    });
  }

  private async handleKimiHookEvent(event: KimiHookEvent): Promise<void> {
    const worker = this.findWorkerForHook(event.sessionId);
    if (!worker) {
      return;
    }
    this.markActivity(worker);
    if (event.hookEventName === "TurnStarted") {
      await this.handleKimiTurnStarted(worker, event);
      return;
    }
    if (event.hookEventName === "Stop") {
      await this.handleKimiHookTerminal(worker, { status: "completed" });
      return;
    }
    if (event.hookEventName === "StopFailure") {
      await this.handleKimiHookTerminal(worker, {
        status: "failed",
        errorText: event.errorMessage ?? event.errorType ?? "Kimi background review failed.",
      });
      return;
    }
    if (event.hookEventName === "Interrupt") {
      await this.handleKimiHookTerminal(worker, {
        status: "failed",
        errorText: event.reason ?? "Kimi background review was interrupted.",
      });
      return;
    }
    if (event.hookEventName === "TaskStarted") {
      // Foreground tools also use Kimi's task service. Only detached work can
      // outlive the foreground turn and therefore belongs in restart guards.
      if (event.detached === false) {
        return;
      }
      const now = Date.now();
      if (this.isTerminalBackgroundTask(worker, event.taskId, now)) {
        return;
      }
      const continuation = this.backgroundContinuationForUpdate(worker);
      const existing = worker.backgroundTasks.get(event.taskId);
      if (existing?.terminalObserved) {
        return;
      }
      const task: KimiBackgroundTask = existing ?? {
        taskId: event.taskId,
        workflowId: continuation?.workflowId ?? event.taskId,
        sessionId: event.sessionId,
        ownerTurnId: worker.pendingTurn?.turnId,
        onEngineEvent: continuation?.onEngineEvent ?? worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: continuation?.onApprovalRequest ?? worker.pendingTurn?.onApprovalRequest,
        startEmitted: false,
        lastSeenAt: now,
      };
      if (continuation) {
        this.adoptKimiWorkflow(worker, task.workflowId, continuation.workflowId);
      }
      task.sessionId = event.sessionId;
      task.description = event.description ?? task.description;
      task.kind = event.kind ?? task.kind;
      task.status = event.status ?? "running";
      task.lastSeenAt = now;
      task.onEngineEvent ??= continuation?.onEngineEvent ?? worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent;
      task.onApprovalRequest ??= continuation?.onApprovalRequest ?? worker.pendingTurn?.onApprovalRequest;
      task.workflowId = continuation?.workflowId ?? task.workflowId;
      task.ownerTurnId ??= worker.pendingTurn?.turnId;
      if (continuation) {
        this.attachNestedTaskToContinuation(worker, task, continuation);
      }
      worker.backgroundTasks.set(task.taskId, task);
      await this.adoptNestedKimiTaskWorkflow(worker, task);
      this.emitBackgroundTaskStarted(worker, task);
      return;
    }

    if (event.hookEventName === "SubagentStop") {
      const candidates = [...worker.backgroundTasks.values()].filter((task) => (
        task.kind === "agent" && !task.subagentResponse
      ));
      const nameMatches = event.agentName
        ? candidates.filter((task) => task.subagentName === event.agentName)
        : [];
      const task = nameMatches.length === 1
        ? nameMatches[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!task || !event.response) {
        return;
      }
      task.subagentResponse = event.response;
      task.lastSeenAt = Date.now();
      if (task.pendingNotification) {
        await this.flushKimiTaskNotification(worker, task);
      }
      return;
    }

    if (event.sourceKind && event.sourceKind !== "background_task") {
      return;
    }
    const now = Date.now();
    if (this.isTerminalBackgroundTask(worker, event.sourceId, now)) {
      return;
    }
    const existing = worker.backgroundTasks.get(event.sourceId);
    if (existing?.terminalObserved) {
      return;
    }
    const task: KimiBackgroundTask = existing ?? {
      taskId: event.sourceId,
      workflowId: event.sourceId,
      sessionId: event.sessionId,
      ownerTurnId: worker.pendingTurn?.turnId,
      onEngineEvent: worker.pendingTurn?.onEngineEvent ?? worker.onEngineEvent,
      onApprovalRequest: worker.pendingTurn?.onApprovalRequest,
      startEmitted: false,
      lastSeenAt: now,
    };
    task.status = taskStatusFromNotificationType(event.notificationType);
    task.lastSeenAt = now;
    task.pendingNotification = event;
    worker.backgroundTasks.set(task.taskId, task);
    const continuation = worker.backgroundContinuations.get(task.taskId);
    if (continuation) {
      continuation.status = task.status;
      continuation.lastSeenAt = now;
      for (const nestedTask of this.nestedTasksForContinuation(worker, continuation.taskId)) {
        this.attachNestedTaskToContinuation(worker, nestedTask, continuation);
      }
    }
    if (task.subagentResponse) {
      await this.flushKimiTaskNotification(worker, task);
      return;
    }
    if (task.notificationTimer) {
      clearTimeout(task.notificationTimer);
    }
    task.notificationTimer = setTimeout(() => {
      void this.flushKimiTaskNotification(worker, task);
    }, SUBAGENT_NOTIFICATION_GRACE_MS);
    task.notificationTimer.unref?.();
  }

  private emitBackgroundTaskStarted(worker: KimiWorker, task: KimiBackgroundTask): void {
    if (task.startEmitted) {
      return;
    }
    task.startEmitted = true;
    void this.emitEngineEvent(task.onEngineEvent ?? worker.onEngineEvent, {
      type: "background_task_started",
      taskId: task.taskId,
      sessionId: task.sessionId ?? worker.currentSessionId ?? undefined,
      ...(task.description ? { description: task.description } : {}),
    });
  }

  private async flushKimiTaskNotification(worker: KimiWorker, task: KimiBackgroundTask): Promise<void> {
    const notification = task.pendingNotification;
    if (!notification || task.terminalObserved) {
      return;
    }
    task.terminalObserved = true;
    task.pendingNotification = undefined;
    if (task.notificationTimer) {
      clearTimeout(task.notificationTimer);
      task.notificationTimer = undefined;
    }
    // Mark terminal observation synchronously before output I/O yields. The
    // task remains in the active ledger until Kimi's synthetic task-origin turn
    // reviews the result; this keeps restart protection continuous while also
    // rejecting duplicate or late lifecycle hooks.
    const status = taskStatusFromNotificationType(notification.notificationType);
    const sessionId = task.sessionId ?? worker.currentSessionId ?? undefined;
    task.sessionId ??= sessionId;
    await this.adoptNestedKimiTaskWorkflow(worker, task);
    const processOutput = task.kind === "process" || task.taskId.startsWith("bash-")
      ? await this.readBackgroundTaskOutputFn(this.engineHomePath, sessionId, task.taskId)
      : undefined;
    const rawText = task.subagentResponse?.trim()
      || processOutput
      || notification.body?.trim()
      || notification.title?.trim()
      || `${task.description ?? "Kimi background task"} ${status}.`;
    const text = status === "completed"
      ? await appendSavedArtifactDeliveryTags(rawText, worker.workspacePath)
      : rawText;
    // TaskStop can race this output read. Once another terminal path removes
    // the task or installs a tombstone, this stale flush must not resurrect it.
    if (
      worker.backgroundTasks.get(task.taskId) !== task
      || this.isTerminalBackgroundTask(worker, task.taskId, Date.now())
    ) {
      return;
    }
    const parentContinuation = task.continuationTaskId && task.continuationTaskId !== task.taskId
      ? worker.backgroundContinuations.get(task.continuationTaskId)
      : undefined;
    if (parentContinuation && task.internalContinuationStage) {
      worker.backgroundTasks.delete(task.taskId);
      parentContinuation.lastSeenAt = Date.now();
      this.armKimiContinuationFallback(worker, parentContinuation);
      this.rememberTerminalBackgroundTask(worker, task.taskId, {
        workflowId: task.workflowId,
        sessionId,
        status,
        summary: task.description,
        onEngineEvent: task.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: task.onApprovalRequest,
        taskOriginReviewStarted: true,
        suppressUserDelivery: true,
      });
      await this.emitEngineEvent(task.onEngineEvent ?? worker.onEngineEvent, {
        type: "task_notification",
        text,
        sessionId,
        taskId: task.taskId,
        status,
        ...(task.description ? { summary: task.description } : {}),
        suppressUserDelivery: true,
      });
      return;
    }
    const settlesCurrentTurn = task.ownerTurnId !== undefined
      && worker.pendingTurn?.turnId === task.ownerTurnId;
    if (settlesCurrentTurn) {
      if (worker.pendingTurn?.assistantText) {
        worker.pendingTurn.assistantBoundaryPending = true;
      }
      worker.backgroundTasks.delete(task.taskId);
      this.rememberTerminalBackgroundTask(worker, task.taskId, {
        workflowId: task.workflowId,
        sessionId,
        status,
        summary: task.description,
        onEngineEvent: task.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: task.onApprovalRequest,
        taskOriginReviewStarted: false,
        suppressUserDelivery: task.suppressUserDelivery,
      });
      await this.emitEngineEvent(task.onEngineEvent ?? worker.onEngineEvent, {
        type: "task_notification",
        text,
        sessionId,
        taskId: task.taskId,
        status,
        ...(task.description ? { summary: task.description } : {}),
        settlesCurrentTurn: true,
        suppressUserDelivery: true,
      });
      return;
    }
    const continuation = worker.backgroundContinuations.get(task.taskId) ?? {
      taskId: task.taskId,
      workflowId: task.workflowId,
      sessionId,
      lastSeenAt: Date.now(),
      onEngineEvent: task.onEngineEvent ?? worker.onEngineEvent,
      onApprovalRequest: task.onApprovalRequest,
      approvalAbortController: new AbortController(),
      assistantText: "",
      assistantBoundaryPending: false,
      suppressUserDelivery: task.suppressUserDelivery,
    };
    this.adoptKimiWorkflow(worker, continuation.workflowId, task.workflowId);
    continuation.workflowId = task.workflowId;
    continuation.sessionId ??= sessionId;
    continuation.status = status;
    continuation.summary ??= task.description;
    continuation.rawText = text;
    continuation.lastSeenAt = Date.now();
    continuation.onEngineEvent ??= task.onEngineEvent ?? worker.onEngineEvent;
    continuation.onApprovalRequest ??= task.onApprovalRequest;
    continuation.suppressUserDelivery ||= task.suppressUserDelivery;
    worker.backgroundContinuations.set(task.taskId, continuation);
    worker.backgroundTasks.set(task.taskId, task);
    this.emitBackgroundTaskStarted(worker, task);
    if (!continuation.activeTurnId) {
      this.armKimiContinuationFallback(worker, continuation);
    }
  }

  private rememberTerminalBackgroundTask(
    worker: KimiWorker,
    taskId: string,
    context: Omit<KimiTerminalBackgroundTask, "terminalAt">,
  ): void {
    const existing = worker.terminalBackgroundTasks.get(taskId);
    worker.terminalBackgroundTasks.set(taskId, {
      terminalAt: Date.now(),
      workflowId: context.workflowId ?? existing?.workflowId ?? taskId,
      sessionId: context.sessionId ?? existing?.sessionId,
      status: context.status ?? existing?.status,
      summary: context.summary ?? existing?.summary,
      onEngineEvent: context.onEngineEvent ?? existing?.onEngineEvent,
      onApprovalRequest: context.onApprovalRequest ?? existing?.onApprovalRequest,
      taskOriginReviewStarted: context.taskOriginReviewStarted || existing?.taskOriginReviewStarted === true,
      suppressUserDelivery: context.suppressUserDelivery ?? existing?.suppressUserDelivery,
    });
  }

  private getTerminalBackgroundTask(
    worker: KimiWorker,
    taskId: string,
    now: number,
  ): KimiTerminalBackgroundTask | undefined {
    const terminal = worker.terminalBackgroundTasks.get(taskId);
    if (!terminal) {
      return undefined;
    }
    if (now - terminal.terminalAt >= DEFAULT_BACKGROUND_TASK_TOMBSTONE_TTL_MS) {
      worker.terminalBackgroundTasks.delete(taskId);
      return undefined;
    }
    return terminal;
  }

  private isTerminalBackgroundTask(worker: KimiWorker, taskId: string, now: number): boolean {
    return this.getTerminalBackgroundTask(worker, taskId, now) !== undefined;
  }

  private async handlePermissionRequest(
    worker: KimiWorker,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.markActivity(worker);
    const pending = worker.pendingTurn;
    const continuation = this.backgroundContinuationForUpdate(worker);
    if (!pending && !continuation) {
      return { outcome: { outcome: "cancelled" } };
    }
    const state = worker.tools.get(request.toolCall.toolCallId);
    if (state) {
      this.maybeEmitToolUse(worker, state);
    }
    const toolName = requestToolName(request, state);
    const rawToolInput = state?.rawInput ?? maybeParseJson(state?.latestContentText) ?? {};
    const toolInput = toolName === "AskUserQuestion"
      ? normalizeKimiQuestionInput(request, rawToolInput)
      : rawToolInput;
    if (continuation) {
      await this.emitEngineEvent(continuation.onEngineEvent ?? worker.onEngineEvent, {
        type: "permission_request",
        toolName,
        toolInput,
        sessionId: worker.currentSessionId ?? request.sessionId,
      });
      const approvalRequest: EngineApprovalRequest = {
        engine: "kimi",
        toolName,
        toolInput,
        cwd: worker.workspacePath,
        sessionId: worker.currentSessionId ?? request.sessionId,
        abortSignal: continuation.approvalAbortController.signal,
        permissionSuggestions: request.options,
      };
      const denyOnFailure = (): EngineApprovalDecision => ({ behavior: "deny" });
      const decision = continuation.onApprovalRequest
        ? await Promise.race([
            Promise.resolve().then(() => continuation.onApprovalRequest!(approvalRequest)).catch(denyOnFailure),
            worker.failurePromise.catch(denyOnFailure),
          ])
        : { behavior: "deny" as const };
      return renderPermissionResponse(request, toolName, decision);
    }
    if (!pending) {
      return { outcome: { outcome: "cancelled" } };
    }
    // Both awaits below race the failure promise: an unanswered ACP
    // session/request_permission wedges the CLI, so eviction (stop/timeout/
    // destroy) must be able to unblock this handler and let it answer.
    await Promise.race([
      pending.eventChain,
      pending.failurePromise.catch(() => undefined),
      pending.interruptionPromise.catch(() => undefined),
    ]);
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
      const onApprovalRequest = pending.onApprovalRequest;
      decision = await Promise.race([
        // Promise.resolve().then(...) also catches a SYNCHRONOUS throw from the
        // handler — a bare call would escape the .catch and turn into a raw
        // JSON-RPC error response instead of a graceful deny selection.
        Promise.resolve().then(() => onApprovalRequest(approvalRequest)).catch(denyOnFailure),
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
      // An outstanding tool call IS activity, even with a silent session
      // stream. Kimi 0.31.1 does not forward AgentSwarm subagents' progress to
      // the parent session: a turn that fanned out into a swarm produced zero
      // session/update for 30+ minutes while demonstrably working, and the
      // watchdog killed it ONE SECOND before the swarm's tool_result landed —
      // executing exactly the long multi-agent tasks Kimi is best at. While any
      // tool call is still unresolved, re-arm quietly; a genuinely wedged tool
      // is still bounded by the total turn timeout.
      for (const state of worker.tools.values()) {
        if (!state.emittedResult) {
          this.armInactivityTimeout(worker, pending);
          return;
        }
      }
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
    this.rejectBackgroundContinuationWaiters(worker, error);
    this.failBackgroundTasks(worker);
    const pending = worker.pendingTurn;
    if (!pending) {
      return;
    }
    pending.stopError = pending.stopError ?? error;
    pending.rejectFailure(pending.stopError);
    this.finishPendingTurn(worker, pending);
  }

  private withDiagnostics(worker: KimiWorker, error: Error): Error {
    const normalized = normalizeKimiAcpError(error);
    const stderr = worker.stderrTail.trim();
    if (!stderr || normalized.message.includes(stderr)) {
      return normalized;
    }
    return new Error(`${normalized.message}\n\nKimi stderr:\n${stderr}`);
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
      this.pruneExpiredBackgroundTasks(worker, now);
      if (
        worker.pendingTurn
        || worker.backgroundTasks.size > 0
        || worker.backgroundContinuations.size > 0
        || worker.activeHookTurn?.originKind === "task"
        || now - worker.lastActivityAt < this.idleWorkerTtlMs
      ) {
        continue;
      }
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    }
  }

  private pruneExpiredBackgroundTasks(worker: KimiWorker, now: number): void {
    if (this.backgroundTaskMaxAgeMs > 0) {
      for (const [taskId, task] of worker.backgroundTasks.entries()) {
        if (now - task.lastSeenAt < this.backgroundTaskMaxAgeMs) {
          continue;
        }
        if (task.notificationTimer) {
          clearTimeout(task.notificationTimer);
        }
        worker.backgroundTasks.delete(taskId);
        if (!worker.backgroundContinuations.has(taskId)) {
          const sessionId = task.sessionId ?? worker.currentSessionId ?? undefined;
          this.rememberTerminalBackgroundTask(worker, taskId, {
            workflowId: task.workflowId,
            sessionId,
            status: "failed",
            summary: task.description,
            onEngineEvent: task.onEngineEvent ?? worker.onEngineEvent,
            onApprovalRequest: task.onApprovalRequest,
            taskOriginReviewStarted: false,
            suppressUserDelivery: task.suppressUserDelivery,
          });
          void this.emitEngineEvent(task.onEngineEvent ?? worker.onEngineEvent, {
            type: "task_notification",
            text: `${task.description ?? "Kimi background task"} produced no terminal notification before the safety timeout and was settled quietly.`,
            sessionId,
            taskId,
            status: "failed",
            suppressUserDelivery: true,
            ...(task.description ? { summary: task.description } : {}),
          });
        }
      }
      for (const continuation of worker.backgroundContinuations.values()) {
        if (now - continuation.lastSeenAt < this.backgroundTaskMaxAgeMs) {
          continue;
        }
        void this.finishKimiBackgroundContinuation(worker, continuation, {
          status: "failed",
          errorText: "Kimi did not finish reviewing this background result before the safety timeout.",
          safetyExpiry: true,
        });
      }
    }
    for (const [taskId, terminal] of worker.terminalBackgroundTasks.entries()) {
      if (now - terminal.terminalAt >= DEFAULT_BACKGROUND_TASK_TOMBSTONE_TTL_MS) {
        worker.terminalBackgroundTasks.delete(taskId);
      }
    }
    this.pruneIgnoredKimiHookTerminals(worker, now);
  }

  private async failBackgroundTasks(worker: KimiWorker): Promise<void> {
    if (worker.removed || (worker.backgroundTasks.size === 0 && worker.backgroundContinuations.size === 0)) {
      return;
    }
    const deliveries: Array<Promise<void>> = [];
    for (const continuation of worker.backgroundContinuations.values()) {
      if (continuation.fallbackTimer) {
        clearTimeout(continuation.fallbackTimer);
      }
      if (continuation.terminalTimer) {
        clearTimeout(continuation.terminalTimer);
      }
      continuation.approvalAbortController.abort();
      const task = worker.backgroundTasks.get(continuation.taskId);
      if (task?.notificationTimer) {
        clearTimeout(task.notificationTimer);
      }
      worker.backgroundTasks.delete(continuation.taskId);
      this.rememberTerminalBackgroundTask(worker, continuation.taskId, {
        workflowId: continuation.workflowId,
        sessionId: continuation.sessionId ?? task?.sessionId ?? worker.currentSessionId ?? undefined,
        status: "failed",
        summary: continuation.summary ?? task?.description,
        onEngineEvent: continuation.onEngineEvent ?? task?.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: continuation.onApprovalRequest ?? task?.onApprovalRequest,
        taskOriginReviewStarted: continuation.taskOriginReviewStarted === true,
        suppressUserDelivery: continuation.suppressUserDelivery ?? task?.suppressUserDelivery,
      });
      const hasLinkedReplacement = [...worker.backgroundTasks.values()].some((candidate) => (
        candidate.workflowId === continuation.workflowId
      ));
      deliveries.push(this.emitEngineEvent(continuation.onEngineEvent ?? task?.onEngineEvent ?? worker.onEngineEvent, {
        type: "task_notification",
        text: `${continuation.summary ?? task?.description ?? "Kimi background task"} stopped because the Kimi engine process exited before its result review completed.`,
        sessionId: continuation.sessionId ?? task?.sessionId ?? worker.currentSessionId ?? undefined,
        taskId: continuation.taskId,
        status: "failed",
        ...(continuation.summary || task?.description
          ? { summary: continuation.summary ?? task?.description }
          : {}),
        ...(hasLinkedReplacement || continuation.suppressUserDelivery || task?.suppressUserDelivery
          ? { suppressUserDelivery: true }
          : {}),
      }));
    }
    worker.backgroundContinuations.clear();
    for (const task of worker.backgroundTasks.values()) {
      if (task.notificationTimer) {
        clearTimeout(task.notificationTimer);
      }
      this.rememberTerminalBackgroundTask(worker, task.taskId, {
        workflowId: task.workflowId,
        sessionId: task.sessionId ?? worker.currentSessionId ?? undefined,
        status: "failed",
        summary: task.description,
        onEngineEvent: task.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: task.onApprovalRequest,
        taskOriginReviewStarted: false,
        suppressUserDelivery: task.suppressUserDelivery,
      });
      deliveries.push(this.emitEngineEvent(task.onEngineEvent ?? worker.onEngineEvent, {
        type: "task_notification",
        text: `${task.description ?? "Kimi background task"} stopped because the Kimi engine process exited before completion.`,
        sessionId: task.sessionId ?? worker.currentSessionId ?? undefined,
        taskId: task.taskId,
        status: "failed",
        ...(task.description ? { summary: task.description } : {}),
        ...(task.suppressUserDelivery ? { suppressUserDelivery: true } : {}),
      }));
    }
    worker.backgroundTasks.clear();
    worker.activeHookTurn = undefined;
    worker.ignoredHookTurn = undefined;
    worker.pendingHookTerminal = undefined;
    worker.ignoredHookTerminalStarts.length = 0;
    await Promise.allSettled(deliveries);
  }

  private removeWorker(worker: KimiWorker): void {
    // Any path that removes the worker also ends its detached work. Emit a
    // terminal event before marking it removed so timeline restart guards do
    // not retain dead tasks until the six-hour stale cutoff.
    void this.failBackgroundTasks(worker);
    this.releaseAllAcpTerminals(worker);
    worker.removed = true;
    this.rejectBackgroundContinuationWaiters(worker, new Error("Kimi ACP worker was removed"));
    for (const task of worker.backgroundTasks.values()) {
      if (task.notificationTimer) {
        clearTimeout(task.notificationTimer);
      }
    }
    worker.backgroundTasks.clear();
    for (const continuation of worker.backgroundContinuations.values()) {
      if (continuation.fallbackTimer) {
        clearTimeout(continuation.fallbackTimer);
      }
      if (continuation.terminalTimer) {
        clearTimeout(continuation.terminalTimer);
      }
      continuation.approvalAbortController.abort();
    }
    worker.backgroundContinuations.clear();
    worker.terminalBackgroundTasks.clear();
    worker.activeHookTurn = undefined;
    worker.pendingHookTerminal = undefined;
    worker.ignoredHookTerminalStarts.length = 0;
    for (const [key, candidate] of this.workers.entries()) {
      if (candidate === worker) {
        this.workers.delete(key);
      }
    }
  }

  destroy(): Promise<void> {
    if (!this.destroyPromise) {
      this.destroyed = true;
      this.destroyPromise = this.destroyInternal();
    }
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    const hookRelayPromise = this.hookRelayPromise;
    let hookRelayRuntime = this.hookRelayRuntime;
    this.hookRelayRuntime = undefined;
    if (!hookRelayRuntime && hookRelayPromise) {
      // Startup installs the relay plugin before publishing the runtime. Wait
      // for that work so destroy cannot return while files are still changing
      // or let createWorker continue after shutdown.
      hookRelayRuntime = await hookRelayPromise.catch(() => null) ?? undefined;
    }
    if (hookRelayRuntime) {
      await hookRelayRuntime.close().catch(() => undefined);
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
      await this.failBackgroundTasks(worker);
      this.killProcessTreeFn(worker.child.pid);
      this.removeWorker(worker);
    }
    this.workers.clear();
    this.pendingWorkers.clear();
  }
}
