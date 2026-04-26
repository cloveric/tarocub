export interface CodexSessionHandle {
  sessionId: string;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
  usage?: AdapterUsage;
}

export interface EngineApprovalRequest {
  engine: "claude" | "codex";
  toolName: string;
  toolInput: unknown;
  cwd?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  permissionSuggestions?: unknown[];
}

export type EngineApprovalDecision =
  | {
      behavior: "allow";
      scope?: "once" | "session";
    }
  | {
      behavior: "deny";
    };

export type EngineStreamEvent =
  | {
      type: "session";
      sessionId?: string;
    }
  | {
      type: "assistant_text";
      text: string;
      sessionId?: string;
    }
  | {
      type: "thinking";
      text: string;
      sessionId?: string;
    }
  | {
      type: "tool_use";
      toolName: string;
      toolInput?: unknown;
      sessionId?: string;
    }
  | {
      type: "permission_request";
      toolName: string;
      toolInput?: unknown;
      sessionId?: string;
    }
  | {
      type: "result";
      text: string;
      sessionId?: string;
    };

export interface CodexUserMessageInput {
  text: string;
  files: string[];
  instructions?: string;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  requestOutputDir?: string;
  workspaceOverride?: string;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  disableRuntimeTimeout?: boolean;
}

export interface CodexAdapter {
  bridgeInstructionMode?: "generic-file-blocks" | "telegram-out-only";
  supportsTurnScopedEnv?: boolean;
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse>;
  validateExternalSession?(sessionId: string): Promise<void>;
  destroy?(): void;
}
