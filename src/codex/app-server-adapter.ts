import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";
import { readValidatedConfigFile } from "../telegram/instance-config.js";

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
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => AppServerChildProcess;
const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
type ApprovalMode = "normal" | "full-auto" | "bypass";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
  method?: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PendingTurn = {
  chunks: string[];
  finalText?: string;
  errorMessage?: string;
  turnId?: string;
  onProgress?: (partialText: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

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

export class CodexAppServerAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "telegram-out-only" as const;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private child: AppServerChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializeKey: string | null = null;
  private lineBuffer = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly loadedThreads = new Set<string>();

  constructor(
    private readonly codexExecutable: string,
    private readonly cwd: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
    instructionsPath?: string,
    engineHomePath?: string,
    configPath?: string,
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
    const threadId = isLogicalTelegramSessionId(sessionId)
      ? await this.startThread()
      : await this.resolveThreadForMessage(sessionId);
    const text = await this.startTurn(threadId, prompt, input.onProgress);

    return {
      text: text.trim() || `Session ${threadId} completed.`,
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  async validateExternalSession(sessionId: string): Promise<void> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);

    if (isLogicalTelegramSessionId(sessionId)) {
      return;
    }

    await this.ensureThreadLoaded(sessionId);
  }

  private async loadRuntimeOptions(): Promise<{
    approvalMode: ApprovalMode;
    effort?: string;
    model?: string;
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
    const approvalMode: ApprovalMode =
      parsed.approvalMode === "full-auto" || parsed.approvalMode === "bypass"
        ? parsed.approvalMode
        : "normal";
    const effort = typeof parsed.effort === "string" ? parsed.effort : undefined;
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
    const initializeArgs = ["app-server"];

    if (approvalMode === "bypass") {
      initializeArgs.push("-c", 'sandbox_mode="danger-full-access"');
    } else if (approvalMode === "full-auto") {
      initializeArgs.push("-c", 'sandbox_mode="workspace-write"');
    }

    if (effort) {
      const codexEffort = effort === "max" ? "xhigh" : effort;
      initializeArgs.push("-c", `model_reasoning_effort="${codexEffort}"`);
    }

    if (model) {
      initializeArgs.push("-c", `model="${model}"`);
    }

    return {
      approvalMode,
      effort,
      model,
      initializeArgs,
      initializeKey: JSON.stringify({ approvalMode, effort, model }),
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
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    return parts.join("\n");
  }

  private async ensureInitialized(runtimeOptions: {
    initializeArgs: string[];
    initializeKey: string;
  }): Promise<void> {
    if (this.initializeKey !== null && this.initializeKey !== runtimeOptions.initializeKey) {
      this.destroy();
    }

    if (!this.initializePromise) {
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
    child.stdout?.on("data", (chunk) => {
      this.handleStdout(chunk.toString());
    });

    child.stderr?.on("data", () => {
      // App-server emits JSON-RPC over stdout. stderr is ignored unless the process exits.
    });

    child.once("error", (error) => {
      this.failAllPending(error);
    });

    child.once("close", (code) => {
      this.failAllPending(new Error(`codex app-server exited with code ${code}`));
      this.child = null;
      this.initializePromise = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "cc-telegram-bridge",
        title: "cc-telegram-bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk;

    if (this.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      this.failAllPending(new Error("Engine output exceeded maximum buffer size"));
      this.child?.kill?.();
      return;
    }

    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Unknown app-server error"));
      } else {
        pending.resolve(parsed.result);
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
      }
      return;
    }

    if (parsed.method === "item/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      const item = parsed.params?.item;
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

      this.pendingTurns.delete(threadId);
      const turnErrorMessage = this.readTurnErrorMessage(parsed.params?.turn);
      if (turnErrorMessage) {
        pending.reject(new Error(turnErrorMessage));
        return;
      }

      void this.completeTurn(threadId, turnId, pending).catch((error) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
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

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;

    if (!stdin) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: unknown) => {
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
        this.pendingRequests.delete(id);
        reject(error);
      };

      this.pendingRequests.set(id, {
        resolve: resolveOnce,
        reject: rejectOnce,
      });

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

  private async startThread(): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })) as { thread?: { id?: string } };

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

    const result = (await this.request("thread/resume", {
      threadId,
    })) as { thread?: { id?: string } };
    const resumedThreadId = result.thread?.id;

    if (!resumedThreadId) {
      throw new Error(`codex app-server could not resume thread ${threadId}`);
    }

    this.loadedThreads.add(resumedThreadId);
    return resumedThreadId;
  }

  private async resolveThreadForMessage(threadId: string): Promise<string> {
    try {
      return await this.ensureThreadLoaded(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/thread not found|no rollout found/i.test(message)) {
        return await this.startThread();
      }

      throw error;
    }
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    onProgress?: (partialText: string) => void,
  ): Promise<string> {
    const pending = await new Promise<string>((resolve, reject) => {
      this.pendingTurns.set(threadId, { chunks: [], onProgress, resolve, reject });
      this.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: prompt,
            text_elements: [],
          },
        ],
      }).catch((error) => {
        this.pendingTurns.delete(threadId);
        reject(error);
      });
    });

    return pending;
  }

  private async completeTurn(threadId: string, turnId: string | undefined, pending: PendingTurn): Promise<void> {
    let text = pending.finalText ?? pending.chunks.join("");

    if (!text) {
      const turnResult = await this.readTurnResult(threadId, turnId);
      if (turnResult.errorMessage) {
        pending.reject(new Error(turnResult.errorMessage));
        return;
      }

      text = turnResult.text;
    }

    if (!text.trim() && pending.errorMessage) {
      pending.reject(new Error(pending.errorMessage));
      return;
    }

    pending.resolve(text);
  }

  private async readTurnResult(
    threadId: string,
    turnId: string | undefined,
  ): Promise<{ text: string; errorMessage?: string }> {
    const result = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
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
          }>;
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
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        return { text: item.text };
      }
    }

    return { text: "" };
  }

  destroy(): void {
    this.child?.kill?.();
    this.failAllPending(new Error("Adapter destroyed"));
    this.child = null;
    this.initializePromise = null;
    this.initializeKey = null;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingTurns.values()) {
      pending.reject(error);
    }
    this.pendingTurns.clear();
    this.loadedThreads.clear();
  }
}
