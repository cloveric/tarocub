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

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexThreadGoalResponse {
  goal: CodexThreadGoal | null;
  sessionId?: string;
}

export interface EngineApprovalRequest {
  engine: "claude" | "codex" | "antigravity";
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
      updatedInput?: unknown;
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
      /** Engine-assigned tool call id, used to match a later tool_result. */
      toolUseId?: string;
      sessionId?: string;
    }
  | {
      type: "tool_result";
      /** Matches the toolUseId of the originating tool_use event. */
      toolUseId?: string;
      toolName?: string;
      output?: string;
      isError?: boolean;
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
    }
  | {
      type: "task_notification";
      text: string;
      sessionId?: string;
      taskId?: string;
      status?: string;
      summary?: string;
      outputFile?: string;
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
  getThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<CodexThreadGoalResponse>;
  setThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse>;
  clearThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<{ cleared: boolean; sessionId?: string }>;
  destroy?(): void;
}
