import type { CodexAdapter, EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import { findConflictingLockedChatId } from "../state/access-store.js";
import {
  type Locale,
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderSingleChatLockedMessage,
  renderUnauthorizedMessage,
} from "../telegram/message-renderer.js";

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
  getOrCreateSession(chatId: number): Promise<{ sessionId: string }>;
  bindSession(chatId: number, sessionId: string): Promise<void>;
}

export interface BridgeAccessInput {
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

export class Bridge {
  readonly supportsTurnScopedEnv: boolean;

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
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
      return {
        kind: "reply",
        text: renderPrivateChatRequiredMessage(input.locale),
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

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    locale?: Locale;
    text: string;
    replyContext?: {
      messageId: number;
      text: string;
    };
    files: string[];
    onProgress?: (partialText: string) => void;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    sideChannelCommand?: string;
    extraEnv?: Record<string, string>;
    abortSignal?: AbortSignal;
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

    const session = await this.sessionManager.getOrCreateSession(input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    const text = baseText;
    const turnEnvSupported = this.adapter.supportsTurnScopedEnv !== false;
    const disableRuntimeTimeout = shouldDisableRuntimeTimeout(input.text);
    const response = await this.adapter.sendUserMessage(session.sessionId, {
      text,
      files: input.files,
      instructions: undefined,
      onProgress: input.onProgress,
      onApprovalRequest: input.onApprovalRequest,
      onEngineEvent: input.onEngineEvent,
      requestOutputDir: input.requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      extraEnv: turnEnvSupported ? input.extraEnv : undefined,
      abortSignal: input.abortSignal,
      disableRuntimeTimeout: disableRuntimeTimeout || undefined,
    });

    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(input.chatId, response.sessionId);
    }

    return response;
  }
}
