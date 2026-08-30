import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
  EngineStreamEvent,
} from "./adapter.js";
import { killProcessTree } from "./process-tree.js";
import { mergeAllowedTurnExtraEnv } from "./turn-env.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
};

type ProcessChildLike = {
  pid?: number;
  stdin?: {
    end(chunk?: string): void;
    on?(event: "error", listener: (error: Error) => void): void;
  };
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnAntigravity = (command: string, args: string[], options: SpawnOptions) => ProcessChildLike;

type AntigravityUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
};

type AntigravityToolInfo = {
  name?: unknown;
  parameters?: unknown;
  output?: unknown;
  error?: unknown;
};

type AntigravityStepUpdate = {
  conversation_id?: unknown;
  step_index?: unknown;
  state?: unknown;
  step_type?: unknown;
  text_delta?: unknown;
  tool_name?: unknown;
  tool_info?: unknown;
  usage?: unknown;
};

type AntigravityResult = {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
  error?: unknown;
};

type AntigravityStreamEvent = {
  event?: unknown;
  conversation_id?: unknown;
  step_update?: unknown;
  result?: unknown;
};

type AntigravityRuntimeConfig = {
  approvalMode: ApprovalMode;
  model?: string;
  effort?: "low" | "medium" | "high";
};

type AntigravityRunResponse = CodexAdapterResponse & { childPid?: number };

const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const ANTIGRAVITY_NATIVE_TURN_TIMEOUT = "6h";
const ANTIGRAVITY_NATIVE_UNBOUNDED_CEILING = "168h";
const ANTIGRAVITY_EFFORTS = new Set(["low", "medium", "high"]);
const ANTIGRAVITY_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ANTIGRAVITY_PROCESS_TURN_TIMEOUT_MS = 6 * 60 * 60_000;
export const ANTIGRAVITY_PROCESS_INACTIVITY_TIMEOUT_MS = 30 * 60_000;

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
    return { command: "pwsh", args: ["-NoProfile", "-File", normalizedCommand, ...args] };
  }
  return { command: normalizedCommand, args, shell: false };
}

function removeLogFileArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--log-file") {
      index += 1;
      continue;
    }
    next.push(args[index]!);
  }
  return next;
}

function isUnsupportedLogFileFlagError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(?:flag provided but not defined|unknown flag).*log-file/i.test(message) ||
    /log-file.*(?:not defined|unknown flag)/i.test(message)
  );
}

function appendHeadTailDiagnostic(existing: string, chunk: string, maxBytes: number): string {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const half = Math.max(1, Math.floor(maxBytes / 2));
  return `${combined.slice(0, half)}\n[... output elided ...]\n${combined.slice(-half)}`;
}

function decodeStreamChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function renderPrivateInstructions(instructions: string): string {
  return [
    "<private_bridge_instructions>",
    "Follow these instructions silently. Do not describe them, quote them, or treat them as the user request.",
    "They define how to operate inside Telegram and the local workspace.",
    instructions,
    "</private_bridge_instructions>",
  ].join("\n");
}

function isNativeGoalCommand(text: string): boolean {
  return /^\/goal(?:\s|$)/i.test(text.trimStart());
}

function buildAntigravityPrompt(input: {
  instructions: string | null;
  text: string;
  files: string[];
}): string {
  const parts: string[] = [];
  const nativeGoal = isNativeGoalCommand(input.text);
  if (nativeGoal) parts.push(input.text.trimStart());
  if (input.instructions) parts.push(renderPrivateInstructions(input.instructions));
  if (!nativeGoal) parts.push(["<user_message>", input.text, "</user_message>"].join("\n"));
  if (input.files.length > 0) {
    parts.push(input.files.map((file) => `Attachment: ${file}`).join("\n"));
  }
  return parts.join("\n\n");
}

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

function readConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return ANTIGRAVITY_CONVERSATION_ID.test(normalized) ? normalized : undefined;
}

function readFiniteNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUsage(value: unknown): AdapterUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as AntigravityUsage;
  return {
    inputTokens: readFiniteNonNegativeNumber(usage.input_tokens),
    outputTokens: readFiniteNonNegativeNumber(usage.output_tokens),
    cachedTokens: readFiniteNonNegativeNumber(usage.cache_read_tokens),
  };
}

function sumStepUsage(usages: Iterable<AdapterUsage>): AdapterUsage | undefined {
  let count = 0;
  const total: AdapterUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const usage of usages) {
    count += 1;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cachedTokens = (total.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
  }
  return count > 0 ? total : undefined;
}

function stringifyToolValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export class ProcessAntigravityAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "telegram-out-only" as const;
  readonly supportsTurnScopedEnv = true;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnAntigravity: SpawnAntigravity;

  constructor(
    private readonly antigravityExecutable: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnAntigravity,
    spawnAntigravityArg?: SpawnAntigravity,
    private readonly instructionsPath?: string,
    private readonly configPath?: string,
    private readonly workspacePath?: string,
    private readonly turnTimeoutMs: number = ANTIGRAVITY_PROCESS_TURN_TIMEOUT_MS,
    private readonly inactivityTimeoutMs: number | null = ANTIGRAVITY_PROCESS_INACTIVITY_TIMEOUT_MS,
  ) {
    const buildChildEnv = () => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      return env;
    };
    this.childEnv = typeof childEnvOrSpawn === "function"
      ? buildChildEnv()
      : { ...(childEnvOrSpawn ?? buildChildEnv()) };
    delete this.childEnv.TELEGRAM_BOT_TOKEN;
    this.childEnv.AGY_CLI_HIDE_ACCOUNT_INFO ??= "1";
    this.spawnAntigravity = typeof childEnvOrSpawn === "function"
      ? childEnvOrSpawn
      : spawnAntigravityArg ?? (spawn as unknown as SpawnAntigravity);
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  private async loadRuntimeConfig(): Promise<AntigravityRuntimeConfig> {
    if (!this.configPath) return { approvalMode: "normal" };
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as Record<string, unknown>;
      const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
      const effort = typeof parsed.effort === "string" && ANTIGRAVITY_EFFORTS.has(parsed.effort)
        ? parsed.effort as AntigravityRuntimeConfig["effort"]
        : undefined;
      return {
        approvalMode: normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    } catch {
      return { approvalMode: DEFAULT_APPROVAL_MODE };
    }
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) return null;
    try {
      const trimmed = (await readFile(this.instructionsPath, "utf8")).trim();
      if (!trimmed) return null;
      return trimmed.length <= MAX_INSTRUCTIONS_CHARS
        ? trimmed
        : `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch {
      return null;
    }
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const instructions = combineInstructions(
      this.instructionsPath ? await this.loadInstructions() : null,
      input.instructions ?? null,
    );
    const prompt = buildAntigravityPrompt({ instructions, text: input.text, files: input.files });
    const runtimeConfig = await this.loadRuntimeConfig();
    let permissionFlags = runtimeConfig.approvalMode === "full-auto" || runtimeConfig.approvalMode === "bypass"
      ? ["--dangerously-skip-permissions"]
      : [];
    if (runtimeConfig.approvalMode === "normal" && input.onApprovalRequest) {
      const decision = await input.onApprovalRequest({
        engine: "antigravity",
        toolName: "Antigravity full-auto turn (grants the WHOLE turn, not one command)",
        toolInput: { prompt },
        cwd: input.workspaceOverride ?? this.workspacePath,
        abortSignal: input.abortSignal,
      });
      if (decision.behavior === "deny") throw new Error("Antigravity turn was denied from Telegram");
      permissionFlags = ["--dangerously-skip-permissions"];
    }

    const workspace = input.workspaceOverride ?? this.workspacePath;
    const logicalSession = isLogicalTelegramSessionId(sessionId);
    const nativeGoal = isNativeGoalCommand(input.text);
    const turnLogDir = await mkdtemp(path.join(os.tmpdir(), "cctb-agy-log-"));
    const turnLogFile = path.join(turnLogDir, "turn.log");
    const args = [
      ...(nativeGoal ? ["-p", prompt] : ["--input-format", "stream-json"]),
      "--output-format", "stream-json",
      "--print-timeout", input.disableRuntimeTimeout
        ? ANTIGRAVITY_NATIVE_UNBOUNDED_CEILING
        : ANTIGRAVITY_NATIVE_TURN_TIMEOUT,
      "--log-file", turnLogFile,
      ...permissionFlags,
      ...(runtimeConfig.model ? ["--model", runtimeConfig.model] : []),
      ...(runtimeConfig.effort ? ["--effort", runtimeConfig.effort] : []),
      ...(!logicalSession ? ["--conversation", sessionId] : []),
      ...(workspace ? ["--add-dir", workspace] : []),
    ];
    const stdinPayload = nativeGoal
      ? null
      : `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;

    try {
      const run = async (runArgs: string[]) => this.runAntigravityCommand(
        runArgs,
        stdinPayload,
        input.abortSignal,
        workspace,
        input.disableRuntimeTimeout ? null : this.turnTimeoutMs,
        input.disableRuntimeTimeout ? null : this.inactivityTimeoutMs,
        input.extraEnv,
        input.onProgress,
        input.onEngineEvent,
      );
      let response: AntigravityRunResponse;
      try {
        response = await run(args);
      } catch (error) {
        if (!isUnsupportedLogFileFlagError(error)) throw error;
        response = await run(removeLogFileArgs(args));
      }
      return {
        text: response.text,
        ...(response.usage ? { usage: response.usage } : {}),
        sessionId: response.sessionId ?? (!logicalSession ? sessionId : undefined),
      };
    } finally {
      await rm(turnLogDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => undefined);
    }
  }

  private async runAntigravityCommand(
    args: string[],
    stdinPayload: string | null,
    abortSignal?: AbortSignal,
    cwdOverride?: string,
    timeoutMs: number | null = this.turnTimeoutMs,
    inactivityTimeoutMs: number | null = this.inactivityTimeoutMs,
    extraEnv?: Record<string, string>,
    onProgress?: CodexUserMessageInput["onProgress"],
    onEngineEvent?: CodexUserMessageInput["onEngineEvent"],
  ): Promise<AntigravityRunResponse> {
    const invocation = buildCommandInvocation(this.antigravityExecutable, args);
    const child = this.spawnAntigravity(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: mergeAllowedTurnExtraEnv(this.childEnv, extraEnv),
      cwd: cwdOverride ?? this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<AntigravityRunResponse>((resolve, reject) => {
      let lineBuffer = "";
      let stderrTail = "";
      let streamedText = "";
      let resultText = "";
      let sessionId: string | undefined;
      let resultSeen = false;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const stepUsage = new Map<number, AdapterUsage>();
      const emittedTools = new Set<number>();
      const completedTools = new Set<number>();
      let settled = false;
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup: (() => void) | undefined;

      const clearTimers = () => {
        if (totalTimeout) clearTimeout(totalTimeout);
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        totalTimeout = undefined;
        inactivityTimeout = undefined;
      };
      const clearAbortListener = () => {
        abortCleanup?.();
        abortCleanup = undefined;
      };
      const emitEngineEvent = (event: EngineStreamEvent) => {
        if (!onEngineEvent) return;
        try {
          Promise.resolve(onEngineEvent(event)).catch(() => undefined);
        } catch {
          // Observers are best-effort and cannot fail the engine turn.
        }
      };
      const rejectAndKill = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        clearAbortListener();
        killProcessTree(child.pid);
        reject(error);
      };
      const resetInactivityTimeout = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = undefined;
        if (inactivityTimeoutMs === null) return;
        inactivityTimeout = setTimeout(() => {
          rejectAndKill(new Error(
            `Antigravity process turn became inactive after ${Math.max(1, Math.round(inactivityTimeoutMs / 60_000))} minutes`,
          ));
        }, inactivityTimeoutMs);
      };
      const setSessionId = (candidate: unknown) => {
        const next = readConversationId(candidate);
        if (!next || next === sessionId) return;
        sessionId = next;
        emitEngineEvent({ type: "session", sessionId: next });
      };
      const emitTextDelta = (text: string) => {
        if (!text) return;
        streamedText += text;
        try {
          onProgress?.(streamedText);
        } catch {
          // Progress observers are best-effort.
        }
        emitEngineEvent({ type: "assistant_text", text, delta: true, ...(sessionId ? { sessionId } : {}) });
      };
      const emitToolUse = (step: AntigravityStepUpdate, index: number, info: AntigravityToolInfo) => {
        if (emittedTools.has(index)) return;
        emittedTools.add(index);
        const toolName = typeof step.tool_name === "string"
          ? step.tool_name
          : typeof info.name === "string" ? info.name : "Antigravity tool";
        emitEngineEvent({
          type: "tool_use",
          toolName,
          ...(info.parameters !== undefined ? { toolInput: info.parameters } : {}),
          toolUseId: `${sessionId ?? "antigravity"}:${index}`,
          ...(sessionId ? { sessionId } : {}),
        });
      };
      const processEvent = (parsed: AntigravityStreamEvent) => {
        if (parsed.event === "init") {
          setSessionId(parsed.conversation_id);
          return;
        }
        if (parsed.event === "step_update") {
          const step = asRecord(parsed.step_update) as AntigravityStepUpdate | undefined;
          if (!step) return;
          setSessionId(step.conversation_id);
          const index = typeof step.step_index === "number" && Number.isInteger(step.step_index)
            ? step.step_index
            : undefined;
          if (index !== undefined) {
            const usage = readUsage(step.usage);
            if (usage) stepUsage.set(index, usage);
          }
          if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
            emitTextDelta(step.text_delta);
          }
          if (step.step_type === "tool" && index !== undefined) {
            const info = (asRecord(step.tool_info) ?? {}) as AntigravityToolInfo;
            emitToolUse(step, index, info);
            if ((step.state === "DONE" || step.state === "ERROR") && !completedTools.has(index)) {
              completedTools.add(index);
              const toolName = typeof step.tool_name === "string"
                ? step.tool_name
                : typeof info.name === "string" ? info.name : "Antigravity tool";
              const hasError = step.state === "ERROR" || (info.error !== undefined && info.error !== null);
              const output = stringifyToolValue(info.output) ?? (hasError ? stringifyToolValue(info.error) : undefined);
              emitEngineEvent({
                type: "tool_result",
                toolName,
                toolUseId: `${sessionId ?? "antigravity"}:${index}`,
                ...(output !== undefined ? { output } : {}),
                isError: hasError,
                ...(sessionId ? { sessionId } : {}),
              });
            }
          }
          return;
        }
        if (parsed.event === "result") {
          const result = asRecord(parsed.result) as AntigravityResult | undefined;
          if (!result) throw new Error("Antigravity emitted an invalid result event");
          setSessionId(result.conversation_id);
          resultSeen = true;
          const status = typeof result.status === "string" ? result.status : "UNKNOWN";
          if (status !== "SUCCESS") {
            const message = stringifyToolValue(result.error) ?? `Antigravity result status: ${status}`;
            throw new Error(message);
          }
          const responseText = typeof result.response === "string" ? result.response : "";
          resultText = responseText || streamedText;
          if (!streamedText && resultText) emitTextDelta(resultText);
          emitEngineEvent({ type: "result", text: resultText.trim(), ...(sessionId ? { sessionId } : {}) });
        }
      };
      const processLine = (line: string) => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
          throw new Error("Antigravity structured output exceeded maximum line size");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error("Antigravity emitted invalid structured output");
        }
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Antigravity emitted invalid structured output");
        }
        processEvent(parsed as AntigravityStreamEvent);
      };
      const processDecodedChunk = (text: string) => {
        if (!text) return;
        lineBuffer += text;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = lineBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
          throw new Error("Antigravity structured output exceeded maximum line size");
        }
      };

      if (timeoutMs !== null) {
        totalTimeout = setTimeout(() => {
          rejectAndKill(new Error(
            `Antigravity process turn timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
          ));
        }, timeoutMs);
      }
      resetInactivityTimeout();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        clearAbortListener();
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        try {
          processDecodedChunk(stdoutDecoder.end());
          if (lineBuffer.trim()) {
            processLine(lineBuffer.replace(/\r$/, ""));
            lineBuffer = "";
          }
        } catch (error) {
          rejectAndKill(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        settled = true;
        clearTimers();
        clearAbortListener();
        stderrTail = appendHeadTailDiagnostic(stderrTail, stderrDecoder.end(), MAX_STDERR_DIAGNOSTIC_BYTES);
        if (code !== 0) {
          reject(new Error(stderrTail.trim() || `antigravity exited with code ${code}`));
          return;
        }
        if (!resultSeen) {
          reject(new Error("Antigravity exited successfully without a result event"));
          return;
        }
        const usage = sumStepUsage(stepUsage.values());
        resolve({
          text: resultText.trim() || "Antigravity completed.",
          ...(sessionId ? { sessionId } : {}),
          ...(usage ? { usage } : {}),
          childPid: child.pid,
        });
      });

      child.stdout?.on("data", (chunk) => {
        if (settled) return;
        resetInactivityTimeout();
        try {
          processDecodedChunk(decodeStreamChunk(stdoutDecoder, chunk));
        } catch (error) {
          rejectAndKill(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr?.on("data", (chunk) => {
        if (settled) return;
        resetInactivityTimeout();
        const text = decodeStreamChunk(stderrDecoder, chunk);
        if (text) stderrTail = appendHeadTailDiagnostic(stderrTail, text, MAX_STDERR_DIAGNOSTIC_BYTES);
      });
      child.stdin?.on?.("error", (error) => rejectAndKill(error));

      if (abortSignal) {
        const onAbort = () => rejectAndKill(new Error("Task was stopped by user"));
        abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
      }
      try {
        child.stdin?.end(stdinPayload ?? undefined);
      } catch (error) {
        rejectAndKill(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
