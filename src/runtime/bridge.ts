import type {
  CodexAdapter,
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
  ExternalSessionInfo,
} from "../codex/adapter.js";
import { findConflictingLockedChatId } from "../state/access-store.js";
import {
  type Locale,
  renderPairingMessage,
  renderSingleChatLockedMessage,
  renderUnauthorizedMessage,
} from "../telegram/message-renderer.js";
import type { GroupModeConfig } from "../telegram/instance-config.js";
import { type BridgeTurnLockWaitEvent, withBridgeTurnLock } from "./turn-lock.js";
import type { TelemetryAdapter, TelemetryTags } from "./telemetry.js";
import type { TurnPoolLike, TurnPoolWaitEvent } from "./turn-pool.js";

export interface AccessStoreLike {
  load(): Promise<{
    multiChat: boolean;
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: Array<{
      telegramUserId: number;
      telegramChatId: number;
    }>;
  }>;
  issuePairingCode(input: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<{
    code: string;
  }>;
}

export interface SessionManagerLike {
  getOrCreateSession(scope: number | BridgeConversationScope): Promise<{ sessionId: string }>;
  getExistingSession?(scope: number | BridgeConversationScope): Promise<{ sessionId: string } | null>;
  bindSession(scope: number | BridgeConversationScope, sessionId: string): Promise<void>;
}

export interface BridgeConversationScope {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}

export interface BridgeAccessInput {
  chatId: number;
  conversationChatId?: number;
  userId: number;
  chatType: string;
  messageThreadId?: number;
  conversationKey?: string;
  locale?: Locale;
}

export interface BridgeAuthorizedMessageInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
  text: string;
  replyContext?: {
    messageId: number | string;
    text: string;
  };
  messageThreadId?: number;
  conversationKey?: string;
  files: string[];
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  requestOutputDir?: string;
  workspaceOverride?: string;
  instructions?: string;
  sideChannelCommand?: string;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  disableRuntimeTimeout?: boolean;
  sessionIdOverride?: string;
  turnLockWaitNotifyAfterMs?: number;
  onTurnLockWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
  turnPoolWaitNotifyAfterMs?: number;
  onTurnPoolWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
}

export interface BridgeGroupJoinInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
}

export interface BridgeAccessDecision {
  kind: "allow" | "reply" | "deny";
  text?: string;
  reason?: "single_chat_locked";
}

function shouldDisableRuntimeTimeout(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "不设超时",
    "无超时",
    "不要超时",
  ].some((keyword) => text.includes(keyword)) || [
    "no timeout",
    "disable timeout",
    "without timeout",
  ].some((keyword) => normalized.includes(keyword));
}

function bridgeConversationLockId(scope: BridgeConversationScope): string {
  const logicalScope = scope.conversationKey
    ?? `telegram:${scope.chatId}:${scope.messageThreadId ?? "root"}`;
  return `conversation-scope:${logicalScope}`;
}

function isAuthorizedGroupUser(
  accessState: Awaited<ReturnType<AccessStoreLike["load"]>>,
  input: BridgeAccessInput,
): boolean {
  if (accessState.policy === "allowlist") {
    return accessState.allowlist.includes(input.userId);
  }
  return accessState.allowlist.includes(input.userId) ||
    accessState.pairedUsers.some((user) => user.telegramUserId === input.userId);
}

function isAllowedGroupChat(groupMode: GroupModeConfig, input: BridgeAccessInput): boolean {
  return [input.chatId, input.conversationChatId]
    .filter((chatId): chatId is number => Number.isInteger(chatId))
    .some((chatId) => groupMode.allowedChatIds.includes(chatId));
}

function hasPairedPrivateUser(
  accessState: Awaited<ReturnType<AccessStoreLike["load"]>>,
  input: BridgeAccessInput,
): boolean {
  // A pairing record binds (user, chat). Honor both dimensions so a paired user
  // is authorized only in the chat they paired from. When multiChat is off there
  // is at most one authorized chat (enforced by the chat lock), so matching only
  // the user is already safe there; the chat match closes the gap once multiChat
  // is enabled, without changing behavior for the default single-chat setup.
  return accessState.pairedUsers.some(
    (user) =>
      user.telegramUserId === input.userId &&
      (!accessState.multiChat || user.telegramChatId === input.chatId),
  );
}

