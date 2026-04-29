import { spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
  EngineStreamEvent,
} from "./adapter.js";
import { killProcessTree } from "./process-tree.js";
import { mergeAllowedTurnExtraEnv } from "./turn-env.js";

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

type ProcessChildLike = {
  pid?: number;
  stdin?: {
    end(chunk?: string): void;
  };
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => ProcessChildLike;
const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_OUTPUT_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 4 * 1024;
const MAX_CODEX_ROLLOUT_SCAN_DEPTH = 16;
export const CODEX_PROCESS_TURN_TIMEOUT_MS = 60 * 60_000;
export const CODEX_PROCESS_INACTIVITY_TIMEOUT_MS = 30 * 60_000;

type CodexJsonEvent =
  | {
      type: "thread.started";
      thread_id: string;
    }
  | {
      type: "item.completed";
      item?: {
        type?: string;
        text?: string;
      };
    }
  | {
      type: "error";
      message?: string;
    }
  | {
      type: "turn.failed";
      error?: {
        message?: string;
      };
    }
  | {
      type: "turn.completed";
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      };
    };

type CodexTurnState = {
  threadId: string | null;
  lastAgentMessage: string | null;
  lastTurnFailureMessage: string | null;
  lastErrorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
};

type EmitEngineEvent = (event: EngineStreamEvent) => void;

function createTurnState(): CodexTurnState {
  return {
    threadId: null,
    lastAgentMessage: null,
    lastTurnFailureMessage: null,
    lastErrorMessage: null,
    usage: null,
  };
}

function updateTurnStateFromLine(state: CodexTurnState, line: string, emitEngineEvent?: EmitEngineEvent): void {
  let event: CodexJsonEvent;
  try {
    event = JSON.parse(line) as CodexJsonEvent;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id;
    emitEngineEvent?.({ type: "session", sessionId: event.thread_id });
    return;
  }

  if (
    event.type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    state.lastAgentMessage = event.item.text;
    emitEngineEvent?.({
      type: "assistant_text",
      text: event.item.text,
      sessionId: state.threadId ?? undefined,
    });
    return;
  }

  if (event.type === "turn.failed" && typeof event.error?.message === "string" && event.error.message.trim()) {
    state.lastTurnFailureMessage = event.error.message;
    return;
  }

  if (event.type === "turn.completed" && event.usage) {
    state.usage = {
      inputTokens: event.usage.input_tokens ?? 0,
      outputTokens: event.usage.output_tokens ?? 0,
      cachedTokens: event.usage.cached_input_tokens ?? 0,
    };
    return;
  }

  if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
    state.lastErrorMessage = event.message;
  }
}

