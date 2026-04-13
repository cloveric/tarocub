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
};

type ClaudeChildProcess = {
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
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
};

type PendingTurn = {
  assistantText: string;
  resolve: (value: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type ClaudeWorker = {
  child: ClaudeChildProcess;
  lineBuffer: string;
  currentSessionId: string | null;
  pendingTurn: PendingTurn | null;
  instructions: string | null;
  approvalMode: ApprovalMode;
  engineOptionsKey: string;
};

const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
// No timeout — complex tasks (image generation, large projects) can run indefinitely

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

export class ClaudeStreamAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;
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
    const prompt = this.buildPrompt(input);
    const worker = this.getOrCreateWorker(sessionId, agentInstructions, bridgeInstructions, approvalMode, engineOptions);

    const response = await this.sendTurn(worker, prompt, input.abortSignal);
    const nextSessionId = response.sessionId;
    if (nextSessionId && nextSessionId !== sessionId) {
      this.workers.delete(sessionId);
      this.workers.set(nextSessionId, worker);
    }

    return {
      text: response.text,
      sessionId: nextSessionId && nextSessionId !== sessionId ? nextSessionId : undefined,
    };
  }

  private buildPrompt(input: CodexUserMessageInput): string {
    const parts: string[] = [];
    parts.push(input.text);
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    return parts.join("\n");
  }

  private getOrCreateWorker(sessionId: string, agentInstructions: string | null, bridgeInstructions: string | null, approvalMode: ApprovalMode, engineOptions?: { effort?: string; model?: string }): ClaudeWorker {
    const combinedKey = combineInstructions(agentInstructions, bridgeInstructions);
    const optionsKey = `${engineOptions?.effort ?? ""}:${engineOptions?.model ?? ""}`;
    const existing = this.workers.get(sessionId);
    if (existing) {
      if (existing.instructions === combinedKey && existing.approvalMode === approvalMode && existing.engineOptionsKey === optionsKey) {
        return existing;
      }

      if (existing.pendingTurn) {
        throw new Error("Cannot reconfigure Claude session while a turn is in flight");
      }

      const resumedSessionId = existing.currentSessionId ?? sessionId;
      existing.child.kill?.();
      this.removeWorker(existing);
      sessionId = resumedSessionId;
    }

    const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (agentInstructions) {
      args.push("--system-prompt", agentInstructions);
    }
    if (bridgeInstructions) {
      args.push("--append-system-prompt", bridgeInstructions);
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
    if (this.workspacePath) {
      args.push("--add-dir", this.workspacePath);
    }

    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    const child = this.spawnClaude(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.workspacePath,
      windowsHide: true,
    });

    const worker: ClaudeWorker = {
      child,
      lineBuffer: "",
      currentSessionId: isLogicalTelegramSessionId(sessionId) ? null : sessionId,
      pendingTurn: null,
      instructions: combinedKey,
      approvalMode,
      engineOptionsKey: optionsKey,
    };

    child.stdout?.on("data", (chunk) => {
      this.handleStdout(worker, chunk.toString());
    });

    child.stderr?.on("data", () => {
      // Claude stream-json emits structured events on stdout; stderr is only used on hard failure.
    });

    child.once("error", (error) => {
      this.failWorker(worker, error);
    });

    child.once("close", (code) => {
      this.failWorker(worker, new Error(`claude stream session exited with code ${code}`));
      this.removeWorker(worker);
    });

    this.workers.set(sessionId, worker);
    return worker;
  }

  private handleStdout(worker: ClaudeWorker, chunk: string): void {
    worker.lineBuffer += chunk;

    if (worker.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      this.failWorker(worker, new Error("Engine output exceeded maximum buffer size"));
      worker.child.kill?.();
      return;
    }

    const lines = worker.lineBuffer.split(/\r?\n/);
    worker.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      this.handleMessage(worker, line);
    }
  }

  private handleMessage(worker: ClaudeWorker, line: string): void {
    let parsed: ClaudeStreamEvent;
    try {
      parsed = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return;
    }

    if (parsed.session_id) {
      worker.currentSessionId = parsed.session_id;
    }

    if (parsed.type === "assistant" && worker.pendingTurn) {
      const text =
        parsed.message?.content
          ?.filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text ?? "")
          .join("") ?? "";
      if (text) {
        worker.pendingTurn.assistantText = text;
      }
      return;
    }

    if (parsed.type === "result" && worker.pendingTurn) {
      const pending = worker.pendingTurn;
      worker.pendingTurn = null;
      this.clearPendingTurnTimeout(pending);
      if (parsed.is_error) {
        pending.reject(new Error((parsed.result ?? pending.assistantText ?? "Claude reported an error").trim()));
        return;
      }
      pending.resolve({
        text: (parsed.result ?? pending.assistantText ?? "").trim() || "Claude completed the request.",
        sessionId: worker.currentSessionId ?? undefined,
      });
    }
  }

  private async sendTurn(worker: ClaudeWorker, prompt: string, abortSignal?: AbortSignal): Promise<CodexAdapterResponse> {
    if (worker.pendingTurn) {
      throw new Error("Claude session already has an in-flight turn");
    }

    return await new Promise<CodexAdapterResponse>((resolve, reject) => {
      const pendingTurn: PendingTurn = {
        assistantText: "",
        resolve,
        reject,
      };
      worker.pendingTurn = pendingTurn;

      if (abortSignal) {
        const onAbort = () => {
          worker.child.kill?.();
          this.failWorker(worker, new Error("Task was stopped by user"));
          this.removeWorker(worker);
        };
        if (abortSignal.aborted) { onAbort(); return; }
        abortSignal.addEventListener("abort", onAbort, { once: true });
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
            this.removeWorker(worker);
            reject(error);
          }
        },
      );
    });
  }

  destroy(): void {
    for (const worker of this.workers.values()) {
      worker.child.kill?.();
      if (worker.pendingTurn) {
        this.clearPendingTurnTimeout(worker.pendingTurn);
        worker.pendingTurn.reject(new Error("Adapter destroyed"));
        worker.pendingTurn = null;
      }
    }
    this.workers.clear();
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
  }
}
