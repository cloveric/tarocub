export interface CodexSessionHandle {
  sessionId: string;
}

export interface ExternalSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
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
  engine: "claude" | "codex" | "antigravity" | "kimi";
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
      /**
       * True when `text` is a streaming token fragment that must be concatenated
       * to the previous fragment with no separator (Codex app-server emits one
       * event per `item/agentMessage/delta`). Engines that emit a complete
       * message per event (Claude, Codex process) leave this unset so the run
       * card keeps them on separate lines.
       */
      delta?: boolean;
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
      /** Incremental text produced by a child agent while its parent tool call
       * is still running. It belongs to the tool panel, not the main answer. */
      type: "tool_progress";
      toolUseId: string;
      text: string;
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
      /** A Claude background task (run_in_background shell / subagent) was
       * spawned. Logged to the timeline so the restart busy-guard — which runs
       * in a SEPARATE process and can only see the timeline — knows the engine
       * still owns live background work after the foreground turn settles. */
      type: "background_task_started";
      taskId: string;
      sessionId?: string;
      description?: string;
    }
  | {
      /** Lifecycle-only terminal marker for a background task. It is persisted
       * immediately and never rendered; the later task_notification remains the
       * user-facing reviewed result. */
      type: "background_task_finished";
      taskId: string;
      sessionId?: string;
      status?: string;
      summary?: string;
      outputFile?: string;
    }
  | {
      type: "task_notification";
      text: string;
      sessionId?: string;
      taskId?: string;
      status?: string;
      summary?: string;
      outputFile?: string;
      /** True when this notification is being promoted into the active turn's final answer. */
      settlesCurrentTurn?: boolean;
      /** Persist lifecycle state but do not render or deliver this internal transition to the user. */
      suppressUserDelivery?: boolean;
    };

export interface CodexUserMessageInput {
  text: string;
  files: string[];
  locale?: "en" | "zh";
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
  // Inject additional user input into this session's currently running turn
  // (Codex app-server turn/steer). True only when the engine accepted the
  // steer; false means no active/addressable turn — the caller must fall back
  // to delivering the input as a normal queued message so it is never lost.
  steerActiveTurn?(sessionId: string, input: { text: string }): Promise<boolean>;
  validateExternalSession?(
    sessionId: string,
    input?: { workspaceOverride?: string },
  ): Promise<ExternalSessionInfo | void>;
  listExternalSessions?(input?: { cwd?: string; limit?: number }): Promise<ExternalSessionInfo[]>;
  getThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<CodexThreadGoalResponse>;
  setThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse>;
  // Set a goal and watch Codex's autonomous pursuit of it, streaming turn/item events
  // to onEngineEvent until it reaches a terminal status (or abortSignal fires).
  watchThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse>;
  clearThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<{ cleared: boolean; sessionId?: string }>;
  destroy?(): void | Promise<void>;
}
