import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";
import {
  CLAUDE_PERMISSION_MCP_TOOL_NAME,
  createClaudePermissionMcpConfig,
  resolveClaudePermissionMcpServerInvocation,
  startClaudePermissionHookServer,
  type ClaudePermissionHookServer,
} from "./claude-permission-hook.js";
import { killProcessTree } from "./process-tree.js";
import type { ApprovalMode } from "./process-adapter.js";
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

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
};

type ClaudeChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | number | null;
  terminal_reason?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
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

function getAssistantText(event: ClaudeJsonResult | undefined): string {
  if (!event || event.type !== "assistant") {
    return "";
  }

  return event.message?.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim() ?? "";
}

function appendAssistantText(existing: string, next: string): string {
  if (!next) {
    return existing;
  }

  return existing ? `${existing}\n${next}` : next;
}

function hasSendFileTag(text: string): boolean {
  return /\[send-file:[^\]]+\]/.test(text);
}

function extractSendFileTags(text: string): string[] {
  return Array.from(text.matchAll(/\[send-file:[^\]]+\]/g), (match) => match[0]);
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

  const finalSendFileTags = new Set(extractSendFileTags(finalResult));
  const intermediateSendFileTags = extractSendFileTags(intermediateDeliveryText);
  if (
    intermediateSendFileTags.length > 0 &&
    intermediateSendFileTags.every((tag) => finalSendFileTags.has(tag))
  ) {
    return finalResult;
  }

  return appendAssistantText(intermediateDeliveryText, finalResult);
}

function renderClaudeCliError(json: ClaudeJsonResult, stderr: string): string {
  const result = json.result?.trim();
  if (result) {
    return result;
  }

  if (stderr) {
    return stderr;
  }

  const details = [
    json.api_error_status ? `api_error_status=${json.api_error_status}` : undefined,
    json.subtype ? `subtype=${json.subtype}` : undefined,
    json.terminal_reason ? `terminal_reason=${json.terminal_reason}` : undefined,
  ].filter(Boolean);

  return details.length > 0
    ? `Unknown error from Claude CLI (${details.join(", ")})`
    : "Unknown error from Claude CLI";
}

function parseClaudeJsonOutput(trimmed: string): ClaudeJsonResult | ClaudeJsonResult[] {
  try {
    return JSON.parse(trimmed) as ClaudeJsonResult | ClaudeJsonResult[];
  } catch (jsonError) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) {
      throw jsonError;
    }

    try {
      return lines.map((line) => JSON.parse(line) as ClaudeJsonResult);
    } catch {
      throw jsonError;
    }
  }
}