export class Bridge {
  readonly supportsTurnScopedEnv: boolean;

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
    private readonly options: {
      loadGroupMode?: () => Promise<GroupModeConfig>;
      turnPool?: TurnPoolLike;
      turnPoolMetadata?: {
        channel?: string;
        instanceName?: string;
      };
      telemetry?: TelemetryAdapter;
      telemetryTags?: TelemetryTags;
    } = {},
  ) {
    this.supportsTurnScopedEnv = adapter.supportsTurnScopedEnv !== false;
  }

  destroy(): void {
    this.adapter.destroy?.();
  }

  async validateCodexThread(
    threadId: string,
    input?: { workspaceOverride?: string },
  ): Promise<ExternalSessionInfo | void> {
    if (!this.adapter.validateExternalSession) {
      throw new Error("codex thread validation unsupported");
    }

    return input === undefined
      ? await this.adapter.validateExternalSession(threadId)
      : await this.adapter.validateExternalSession(threadId, input);
  }

  async listExternalSessions(input?: { cwd?: string; limit?: number }): Promise<ExternalSessionInfo[]> {
    if (!this.adapter.listExternalSessions) {
      throw new Error("external session listing unsupported");
    }
    return await this.adapter.listExternalSessions(input);
  }

  async checkAccess(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    if (input.chatType === "bus") {
      return { kind: "allow" };
    }

    let accessState: Awaited<ReturnType<AccessStoreLike["load"]>>;
    try {
      accessState = await this.accessStore.load();
    } catch (error) {
      console.error(
        "Failed to load access state; denying access:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "deny", text: renderUnauthorizedMessage(input.locale) };
    }

    if (input.chatType !== "private") {
      const groupMode = await this.loadGroupMode();
      if (
        groupMode.enabled &&
        isAllowedGroupChat(groupMode, input) &&
        isAuthorizedGroupUser(accessState, input)
      ) {
        return { kind: "allow" };
      }
      return {
        kind: "reply",
        text: renderUnauthorizedMessage(input.locale),
      };
    }

    const conflictingChatId = findConflictingLockedChatId(accessState as Parameters<typeof findConflictingLockedChatId>[0], input.chatId);

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      return {
        kind: conflictingChatId === null ? "deny" : "reply",
        text:
          conflictingChatId === null
            ? renderUnauthorizedMessage(input.locale)
            : renderSingleChatLockedMessage(input.locale),
        ...(conflictingChatId === null ? {} : { reason: "single_chat_locked" as const }),
      };
    }

    if (accessState.policy === "pairing" && !hasPairedPrivateUser(accessState, input)) {
      if (conflictingChatId !== null) {
        return {
          kind: "reply",
          text: renderSingleChatLockedMessage(input.locale),
          reason: "single_chat_locked",
        };
      }

      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        kind: "reply",
        text: renderPairingMessage(pendingPair.code, input.locale),
      };
    }

    return { kind: "allow" };
  }

  async checkUserAuthorization(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    let accessState: Awaited<ReturnType<AccessStoreLike["load"]>>;
    try {
      accessState = await this.accessStore.load();
    } catch (error) {
      console.error(
        "Failed to load access state; denying access:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "deny", text: renderUnauthorizedMessage(input.locale) };
    }

    if (isAuthorizedGroupUser(accessState, input)) {
      return { kind: "allow" };
    }
    return { kind: "reply", text: renderUnauthorizedMessage(input.locale) };
  }

  async checkGroupJoin(input: BridgeGroupJoinInput): Promise<BridgeAccessDecision> {
    if (input.chatType === "private") {
      return { kind: "allow" };
    }

    const groupMode = await this.loadGroupMode();
    if (!groupMode.enabled) {
      return { kind: "reply", text: renderUnauthorizedMessage(input.locale) };
    }

    return this.checkUserAuthorization({
      chatId: input.chatId,
      userId: input.userId,
      chatType: input.chatType,
      locale: input.locale,
    });
  }

  private async loadGroupMode(): Promise<GroupModeConfig> {
    return this.options.loadGroupMode
      ? await this.options.loadGroupMode()
      : { enabled: true, allowedChatIds: [], listenAllChatIds: [] };
  }

  async handleAuthorizedMessage(input: BridgeAuthorizedMessageInput) {
    const turnStartedAt = Date.now();
    const decision = await this.checkAccess(input);
    if (decision.kind === "deny") {
      throw new Error(decision.text ?? renderUnauthorizedMessage(input.locale));
    }
    if (decision.kind === "reply") {
      return {
        text: decision.text ?? renderUnauthorizedMessage(input.locale),
      };
    }

    const sessionScope: BridgeConversationScope = {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      conversationKey: input.conversationKey,
    };
    // Keep session resolution, engine execution, and the eventual session bind in
    // one logical-conversation critical section. Otherwise a cron entry can resolve
    // the old session id while a chat turn is rebinding it, then run a second turn
    // against the stale id after the existing session lock is released.
    return await withBridgeTurnLock(
      bridgeConversationLockId(sessionScope),
      async () => await this.handleAuthorizedTurn(input, turnStartedAt, sessionScope),
      {
        waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs,
        onWait: input.onTurnLockWait,
      },
    );
  }

  private async handleAuthorizedTurn(
    input: BridgeAuthorizedMessageInput,
    turnStartedAt: number,
    sessionScope: BridgeConversationScope,
  ) {
    const useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const session = input.sessionIdOverride
      ? { sessionId: input.sessionIdOverride }
      : await this.sessionManager.getOrCreateSession(useConversationScope ? sessionScope : input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    const text = baseText;
    const turnEnvSupported = this.adapter.supportsTurnScopedEnv !== false;
    const disableRuntimeTimeout = input.disableRuntimeTimeout === true || shouldDisableRuntimeTimeout(input.text);
    let boundSessionIdFromEvent: string | undefined;
    const pendingSessionBinds = new Map<string, Promise<void>>();
    const bindEngineSession = async (sessionId: string): Promise<void> => {
      if (sessionId === boundSessionIdFromEvent) {
        return;
      }
      const existing = pendingSessionBinds.get(sessionId);
      if (existing) {
        await existing;
        return;
      }

      const bindPromise = this.sessionManager
        .bindSession(useConversationScope ? sessionScope : input.chatId, sessionId)
        .then(() => {
          boundSessionIdFromEvent = sessionId;
        })
        .finally(() => {
          pendingSessionBinds.delete(sessionId);
        });
      pendingSessionBinds.set(sessionId, bindPromise);
      await bindPromise;
    };
    const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
      if (
        event.type === "session" &&
        event.sessionId &&
        !input.sessionIdOverride &&
        event.sessionId !== session.sessionId
      ) {
        await bindEngineSession(event.sessionId);
      }
      await input.onEngineEvent?.(event);
    };
    try {
      const response = await withBridgeTurnLock(session.sessionId, async () => {
        const sendMessage = async () => {
          const adapterResponse = await this.adapter.sendUserMessage(session.sessionId, {
            text,
            files: input.files,
            instructions: input.instructions,
            onProgress: input.onProgress,
            onApprovalRequest: input.onApprovalRequest,
            onEngineEvent: handleEngineEvent,
            requestOutputDir: input.requestOutputDir,
            workspaceOverride: input.workspaceOverride,
            extraEnv: turnEnvSupported ? input.extraEnv : undefined,
            abortSignal: input.abortSignal,
            disableRuntimeTimeout: disableRuntimeTimeout || undefined,
          });

          if (
            !input.sessionIdOverride &&
            adapterResponse.sessionId &&
            adapterResponse.sessionId !== session.sessionId &&
            adapterResponse.sessionId !== boundSessionIdFromEvent
          ) {
            const pendingBind = pendingSessionBinds.get(adapterResponse.sessionId);
            if (pendingBind) {
              await pendingBind.catch(() => undefined);
            }
            if (adapterResponse.sessionId !== boundSessionIdFromEvent) {
              await this.sessionManager.bindSession(useConversationScope ? sessionScope : input.chatId, adapterResponse.sessionId);
            }
          }

          return adapterResponse;
        };

        if (this.options.turnPool) {
          return await this.options.turnPool.run(sendMessage, {
            signal: input.abortSignal,
            waitNotifyAfterMs: input.turnPoolWaitNotifyAfterMs,
            onWait: input.onTurnPoolWait,
            metadata: {
              ...this.options.turnPoolMetadata,
              conversationKey: input.conversationKey,
              sessionId: session.sessionId,
            },
          });
        }

        return await sendMessage();
      }, {
        waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs,
        onWait: input.onTurnLockWait,
      });

      await this.recordTurnTelemetry(response, turnStartedAt, {
        outcome: "success",
        chatType: input.chatType,
      });
      return response;
    } catch (error) {
      await this.recordTurnErrorTelemetry(error, turnStartedAt, {
        outcome: "error",
        phase: "turn",
        chatType: input.chatType,
      });
      throw error;
    }
  }

  private async recordTurnTelemetry(
    response: { usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } },
    startedAt: number,
    tags: TelemetryTags,
  ): Promise<void> {
    const telemetryTags = this.telemetryTags(tags);
    await this.recordMetric("run_e2e_ms", Math.max(0, Date.now() - startedAt), telemetryTags);
    if (!response.usage) {
      return;
    }
    await this.recordMetric("tokens_in", response.usage.inputTokens, telemetryTags);
    await this.recordMetric("tokens_out", response.usage.outputTokens, telemetryTags);
    if (typeof response.usage.cachedTokens === "number") {
      await this.recordMetric("tokens_cached", response.usage.cachedTokens, telemetryTags);
    }
    if (typeof response.usage.costUsd === "number") {
      await this.recordMetric("cost_usd", response.usage.costUsd, telemetryTags);
    }
  }

  private async recordTurnErrorTelemetry(error: unknown, startedAt: number, tags: TelemetryTags): Promise<void> {
    const telemetryTags = this.telemetryTags(tags);
    await this.recordMetric("run_e2e_ms", Math.max(0, Date.now() - startedAt), telemetryTags);
    await this.recordMetric("command_fail", 1, telemetryTags);
    await this.recordError(error, telemetryTags);
  }

  private telemetryTags(tags: TelemetryTags = {}): TelemetryTags {
    return {
      ...this.options.telemetryTags,
      ...tags,
    };
  }

  private async recordMetric(name: string, value: number, tags: TelemetryTags): Promise<void> {
    try {
      await this.options.telemetry?.recordMetric?.(name, value, tags);
    } catch {
      // Telemetry is best-effort and must never affect the bridge turn.
    }
  }

  private async recordError(error: unknown, tags: TelemetryTags): Promise<void> {
    try {
      await this.options.telemetry?.recordError?.(
        error instanceof Error ? error : new Error(String(error)),
        tags,
      );
    } catch {
      // Telemetry is best-effort and must never affect the bridge turn.
    }
  }

  private conversationScope(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
  }): BridgeConversationScope {
    return {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      conversationKey: input.conversationKey,
    };
  }

  /**
   * Inject a follow-up message into the chat's currently running engine turn
   * (Codex app-server turn/steer). Returns false when the runtime does not
   * support steering, the chat has no bound session, or no turn is active —
   * the caller then delivers the message through the normal turn queue.
   * Session resolution mirrors handleAuthorizedMessage so the steer targets
   * exactly the session a queued message would have used.
   */
  async steerActiveTurn(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    text: string;
  }): Promise<boolean> {
    if (!this.adapter.steerActiveTurn || !this.sessionManager.getExistingSession) {
      return false;
    }
    const useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const session = await this.sessionManager.getExistingSession(
      useConversationScope ? this.conversationScope(input) : input.chatId,
    );
    if (!session) {
      return false;
    }
    return await this.adapter.steerActiveTurn(session.sessionId, { text: input.text });
  }

  async getThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.getThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = this.sessionManager.getExistingSession
      ? await this.sessionManager.getExistingSession(scope)
      : await this.sessionManager.getOrCreateSession(scope);
    if (!session) {
      return { goal: null };
    }
    const response = await this.adapter.getThreadGoal(session.sessionId, {
      workspaceOverride: input.workspaceOverride,
    });
    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(scope, response.sessionId);
    }
    return { goal: response.goal };
  }

  async setThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.setThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = await this.sessionManager.getOrCreateSession(scope);
    const response = await this.adapter.setThreadGoal(session.sessionId, {
      objective: input.objective,
      tokenBudget: input.tokenBudget,
      workspaceOverride: input.workspaceOverride,
    });
    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(scope, response.sessionId);
    }
    return { goal: response.goal };
  }

  async watchThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.watchThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = await this.sessionManager.getOrCreateSession(scope);
    const response = await this.adapter.watchThreadGoal(session.sessionId, {
      objective: input.objective,
      tokenBudget: input.tokenBudget,
      workspaceOverride: input.workspaceOverride,
      onEngineEvent: input.onEngineEvent,
      abortSignal: input.abortSignal,
    });
    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(scope, response.sessionId);
    }
    return { goal: response.goal };
  }

  async clearThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ cleared: boolean }> {
    if (!this.adapter.clearThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = this.sessionManager.getExistingSession
      ? await this.sessionManager.getExistingSession(scope)
      : await this.sessionManager.getOrCreateSession(scope);
    if (!session) {
      return { cleared: false };
    }
    const response = await this.adapter.clearThreadGoal(session.sessionId, {
      workspaceOverride: input.workspaceOverride,
    });
    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(scope, response.sessionId);
    }
    return { cleared: response.cleared };
  }
}
