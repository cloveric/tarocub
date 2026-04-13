import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";
import type { ApprovalMode } from "./process-adapter.js";

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
  end(callback?: () => void): void;
};

type ClaudeChildProcess = {
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

interface ClaudeJsonResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const MAX_INSTRUCTIONS_CHARS = 16_000;

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

export class ProcessClaudeAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;

  constructor(
    private readonly claudeExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnClaude;
      instructionsPath?: string;
      configPath?: string;
      workspacePath?: string;
      engineHomePath?: string;
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

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const agentInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const bridgeInstructions = input.instructions ?? null;
    const approvalMode = this.configPath ? await this.loadApprovalMode() : "normal";
    const engineOptions = this.configPath ? await this.loadEngineOptions() : {};

    // Build prompt with files
    const parts: string[] = [];
    parts.push(input.text);
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    const prompt = parts.join("\n");

    // Build args
    const args: string[] = ["-p", "--output-format", "json"];

    // Agent personality from agent.md → --system-prompt
    if (agentInstructions) {
      args.push("--system-prompt", agentInstructions);
    }

    // Bridge capabilities → --append-system-prompt (trusted, not confused with injection)
    if (bridgeInstructions) {
      args.push("--append-system-prompt", bridgeInstructions);
    }

    // Resume existing session
    if (!isLogicalTelegramSessionId(sessionId)) {
      args.push("-r", sessionId);
    }

    // Approval mode
    if (approvalMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (approvalMode === "full-auto") {
      args.push("--permission-mode", "bypassPermissions");
    }

    // Effort level
    if (engineOptions.effort) {
      args.push("--effort", engineOptions.effort);
    }

    // Model override
    if (engineOptions.model) {
      args.push("--model", engineOptions.model);
    }

    // Workspace directory (where CLAUDE.md lives)
    if (this.workspacePath) {
      args.push("--add-dir", this.workspacePath);
    }

    const result = await this.runClaudeCommand(args, prompt, input.abortSignal);
    const parsed = this.parseResult(result.stdout);

    return {
      text: parsed.text,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
    };
  }

  private parseResult(stdout: string): { text: string; sessionId?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } } {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { text: "Claude returned an empty response." };
    }

    try {
      const json = JSON.parse(trimmed) as ClaudeJsonResult;

      if (json.is_error) {
        return { text: `Error: ${json.result ?? "Unknown error"}` };
      }

      const usage = json.usage ? {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cachedTokens: json.usage.cache_read_input_tokens ?? 0,
        costUsd: json.total_cost_usd ?? undefined,
      } : undefined;

      return {
        text: json.result?.trim() || "Claude completed the request.",
        sessionId: json.session_id ?? undefined,
        usage,
      };
    } catch {
      // If not valid JSON, return raw output
      return { text: trimmed };
    }
  }

  private async runClaudeCommand(args: string[], stdinContent: string, abortSignal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    const child = this.spawnClaude(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const resolveOnce = (value: { stdout: string; stderr: string }) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      };

      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      if (abortSignal) {
        const onAbort = () => {
          child.kill?.();
          rejectOnce(new Error("Task was stopped by user"));
        };
        if (abortSignal.aborted) { onAbort(); return; }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", (error) => {
        rejectOnce(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolveOnce({ stdout, stderr });
          return;
        }

        rejectOnce(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      child.stdin?.write(stdinContent, () => {
        child.stdin?.end();
      });
    });
  }
}