function looksLikeStructuredCodexLine(value: string): boolean {
  return /^\s*\{\s*(?:"type"\s*:|"jsonrpc"\s*:|"id"\s*:|"method"\s*:)/.test(value);
}

function appendTail(existing: string, chunk: string, maxBytes: number): string {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  let start = combined.length - maxBytes;
  if (start < 0) {
    start = 0;
  }

  while (start < combined.length && Buffer.byteLength(combined.slice(start), "utf8") > maxBytes) {
    start += 1;
  }

  return combined.slice(start);
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

export type ApprovalMode = "normal" | "full-auto" | "bypass";

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export class ProcessCodexAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "telegram-out-only" as const;
  readonly supportsTurnScopedEnv = true;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly turnTimeoutMs: number;
  private readonly inactivityTimeoutMs: number | null;

  /**
   * First-pass adapter that runs Codex as a process.
   * The returned session id is a logical Telegram binding key for now, not
   * persisted Codex conversation continuity.
   *
   * If instructionsPath is provided, the file contents are prepended to every
   * prompt sent to Codex (loaded fresh on each call so edits take effect
   * without restarting the service).
   *
   * If configPath is provided, config.json is loaded on each call to pick up
   * approvalMode ("normal" | "full-auto" | "bypass") for YOLO mode.
   */
  constructor(
    private readonly codexExecutable: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
    instructionsPath?: string,
    configPath?: string,
    engineHomePath?: string,
    private readonly workspacePath?: string,
    turnTimeoutMs: number = CODEX_PROCESS_TURN_TIMEOUT_MS,
    inactivityTimeoutMs: number | null = CODEX_PROCESS_INACTIVITY_TIMEOUT_MS,
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
        : spawnCodexArg ?? (spawn as unknown as SpawnCodex);

    this.instructionsPath = instructionsPath;
    this.configPath = configPath;
    this.turnTimeoutMs = turnTimeoutMs;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async validateExternalSession(sessionId: string): Promise<void> {
    const codexHome = this.resolveCodexHome();
    const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
    let raw: string;
    try {
      raw = await readFile(sessionIndexPath, "utf8");
    } catch {
      if (await this.hasLocalRolloutFile(codexHome, sessionId)) {
        return;
      }
      throw new Error(`codex process could not resume thread ${sessionId}`);
    }

    for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (parsed.id === sessionId) {
          return;
        }
      } catch {
        // Ignore malformed index rows and keep scanning.
      }
    }

    if (await this.hasLocalRolloutFile(codexHome, sessionId)) {
      return;
    }

    throw new Error(`codex process could not resume thread ${sessionId}`);
  }

  private async hasLocalRolloutFile(codexHome: string, sessionId: string): Promise<boolean> {
    const pending = [
      { dir: path.join(codexHome, "sessions"), depth: 0 },
      { dir: path.join(codexHome, "archived_sessions"), depth: 0 },
    ];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const { dir: current, depth } = pending.pop()!;
      let visitedKey = current;
      try {
        visitedKey = await realpath(current);
      } catch {
        // The following readdir will handle missing or unreadable paths.
      }
      if (visited.has(visitedKey)) {
        continue;
      }
      visited.add(visitedKey);

      try {
        const entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
        for (const entry of entries) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_CODEX_ROLLOUT_SCAN_DEPTH) {
              pending.push({ dir: entryPath, depth: depth + 1 });
            }
            continue;
          }
          if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${sessionId}.jsonl`)) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  private async loadApprovalMode(): Promise<ApprovalMode> {
    if (!this.configPath) {
      return "normal";
    }

    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as { approvalMode?: string };
      const mode = parsed.approvalMode;
      if (mode === "full-auto" || mode === "bypass") {
        return mode;
      }
      return "normal";
    } catch {
      return "normal";
    }
  }

  private async loadEngineOptions(): Promise<{ effort?: string; model?: string }> {
    if (!this.configPath) {
      return {};
    }

    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as { effort?: string; model?: string };
      return {
        effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      };
    } catch {
      return {};
    }
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
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      return null;
    }
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const instructions = combineInstructions(
      this.instructionsPath ? await this.loadInstructions() : null,
      input.instructions ?? null,
    );
    const parts: string[] = [];
    if (instructions) {
      parts.push(instructions);
      parts.push("---");
    }
    parts.push(input.text);
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    const prompt = parts.join("\n");
    const approvalMode = this.configPath ? await this.loadApprovalMode() : "normal";
    const engineOptions = this.configPath ? await this.loadEngineOptions() : {};
    const approvalFlags: string[] =
      approvalMode === "bypass"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : approvalMode === "full-auto"
          ? ["--full-auto"]
          : [];
    let effectiveApprovalFlags = approvalFlags;
    if (approvalMode === "normal" && input.onApprovalRequest) {
      const decision = await input.onApprovalRequest({
        engine: "codex",
        toolName: "Codex full-auto turn",
        toolInput: { prompt },
        cwd: input.workspaceOverride ?? this.workspacePath,
        abortSignal: input.abortSignal,
      });
      if (decision.behavior === "deny") {
        throw new Error("Codex turn was denied from Telegram");
      }
      effectiveApprovalFlags = ["--full-auto"];
    }
    const engineFlags: string[] = [];
    if (engineOptions.effort) {
      // Codex's highest reasoning level is "xhigh". Claude's new "max" is
      // strictly above xhigh (Opus 4.7 only), but Codex doesn't have an
      // equivalent, so we ceiling "max" to "xhigh" on the Codex side.
      const codexEffort = engineOptions.effort === "max" ? "xhigh" : engineOptions.effort;
      engineFlags.push("-c", `model_reasoning_effort="${codexEffort}"`);
    }
    if (engineOptions.model) {
      engineFlags.push("-m", engineOptions.model);
    }
    const args = isLogicalTelegramSessionId(sessionId)
      ? ["exec", "--json", "--skip-git-repo-check", ...effectiveApprovalFlags, ...engineFlags, "-"]
      : ["exec", "resume", "--json", "--skip-git-repo-check", "--all", ...effectiveApprovalFlags, ...engineFlags, sessionId, "-"];
    const result = await this.runCodexJsonCommand(
      args,
      prompt,
      input.abortSignal,
      input.workspaceOverride,
      input.disableRuntimeTimeout ? null : this.turnTimeoutMs,
      input.disableRuntimeTimeout ? null : this.inactivityTimeoutMs,
      input.extraEnv,
      input.onEngineEvent,
    );

    if (result.state.lastTurnFailureMessage) {
      throw new Error(result.state.lastTurnFailureMessage);
    }

    if (result.exitCode !== 0) {
      const stderrMessage = result.stderrTail.trim();
      throw new Error(
        result.state.lastErrorMessage ??
          (stderrMessage || `codex exited with code ${result.exitCode}`),
      );
    }

    return {
      text: result.state.lastAgentMessage?.trim() || `Session ${sessionId} completed.`,
      sessionId: result.state.threadId ?? undefined,
      usage: result.state.usage ?? undefined,
    };
  }

  private resolveCodexHome(): string {
    if (this.childEnv.CODEX_HOME) {
      return this.childEnv.CODEX_HOME;
    }

    const homeDir =
      process.platform === "win32"
        ? this.childEnv.USERPROFILE ?? this.childEnv.HOME ?? os.homedir()
        : this.childEnv.HOME ?? this.childEnv.USERPROFILE ?? os.homedir();

    return path.join(homeDir, ".codex");
  }

  private async runCodexJsonCommand(
    args: string[],
    prompt: string,
    abortSignal?: AbortSignal,
    cwdOverride?: string,
    timeoutMs: number | null = this.turnTimeoutMs,
    inactivityTimeoutMs: number | null = this.inactivityTimeoutMs,
    extraEnv?: Record<string, string>,
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>,
  ): Promise<{ state: CodexTurnState; stderrTail: string; exitCode: number | null }> {
    const invocation = buildCommandInvocation(this.codexExecutable, args);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: mergeAllowedTurnExtraEnv(this.childEnv, extraEnv),
      cwd: cwdOverride ?? this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ state: CodexTurnState; stderrTail: string; exitCode: number | null }>((resolve, reject) => {
      let stdoutLineBuffer = "";
      let stderrTail = "";
      let settled = false;
      const state = createTurnState();
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup: (() => void) | undefined;
      const emitEngineEvent: EmitEngineEvent = (event) => {
        if (!onEngineEvent) {
          return;
        }
        try {
          Promise.resolve(onEngineEvent(event)).catch(() => undefined);
        } catch {
          // Stream event observers are best-effort and must not fail the engine turn.
        }
      };

      const clearTimers = () => {
        totalTimeout && clearTimeout(totalTimeout);
        inactivityTimeout && clearTimeout(inactivityTimeout);
        totalTimeout = undefined;
        inactivityTimeout = undefined;
      };

      const clearAbortListener = () => {
        abortCleanup?.();
        abortCleanup = undefined;
      };

      const rejectAndKill = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        clearAbortListener();
        killProcessTree(child.pid);
        reject(error);
      };

      const resetInactivityTimeout = () => {
        inactivityTimeout && clearTimeout(inactivityTimeout);
        inactivityTimeout = undefined;
        if (inactivityTimeoutMs === null) {
          return;
        }

        inactivityTimeout = setTimeout(() => {
          rejectAndKill(
            new Error(
              `Codex process turn became inactive after ${Math.max(1, Math.round(inactivityTimeoutMs / 60_000))} minutes`,
            ),
          );
        }, inactivityTimeoutMs);
      };

      if (timeoutMs !== null) {
        totalTimeout = setTimeout(() => {
          rejectAndKill(
            new Error(`Codex process turn timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`),
          );
        }, timeoutMs);
      }

      resetInactivityTimeout();

      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimers();
          clearAbortListener();
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimers();
          clearAbortListener();
          const trailingLine = stdoutLineBuffer.trim();
          if (trailingLine) {
            updateTurnStateFromLine(state, trailingLine, emitEngineEvent);
          }
          resolve({ state, stderrTail, exitCode: code });
        }
      });

      child.stdout?.on("data", (chunk) => {
        resetInactivityTimeout();
        stdoutLineBuffer += chunk.toString();

        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
          if (line.length > MAX_OUTPUT_LINE_BUFFER_BYTES) {
            if (!looksLikeStructuredCodexLine(line)) {
              rejectAndKill(new Error("Engine output exceeded maximum buffer size"));
              return;
            }
            if (line.length > MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES) {
              rejectAndKill(new Error("Engine structured output exceeded maximum buffer size"));
              return;
            }
          }
          updateTurnStateFromLine(state, line, emitEngineEvent);
        }
        if (!settled && stdoutLineBuffer.length > MAX_OUTPUT_LINE_BUFFER_BYTES) {
          if (looksLikeStructuredCodexLine(stdoutLineBuffer)) {
            if (stdoutLineBuffer.length > MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES) {
              rejectAndKill(new Error("Engine structured output exceeded maximum buffer size"));
            }
            return;
          }
          rejectAndKill(new Error("Engine output exceeded maximum buffer size"));
        }
      });

      child.stderr?.on("data", (chunk) => {
        resetInactivityTimeout();
        stderrTail = appendTail(stderrTail, chunk.toString(), MAX_STDERR_TAIL_BYTES);
      });

      if (abortSignal) {
        const onAbort = () => {
          rejectAndKill(new Error("Task was stopped by user"));
        };
        abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        if (abortSignal.aborted) { onAbort(); return; }
      }

      try {
        child.stdin?.end(prompt);
      } catch (error) {
        rejectAndKill(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
