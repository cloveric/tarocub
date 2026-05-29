import type {
  CodexAdapter,
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
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

export interface BridgeGroupJoinInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
}

export interface BridgeAccessDecision {
  kind: "allow" | "reply" | "deny";
  text?: string;
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

function isAuthorizedGroupUser(
  accessState: Awaited<ReturnType<AccessStoreLike["load"]>>,
  input: BridgeAccessInput,
): boolean {
  if (accessState.policy === "allowlist") {
    return accessState.allowlist.includes(input.userId);
  }
  return accessState.pairedUsers.some((user) => user.telegramUserId === input.userId);
}

function isAllowedGroupChat(groupMode: GroupModeConfig, input: BridgeAccessInput): boolean {
  return [input.chatId, input.conversationChatId]
    .filter((chatId): chatId is number => Number.isInteger(chatId))
    .some((chatId) => groupMode.allowedChatIds.includes(chatId));
}

export class Bridge {
  readonly supportsTurnScopedEnv: boolean;

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
    private readonly options: {
      loadGroupMode?: () => Promise<GroupModeConfig>;
    } = {},
  ) {
    this.supportsTurnScopedEnv = adapter.supportsTurnScopedEnv !== false;
  }

  async validateCodexThread(threadId: string): Promise<void> {
    if (!this.adapter.validateExternalSession) {
      throw new Error("codex thread validation unsupported");
    }

    await this.adapter.validateExternalSession(threadId);
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
      };
    }

    if (
      accessState.policy === "pairing" &&
      !accessState.pairedUsers.some(
        (user) => user.telegramChatId === input.chatId && user.telegramUserId === input.userId,
      )
    ) {
      if (conflictingChatId !== null) {
        return {
          kind: "reply",
          text: renderSingleChatLockedMessage(input.locale),
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

  async handleAuthorizedMessage(input: {
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
    sessionIdOverride?: string;
    turnLockWaitNotifyAfterMs?: number;
    onTurnLockWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
  }) {
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
    const useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const session = input.sessionIdOverride
      ? { sessionId: input.sessionIdOverride }
      : await this.sessionManager.getOrCreateSession(useConversationScope ? sessionScope : input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    const text = baseText;
    const turnEnvSupported = this.adapter.supportsTurnScopedEnv !== false;
    const disableRuntimeTimeout = shouldDisableRuntimeTimeout(input.text);
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
    const response = await withBridgeTurnLock(session.sessionId, async () => {
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
    }, {
      waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs,
      onWait: input.onTurnLockWait,
    });

    return response;
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