export class ProcessClaudeAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = true;
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
      // Otherwise inherit CLAUDE_CONFIG_DIR from the parent env. If the user
      // runs their main Claude CLI with a custom config dir exported in their
      // shell, bots automatically track the same location. If nothing is
      // set, Claude uses its built-in default (~/.claude/).
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
    const args: string[] = ["-p", "--verbose", "--output-format", "stream-json"];

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
    const effectiveWorkspace = input.workspaceOverride ?? this.workspacePath;
    if (effectiveWorkspace) {
      args.push("--add-dir", effectiveWorkspace);
    }

    let permissionHookServer: ClaudePermissionHookServer | undefined;
    if (approvalMode === "normal" && input.onApprovalRequest) {
      permissionHookServer = await startClaudePermissionHookServer(input.onApprovalRequest);
      const mcpInvocation = resolveClaudePermissionMcpServerInvocation();
      args.push(
        "--mcp-config",
        JSON.stringify(createClaudePermissionMcpConfig({
          ...mcpInvocation,
          approvalUrl: permissionHookServer.url,
        })),
        "--permission-prompt-tool",
        CLAUDE_PERMISSION_MCP_TOOL_NAME,
      );
    }

    const result = await this.runClaudeCommand(args, prompt, input.abortSignal, effectiveWorkspace, input.extraEnv).finally(async () => {
      await permissionHookServer?.close();
    });
    const parsed = this.parseResult(result.stdout, {
      stderr: result.stderr,
      exitCode: result.exitCode,
    });

    return {
      text: parsed.text,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
    };
  }

  private parseResult(stdout: string, context: { stderr?: string; exitCode?: number | null } = {}): { text: string; sessionId?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } } {
    const trimmed = stdout.trim();
    const stderr = context.stderr?.trim() ?? "";
    const failedExitCode = context.exitCode !== undefined && context.exitCode !== null && context.exitCode !== 0;
    if (!trimmed) {
      if (failedExitCode) {
        throw new Error(stderr || `claude exited with code ${context.exitCode}`);
      }
      return { text: "Claude returned an empty response." };
    }

    try {
      const parsed = parseClaudeJsonOutput(trimmed);
      let json: ClaudeJsonResult | undefined;
      let assistantText = "";
      let intermediateDeliveryText = "";
      let sessionId: string | undefined;

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          if (failedExitCode) {
            throw new Error(stderr || `claude exited with code ${context.exitCode}`);
          }
          return { text: "Claude returned an empty response." };
        }

        let sawResultEvent = false;
        for (const item of parsed) {
          if (!item || typeof item !== "object") {
            continue;
          }

          if (item.type === "result") {
            sawResultEvent = true;
          }

          if (item.session_id) {
            sessionId = item.session_id;
          }

          const text = getAssistantText(item);
          if (text) {
            assistantText = appendAssistantText(assistantText, text);
            if (hasSendFileTag(text)) {
              intermediateDeliveryText = appendAssistantText(intermediateDeliveryText, text);
            }
          }

          if (item.type === "result") {
            json = item;
          }
        }

        if (!json) {
          json = [...parsed].reverse().find(
            (item): item is ClaudeJsonResult => Boolean(item && typeof item === "object"),
          );
        }

        if (!sawResultEvent && failedExitCode) {
          throw new Error(stderr || `claude exited with code ${context.exitCode}`);
        }
      } else {
        json = parsed;
        sessionId = parsed.session_id ?? undefined;
        assistantText = getAssistantText(parsed);
      }

      if (!json) {
        if (failedExitCode) {
          throw new Error(stderr || `claude exited with code ${context.exitCode}`);
        }
        return { text: "Claude returned an empty response.", sessionId };
      }

      if (json.is_error) {
        throw new Error(renderClaudeCliError(json, stderr));
      }

      const usage = json.usage ? {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cachedTokens: json.usage.cache_read_input_tokens ?? 0,
        costUsd: json.total_cost_usd ?? undefined,
      } : undefined;

      // Empty result usually means Claude ended the turn with an interactive
      // tool call (e.g. AskUserQuestion) that can't complete in headless mode.
      // Surface a hint rather than the misleading "completed the request"
      // message we used to return.
      const resultText = json.result?.trim() ?? "";
      // Claude stream-json can emit [send-file:] tags in intermediate assistant
      // messages while the final result only summarizes delivery.
      const finalText = resultText
        ? mergeIntermediateDeliveryText(resultText, intermediateDeliveryText)
        : assistantText
          ? assistantText
          : "(The engine produced no visible reply. If this keeps happening, the model may be calling an interactive tool like AskUserQuestion — ask it to reply in plain text instead.)";

      return {
        text: finalText,
        sessionId: json.session_id ?? sessionId,
        usage,
      };
    } catch (error) {
      // Re-throw real errors (e.g. is_error from Claude); only swallow JSON parse failures
      if (error instanceof SyntaxError) {
        return { text: trimmed };
      }
      throw error;
    }
  }

  private async runClaudeCommand(args: string[], stdinContent: string, abortSignal?: AbortSignal, cwdOverride?: string, extraEnv?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    const child = this.spawnClaude(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: mergeAllowedTurnExtraEnv(this.childEnv, extraEnv),
      cwd: cwdOverride ?? this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const resolveOnce = (value: { stdout: string; stderr: string; exitCode: number | null }) => {
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
          killProcessTree(child.pid);
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
        // Claude CLI returns exit code 1 for some API errors (e.g. 401 auth)
        // but still writes a valid {"is_error":true,"result":"..."} JSON to
        // stdout. Resolve with stdout in that case so parseResult() can
        // surface the real error message (triggering auth classification
        // and the onAuthRetry path in delivery.ts).
        if (code === 0 || (code !== null && stdout.trim().startsWith("{"))) {
          resolveOnce({ stdout, stderr, exitCode: code });
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
