import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";

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

function parseJsonEvents(stdout: string): CodexJsonEvent[] {
  const events: CodexJsonEvent[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as CodexJsonEvent);
    } catch {
      // Ignore non-JSON lines such as CLI notes.
    }
  }

  return events;
}

function extractThreadId(events: CodexJsonEvent[]): string | null {
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return event.thread_id;
    }
  }

  return null;
}

function extractLastAgentMessage(events: CodexJsonEvent[]): string | null {
  let lastMessage: string | null = null;

  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      lastMessage = event.item.text;
    }
  }

  return lastMessage;
}

function extractLastTurnFailureMessage(events: CodexJsonEvent[]): string | null {
  let lastMessage: string | null = null;

  for (const event of events) {
    if (event.type === "turn.failed" && typeof event.error?.message === "string" && event.error.message.trim()) {
      lastMessage = event.error.message;
    }
  }

  return lastMessage;
}

function extractUsage(events: CodexJsonEvent[]): { inputTokens: number; outputTokens: number; cachedTokens: number } | null {
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) {
      return {
        inputTokens: event.usage.input_tokens ?? 0,
        outputTokens: event.usage.output_tokens ?? 0,
        cachedTokens: event.usage.cached_input_tokens ?? 0,
      };
    }
  }
  return null;
}

function extractLastErrorMessage(events: CodexJsonEvent[]): string | null {
  let lastMessage: string | null = null;

  for (const event of events) {
    if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
      lastMessage = event.message;
    }
  }

  return lastMessage;
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
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;

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
  ) {
    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
            if (engineHomePath) {
              env.CODEX_HOME = engineHomePath;
            }
            return env;
          })()
        : childEnvOrSpawn ?? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
            if (engineHomePath) {
              env.CODEX_HOME = engineHomePath;
            }
            return env;
          })();

    this.spawnCodex =
      typeof childEnvOrSpawn === "function"
        ? childEnvOrSpawn
        : spawnCodexArg ?? (spawn as unknown as SpawnCodex);

    this.instructionsPath = instructionsPath;
    this.configPath = configPath;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
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
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    const prompt = parts.join("\n");
    const approvalMode = this.configPath ? await this.loadApprovalMode() : "normal";
    const engineOptions = this.configPath ? await this.loadEngineOptions() : {};
    const approvalFlags: string[] =
      approvalMode === "bypass"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : approvalMode === "full-auto"
          ? ["--full-auto"]
          : [];
    const engineFlags: string[] = [];
    if (engineOptions.effort) {
      const codexEffort = engineOptions.effort === "max" ? "xhigh" : engineOptions.effort;
      engineFlags.push("-c", `model_reasoning_effort="${codexEffort}"`);
    }
    if (engineOptions.model) {
      engineFlags.push("-m", engineOptions.model);
    }
    const args = isLogicalTelegramSessionId(sessionId)
      ? ["exec", "--json", "--skip-git-repo-check", ...approvalFlags, ...engineFlags, "-"]
      : ["exec", "resume", "--json", "--skip-git-repo-check", ...approvalFlags, ...engineFlags, sessionId, "-"];
    const result = await this.runCodexJsonCommand(args, prompt, input.abortSignal);
    const events = parseJsonEvents(result.stdout);
    const lastAgentMessage = extractLastAgentMessage(events);
    const threadId = extractThreadId(events);
    const turnFailureMessage = extractLastTurnFailureMessage(events);
    const turnUsage = extractUsage(events);

    if (turnFailureMessage) {
      throw new Error(turnFailureMessage);
    }

    if (result.exitCode !== 0) {
      const stderrMessage = result.stderr.trim();
      throw new Error(
        extractLastErrorMessage(events) ??
          (stderrMessage || `codex exited with code ${result.exitCode}`),
      );
    }

    return {
      text: lastAgentMessage?.trim() || `Session ${sessionId} completed.`,
      sessionId: threadId ?? undefined,
      usage: turnUsage ?? undefined,
    };
  }

  private async runCodexJsonCommand(args: string[], prompt: string, abortSignal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const invocation = buildCommandInvocation(this.codexExecutable, args);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      if (abortSignal) {
        const onAbort = () => {
          if (!settled) {
            settled = true;
            child.kill?.();
            reject(new Error("Task was stopped by user"));
          }
        };
        if (abortSignal.aborted) { onAbort(); return; }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdin?.end(prompt);
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr, exitCode: code });
        }
      });
    });
  }
}
